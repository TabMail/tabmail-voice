// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "channel.h"
#include "foreground.h"
#include "input_session.h"

namespace voice {
// One bounded transaction at a time. Clipboard v1 has no compare-and-set: an
// observed foreign owner vetoes restoration, but the final owner check and the
// compositor mutation cannot be atomic. Never retry an uncertain paste.
class Inserter {
    // How long the app holding the clipboard gets to hand over its contents
    // before the paste goes ahead without putting them back (owner, 2026-10-04).
    static constexpr unsigned snapshotMilliseconds = 500;
    struct Transaction {
        int64_t id;
        uint64_t target, snapshotEpoch;
        unsigned restoreDelay;
        std::chrono::steady_clock::time_point deadline;
        std::string text;
        Channel::Reply reply;
        Object<GCancellable> cancel = own(g_cancellable_new()), reading = own(g_cancellable_new());
        InputSession::Offer saved;
        std::vector<std::string> formats;
        std::vector<int> chordKeys, pressedKeys;
        bool terminal = false;
        size_t next = 0, bytes = 0;
        guint timer = 0, snapshotTimer = 0;
        bool restorable = true, canceled = false, published = false, publishComplete = false, sawOwner = false,
            foreignOwner = false, injectionStarted = false,
            successful = false, cleaning = false;
    };
    InputSession& input;
    std::function<bool(uint64_t)> targetMatches;
    std::function<bool()> terminalTarget;
    std::shared_ptr<Transaction> current;
    bool active(const std::shared_ptr<Transaction>& item) const { return current == item; }
    bool valid(const std::shared_ptr<Transaction>& item) const {
        if (!active(item) || item->canceled || !input.ready() || std::chrono::steady_clock::now() >= item->deadline) return false;
        try { return targetMatches(item->target) && terminalTarget() == item->terminal; } catch (...) { return false; }
    }
    // Own a reference: synchronous cancellation may pass `current` itself.
    // Clearing current must not clear the transaction before its reply.
    void complete(std::shared_ptr<Transaction> item) {
        if (!active(item)) return;
        if (item->timer && g_main_context_find_source_by_id(nullptr, item->timer)) g_source_remove(item->timer);
        item->timer = 0;
        if (item->snapshotTimer && g_main_context_find_source_by_id(nullptr, item->snapshotTimer)) g_source_remove(item->snapshotTimer);
        item->snapshotTimer = 0;
        g_cancellable_cancel(item->cancel.get()); g_cancellable_cancel(item->reading.get());
        current.reset(); item->reply(nlohmann::json::object(), item->successful && !item->canceled);
    }
    void restore(const std::shared_ptr<Transaction>& item) {
        if (!active(item)) return;
        if (!item->published || !item->restorable || item->foreignOwner || !input.ready() || !input.state->selection.ours) { complete(item); return; }
        // Cleanup has its own bounded lifetime; cancellation of the insertion
        // must not cancel restoration or leave an injected modifier pressed.
        input.state->publish(item->saved, nullptr, [this, item](bool success) {
            item->successful = item->successful && success; complete(item);
        });
    }
    void release(const std::shared_ptr<Transaction>& item) {
        if (!active(item)) return;
        if (item->pressedKeys.empty() || !input.ready()) { restore(item); return; }
        const int key = item->pressedKeys.back(); item->pressedKeys.pop_back();
        input.state->key(key, false, nullptr, [this, item](bool) { release(item); });
    }
    void clean(const std::shared_ptr<Transaction>& item) {
        if (!active(item) || item->cleaning) return;
        item->cleaning = true;
        release(item);
    }
    void chord(const std::shared_ptr<Transaction>& item, unsigned step = 0) {
        if (!active(item)) return;
        const auto count = item->chordKeys.size();
        if (step < count && !valid(item)) { clean(item); return; }
        if (step == count * 2) {
            item->successful = true;
            if (item->timer && g_main_context_find_source_by_id(nullptr, item->timer)) g_source_remove(item->timer);
            item->timer = 0;
            if (item->canceled) { clean(item); return; }
            struct Delay { Inserter* self; std::shared_ptr<Transaction> item; };
            item->timer = g_timeout_add_full(G_PRIORITY_DEFAULT, item->restoreDelay,
                [](gpointer data) -> gboolean {
                    auto delay = static_cast<Delay*>(data); delay->item->timer = 0;
                    delay->self->clean(delay->item); return G_SOURCE_REMOVE;
                }, new Delay{this, item}, [](gpointer data) { delete static_cast<Delay*>(data); });
            return;
        }
        // Submission, not the reply, is the irreversible boundary. Even a failed
        // reply can mean the compositor already received this key-down.
        const bool down = step < count;
        const int key = item->chordKeys[down ? step : count * 2 - step - 1];
        if (down) item->pressedKeys.push_back(key);
        input.state->key(key, down, nullptr, [this, item, step, down](bool success) {
            if (!success) { clean(item); return; }
            if (!down) item->pressedKeys.pop_back();
            chord(item, step + 1);
        });
    }
    void maybeInject(const std::shared_ptr<Transaction>& item) {
        if (!active(item) || !item->publishComplete || !item->sawOwner || item->injectionStarted) return;
        if (!valid(item) || item->foreignOwner || !input.state->selection.ours) { clean(item); return; }
        item->injectionStarted = true; chord(item);
    }
    void snapshot(const std::shared_ptr<Transaction>& item) {
        if (!valid(item) || input.state->selection.epoch != item->snapshotEpoch) { complete(item); return; }
        if (item->next == item->formats.size()) {
            auto bytes = std::make_shared<const std::vector<unsigned char>>(item->text.begin(), item->text.end());
            InputSession::Offer temporary{{"text/plain;charset=utf-8", bytes}, {"text/plain", bytes}, {"UTF8_STRING", bytes}};
            item->published = true;
            // Keep this call independent of the transaction cancellable. A
            // submitted SetSelection may still commit after cancellation;
            // observe its completion before scheduling restoration.
            input.state->publish(std::move(temporary), nullptr, [this, item](bool success) {
                if (!active(item)) return;
                item->publishComplete = true;
                if (!success || !valid(item)) { clean(item); return; }
                maybeInject(item);
            });
            return;
        }
        const auto mime = item->formats[item->next++];
        input.state->read(mime, item->reading.get(), [this, item, mime](InputSession::Bytes bytes) {
            if (!active(item)) return;
            if (!bytes || bytes->size() > 64 * 1024 * 1024 - item->bytes) {
                // A clipboard that can't be saved isn't put back; the paste still happens.
                std::cerr << "debug insertion: clipboard not saved, pasting without restoring it\n";
                item->restorable = false; item->saved.clear(); item->next = item->formats.size();
                snapshot(item); return;
            }
            item->bytes += bytes->size(); item->saved[mime] = bytes; snapshot(item);
        });
    }
public:
    Inserter(InputSession& input, std::function<bool(uint64_t)> targetMatches,
             std::function<bool()> terminalTarget = [] { return false; })
        : input(input), targetMatches(std::move(targetMatches)), terminalTarget(std::move(terminalTarget)) {
        input.state->onOwnerChange = [this] {
            if (!current || !current->published) return;
            if (this->input.state->selection.ours) current->sawOwner = true;
            else current->foreignOwner = true; // Irrevocable, even if ownership later returns.
            maybeInject(current);
        };
    }
    ~Inserter() { input.state->onOwnerChange = {}; }
    void cancel(int64_t id) {
        if (!current || current->id != id) return;
        current->canceled = true; g_cancellable_cancel(current->cancel.get()); g_cancellable_cancel(current->reading.get());
        // In-flight key calls perform their own release chain on completion.
        if (!current->injectionStarted && (!current->published || current->publishComplete)) clean(current);
    }
    void insert(int64_t id, const nlohmann::json& params, Channel::Reply reply) {
        if (current || !input.ready() || !params.is_object() ||
            !params.contains("text") || !params["text"].is_string() ||
            !params.contains("window") || !params["window"].is_number_unsigned() ||
            !params.contains("deadline") || !params["deadline"].is_number_integer() ||
            !params.contains("restoreDelay") || !params["restoreDelay"].is_number_unsigned()) throw std::runtime_error("invalid insertion");
        auto item = std::make_shared<Transaction>();
        item->id = id; item->target = params["window"].get<uint64_t>(); item->restoreDelay = params["restoreDelay"].get<unsigned>();
        item->text = params["text"].get<std::string>(); item->reply = std::move(reply);
        const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        const auto wallDeadline = params["deadline"].get<int64_t>();
        if (!item->target || item->target > 9007199254740991ULL || item->restoreDelay > 10000 || params["restoreDelay"] != item->restoreDelay ||
            item->text.empty() || item->text.size() > 1024 * 1024 || item->text.find('\0') != std::string::npos ||
            !g_utf8_validate(item->text.data(), item->text.size(), nullptr) || wallDeadline <= now || wallDeadline > now + 3000) throw std::runtime_error("invalid insertion");
        if (!input.state->selection.known) {
            // No side effect has occurred. The caller keeps the text in history
            // and can explain why automatic paste was unavailable.
            item->reply({{"status", "clipboard-unavailable"}}, true);
            return;
        }
        item->terminal = terminalTarget();
        // GNOME terminals reserve Ctrl+V for terminal input; their clipboard
        // shortcut is Ctrl+Shift+V. Use the provider's semantic terminal role.
        item->chordKeys = item->terminal ? std::vector<int>{0xffe3, 0xffe1, 'v'} : std::vector<int>{0xffe3, 'v'};
        item->deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(wallDeadline - now);
        item->snapshotEpoch = input.state->selection.epoch; item->formats = input.state->selection.formats;
        for (const auto& mime : item->formats) if (mime == "application/vnd.portal.filetransfer") throw std::runtime_error("unsupported clipboard capability");
        current = item;
        struct Deadline { Inserter* self; int64_t id; };
        item->timer = g_timeout_add_full(G_PRIORITY_DEFAULT, wallDeadline - now,
            [](gpointer data) -> gboolean {
                auto deadline = static_cast<Deadline*>(data);
                if (deadline->self->current) deadline->self->current->timer = 0;
                deadline->self->cancel(deadline->id); return G_SOURCE_REMOVE;
            }, new Deadline{this, id}, [](gpointer data) { delete static_cast<Deadline*>(data); });
        struct Snapshot { std::shared_ptr<Transaction> item; };
        item->snapshotTimer = g_timeout_add_full(G_PRIORITY_DEFAULT, snapshotMilliseconds,
            [](gpointer data) -> gboolean {
                const auto& item = static_cast<Snapshot*>(data)->item;
                item->snapshotTimer = 0; g_cancellable_cancel(item->reading.get()); return G_SOURCE_REMOVE;
            }, new Snapshot{item}, [](gpointer data) { delete static_cast<Snapshot*>(data); });
        snapshot(item);
    }
};
}
