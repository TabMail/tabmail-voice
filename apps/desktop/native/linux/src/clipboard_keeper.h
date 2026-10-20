// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "input_session.h"
#include <chrono>
#include <iostream>
#include <optional>

namespace voice {
// The clipboard as it was before a paste, put back after it (ADR-DESK-002, amended 2026-10-08),
// as the Mac's ClipboardKeeper does.
//
// The paste never reads the clipboard: reading it asks its owner for every format's data, which a
// busy app hands over late. It is saved ahead, while the user speaks (`save`, which the app asks for
// from key-down until the paste, every `clipboardSaveInterval`), by asynchronous portal reads on the event loop. The
// clipboard goes back `restoreDelay` after an app reads the paste's text (a transfer of its offer),
// or `readWait` after the paste when no app has read it by then: a busy app handles the keys late,
// and one that read the clipboard as it was would paste that (amended 2026-10-20). It goes back only
// while this session still owns the
// selection it offered the paste's text in (`ours`, its announcement) and the save was of the
// selection just before the paste: a copy made in between is never overwritten, and a paste without
// such a save leaves its text. A password manager's clipboard and a file transfer are not saved,
// and not put back. The selection is unknown until the portal first announces it (GNOME is silent
// at session start): until then nothing is saved.
class ClipboardKeeper {
public:
    // What a saved clipboard may hold, and when it goes back, from the shared core.
    struct Rules {
        unsigned readWait = 0;
        unsigned restoreDelay = 0;
        unsigned long long maxBytes = 0;
        size_t maxFormats = 0;
    };
    ClipboardKeeper(InputSession& input, Rules rules) : input(input), rules(rules) {
        input.state->onTransferred = [this](uint64_t request) { transferred(request); };
    }
    ~ClipboardKeeper() {
        input.state->onTransferred = {};
        endWait();
    }
    // Saves the clipboard in the background, unless it is saved, or being saved, as it is now.
    void save() {
        const auto& selection = input.state->selection;
        if (!input.ready() || !selection.known) { log("clipboard not known yet; not saved"); return; }
        if ((saved && saved->epoch == selection.epoch) || (saving && saving->epoch == selection.epoch)) {
            log("clipboard unchanged since it was saved");
            return;
        }
        endSave();
        if (selection.ours) {
            // This session's own offer: a clipboard put back is kept as it is; the paste's text is not.
            if (restored.empty() || input.state->offer != restored) { log("the clipboard holds the paste's text; not saved"); return; }
            saved = Saved{selection.epoch, restored};
            log("clipboard saved after 0ms");
            return;
        }
        const auto& formats = selection.formats;
        const bool withheld = std::any_of(formats.begin(), formats.end(), [](const std::string& format) {
            return format == concealedFormat || format == fileTransferFormat;
        });
        if (withheld || formats.size() > rules.maxFormats) {
            saved = Saved{selection.epoch, std::nullopt};
            log("clipboard not to be saved after 0ms");
            return;
        }
        saving = std::make_shared<Save>();
        saving->epoch = selection.epoch;
        saving->formats = formats;
        next(saving);
    }
    // A paste is about to offer its text: a save under way read a clipboard it replaces, and a
    // put-back still waiting must not replace the paste's text.
    void begin() {
        if (saving) log("the clipboard's save still under way; it won't be put back");
        endSave();
        endWait();
        pasted.reset();
        ++restoreGeneration;
    }
    // The paste offered its text over the selection as it was at `before`, and this session owns
    // the selection at `ours`: the saved clipboard now holds while the text is there.
    void wrote(uint64_t before, uint64_t ours) {
        pasted = Pasted{ours};
        if (saved && saved->epoch == before) saved->epoch = ours;
        else { log("no save of the clipboard as it was; it won't be put back"); saved.reset(); }
    }
    // Puts the saved clipboard back `restoreDelay` after an app reads the paste's text, or once
    // `readWait` from now passes with no app having read it (at once for a paste whose keys were
    // never sent, or whose text was never offered), if this session still owns the selection it
    // offered the paste's text in (`ours`).
    void restore(uint64_t ours, bool keysSent) {
        const auto started = std::chrono::steady_clock::now();
        if (!keysSent || !pasted || pasted->epoch != ours || pasted->read) { later(ours, started); return; }
        endWait();
        waiting = Waiting{ours, started, g_timeout_add(rules.readWait, [](gpointer data) -> gboolean {
            auto self = static_cast<ClipboardKeeper*>(data);
            const auto waited = *self->waiting;
            self->waiting.reset();
            log("no app read the paste's text in " + std::to_string(self->rules.readWait) + "ms");
            self->later(waited.ours, waited.started);
            return G_SOURCE_REMOVE;
        }, this)};
    }
    // The compositor has answered the paste's first key (a failed answer may still mean it took the
    // key). A transfer asked for before this is not the target's read: GNOME's clipboard manager, and
    // its X bridge, read every new selection as it is set, before any key; the target reads only
    // once it has the keys, and the compositor answers a key before the target sees it.
    void keysReached() {
        if (pasted && !pasted->keysAt) pasted->keysAt = input.state->transferRequests;
    }
private:
    // Marks a password manager's copy, which its manager clears; KDE's, which GNOME apps carry too.
    static constexpr const char* concealedFormat = "x-kde-passwordManagerHint";
    // A sandboxed app's file transfer, whose files the portal hands out only to the pasting app.
    static constexpr const char* fileTransferFormat = "application/vnd.portal.filetransfer";
    // The user's clipboard as saved (no offer for one not to be saved), and the selection it holds
    // for: the one it was read from, then the one a paste offered its text in over it.
    struct Saved { uint64_t epoch = 0; std::optional<InputSession::Offer> offer; };
    struct Save {
        uint64_t epoch = 0;
        Object<GCancellable> cancel = own(g_cancellable_new());
        std::vector<std::string> formats;
        size_t next = 0;
        unsigned long long bytes = 0;
        InputSession::Offer offer;
        std::chrono::steady_clock::time_point started = std::chrono::steady_clock::now();
    };
    static void log(const std::string& message) { std::cerr << "debug clipboard keeper: " + message + "\n"; }
    static long long milliseconds(std::chrono::steady_clock::time_point started) {
        return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    }
    void endSave() {
        if (saving) g_cancellable_cancel(saving->cancel.get());
        saving.reset();
    }
    void endWait() {
        if (waiting) g_source_remove(waiting->timer);
        waiting.reset();
    }
    // An app read this session's offer: when it is the paste's text, the put-back waiting for that
    // read goes ahead.
    void transferred(uint64_t request) {
        const auto& selection = input.state->selection;
        if (!pasted || pasted->read || !pasted->keysAt || request <= *pasted->keysAt || !selection.ours || selection.epoch != pasted->epoch) return;
        pasted->read = true;
        if (!waiting || waiting->ours != pasted->epoch) return;
        const auto waited = *waiting;
        endWait();
        log("the paste's text read after " + std::to_string(milliseconds(waited.started)) + "ms");
        later(waited.ours, waited.started);
    }
    // Puts the saved clipboard back `restoreDelay` from now, unless another paste begins first.
    void later(uint64_t ours, std::chrono::steady_clock::time_point started) {
        struct Delay { ClipboardKeeper* self; uint64_t ours, generation; std::chrono::steady_clock::time_point started; };
        g_timeout_add_full(G_PRIORITY_DEFAULT, rules.restoreDelay, [](gpointer data) -> gboolean {
            const auto delay = static_cast<Delay*>(data);
            if (delay->generation == delay->self->restoreGeneration) delay->self->putBack(delay->ours, delay->started);
            return G_SOURCE_REMOVE;
        }, new Delay{this, ours, restoreGeneration, started}, [](gpointer data) { delete static_cast<Delay*>(data); });
    }
    // Reads the save's next format, or keeps the save once every one is read. Its own reference:
    // `saving` is reset on the way.
    void next(std::shared_ptr<Save> save) {
        if (saving != save) return;
        if (!input.ready() || input.state->selection.epoch != save->epoch) {
            log("clipboard changed while it was saved; not kept");
            saving.reset();
            return;
        }
        if (save->next == save->formats.size()) {
            saved = Saved{save->epoch, std::move(save->offer)};
            saving.reset();
            log("clipboard saved after " + std::to_string(milliseconds(save->started)) + "ms");
            return;
        }
        const auto mime = save->formats[save->next++];
        input.state->read(mime, rules.maxBytes - save->bytes, save->cancel.get(), [this, save, mime](InputSession::Bytes bytes) {
            if (saving != save) return;
            if (!bytes) { log("clipboard couldn't be saved"); saving.reset(); return; }
            save->bytes += bytes->size();
            save->offer[mime] = bytes;
            next(save);
        });
    }
    void putBack(uint64_t ours, std::chrono::steady_clock::time_point started) {
        const auto& selection = input.state->selection;
        if (!input.ready() || selection.epoch != ours || !selection.ours) { log("clipboard changed since the paste; not put back"); return; }
        if (!saved || saved->epoch != ours || !saved->offer) { log("nothing saved to put back; the paste's text stays"); return; }
        // Kept: once this session owns the selection with it, the next save takes it as it is.
        restored = std::move(*saved->offer);
        saved.reset();
        input.state->publish(restored, nullptr, [started](bool success) {
            log(success ? "clipboard put back after " + std::to_string(milliseconds(started)) + "ms" : "clipboard couldn't be put back");
        });
    }
    InputSession& input;
    const Rules rules;
    std::optional<Saved> saved;
    std::shared_ptr<Save> saving;
    // The clipboard the last put-back offered.
    InputSession::Offer restored;
    // The latest paste's text as offered: the selection it was offered in, whether the target has
    // read it, and the transfers asked for by the time the compositor answered its first key.
    struct Pasted { uint64_t epoch = 0; bool read = false; std::optional<uint64_t> keysAt = std::nullopt; };
    std::optional<Pasted> pasted;
    // A put-back waiting for an app to read the paste's text: its paste, since when, and its timer.
    struct Waiting { uint64_t ours = 0; std::chrono::steady_clock::time_point started; guint timer = 0; };
    std::optional<Waiting> waiting;
    // Counts the pastes begun: a put-back scheduled before the latest one is dropped.
    uint64_t restoreGeneration = 0;
};
}
