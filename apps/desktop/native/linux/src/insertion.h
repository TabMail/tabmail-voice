// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "channel.h"
#include "foreground.h"
#include "input_session.h"

namespace voice {
// One bounded transaction at a time. The clipboard is written, never read: the
// text is offered, pasted once this session owns the selection, and left there
// (ADR-DESK-002). Clipboard v1 has no compare-and-set: an observed foreign owner
// vetoes the paste, but the final owner check and the compositor mutation cannot
// be atomic. Never retry an uncertain paste.
class Inserter {
    struct Transaction {
        int64_t id;
        uint64_t target;
        std::chrono::steady_clock::time_point deadline;
        std::string text;
        Channel::Reply reply;
        Object<GCancellable> cancel = own(g_cancellable_new());
        std::vector<int> chordKeys, pressedKeys;
        bool terminal = false;
        guint timer = 0;
        std::chrono::steady_clock::time_point started = std::chrono::steady_clock::now();
        bool canceled = false, published = false, publishComplete = false, sawOwner = false,
            foreignOwner = false, injectionStarted = false,
            successful = false, cleaning = false;
    };
    InputSession& input;
    std::function<bool(uint64_t)> targetMatches;
    std::function<bool()> terminalTarget;
    std::shared_ptr<Transaction> current;
    bool active(const std::shared_ptr<Transaction>& item) const { return current == item; }
    // Debug log of the paste's progress: the stage and the milliseconds since the request.
    static void stage(const std::shared_ptr<Transaction>& item, const char* name) {
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - item->started).count();
        std::cerr << "debug paste stage: " << name << " after " << ms << "ms\n";
    }
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
        g_cancellable_cancel(item->cancel.get());
        stage(item, item->successful && !item->canceled ? "complete" : "not pasted");
        current.reset(); item->reply(nlohmann::json::object(), item->successful && !item->canceled);
    }
    void release(const std::shared_ptr<Transaction>& item) {
        if (!active(item)) return;
        if (item->pressedKeys.empty() || !input.ready()) { complete(item); return; }
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
            clean(item);
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
        item->injectionStarted = true; stage(item, "send-keys"); chord(item);
    }
    void publish(const std::shared_ptr<Transaction>& item) {
        if (!valid(item)) { complete(item); return; }
        auto bytes = std::make_shared<const std::vector<unsigned char>>(item->text.begin(), item->text.end());
        InputSession::Offer offer{{"text/plain;charset=utf-8", bytes}, {"text/plain", bytes}, {"UTF8_STRING", bytes}};
        item->published = true;
        stage(item, "clipboard-write");
        // Keep this call independent of the transaction cancellable. A
        // submitted SetSelection may still commit after cancellation;
        // observe its completion before ending the transaction.
        input.state->publish(std::move(offer), nullptr, [this, item](bool success) {
            if (!active(item)) return;
            item->publishComplete = true;
            stage(item, "clipboard-written");
            if (!success || !valid(item)) { clean(item); return; }
            maybeInject(item);
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
        current->canceled = true; g_cancellable_cancel(current->cancel.get());
        // In-flight key calls perform their own release chain on completion.
        if (!current->injectionStarted && (!current->published || current->publishComplete)) clean(current);
    }
    void insert(int64_t id, const nlohmann::json& params, Channel::Reply reply) {
        if (current || !input.ready() || !params.is_object() ||
            !params.contains("text") || !params["text"].is_string() ||
            !params.contains("window") || !params["window"].is_number_unsigned() ||
            !params.contains("deadline") || !params["deadline"].is_number_integer()) throw std::runtime_error("invalid insertion");
        auto item = std::make_shared<Transaction>();
        item->id = id; item->target = params["window"].get<uint64_t>();
        item->text = params["text"].get<std::string>(); item->reply = std::move(reply);
        const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        const auto wallDeadline = params["deadline"].get<int64_t>();
        if (!item->target || item->target > 9007199254740991ULL ||
            item->text.empty() || item->text.size() > 1024 * 1024 || item->text.find('\0') != std::string::npos ||
            !g_utf8_validate(item->text.data(), item->text.size(), nullptr) || wallDeadline <= now || wallDeadline > now + 3000) throw std::runtime_error("invalid insertion");
        item->terminal = terminalTarget();
        // GNOME terminals reserve Ctrl+V for terminal input; their clipboard
        // shortcut is Ctrl+Shift+V. Use the provider's semantic terminal role.
        item->chordKeys = item->terminal ? std::vector<int>{0xffe3, 0xffe1, 'v'} : std::vector<int>{0xffe3, 'v'};
        item->deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(wallDeadline - now);
        current = item;
        struct Deadline { Inserter* self; int64_t id; };
        item->timer = g_timeout_add_full(G_PRIORITY_DEFAULT, wallDeadline - now,
            [](gpointer data) -> gboolean {
                auto deadline = static_cast<Deadline*>(data);
                if (deadline->self->current) deadline->self->current->timer = 0;
                deadline->self->cancel(deadline->id); return G_SOURCE_REMOVE;
            }, new Deadline{this, id}, [](gpointer data) { delete static_cast<Deadline*>(data); });
        publish(item);
    }
};
}
