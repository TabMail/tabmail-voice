// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "helper_config.h"
#include <windows.h>
#include <ole2.h>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace voice {
// Clipboard ownership sends synchronous window messages. Pump them while waiting for another
// program to close the clipboard.
inline void clipboardWait(unsigned milliseconds) {
    const auto end = GetTickCount64() + milliseconds;
    do {
        MSG message{};
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message); DispatchMessageW(&message);
        }
        const auto now = GetTickCount64();
        if (now >= end) break;
        MsgWaitForMultipleObjects(0, nullptr, FALSE, static_cast<DWORD>(end - now), QS_ALLINPUT);
    } while (true);
}
inline HGLOBAL memoryCopy(const void* bytes, SIZE_T size) {
    HGLOBAL copy = GlobalAlloc(GMEM_MOVEABLE, size);
    if (!copy) throw std::runtime_error("clipboard allocation failed");
    void* target = GlobalLock(copy);
    if (!target) { GlobalFree(copy); throw std::runtime_error("clipboard lock failed"); }
    memcpy(target, bytes, size);
    GlobalUnlock(copy);
    return copy;
}
class ClipboardItem {
public:
    ClipboardItem(UINT format, HANDLE value) : format(format), value(value) {}
    ClipboardItem(const ClipboardItem&) = delete;
    ClipboardItem& operator=(const ClipboardItem&) = delete;
    ClipboardItem(ClipboardItem&& other) noexcept : format(other.format), value(std::exchange(other.value, nullptr)) {}
    ~ClipboardItem() {
        if (!value) return;
        if (format == CF_BITMAP || format == CF_DSPBITMAP || format == CF_PALETTE) DeleteObject(value);
        else if (format == CF_ENHMETAFILE || format == CF_DSPENHMETAFILE) DeleteEnhMetaFile(static_cast<HENHMETAFILE>(value));
        else {
            if (format == CF_METAFILEPICT || format == CF_DSPMETAFILEPICT) {
                const auto picture = static_cast<METAFILEPICT*>(GlobalLock(value));
                if (picture) { DeleteMetaFile(picture->hMF); GlobalUnlock(value); }
            }
            GlobalFree(value);
        }
    }
    void publish() {
        if (!SetClipboardData(format, value)) throw std::runtime_error("clipboard publish failed");
        value = nullptr; // Windows owns it from here.
    }
private:
    UINT format;
    HANDLE value;
};
// What a saved clipboard may hold, and when it goes back, from the shared core.
struct ClipboardRules {
    unsigned restoreDelay = 0;
    unsigned long long maxBytes = 0;
    size_t maxFormats = 0;
};
// The clipboard a paste writes, and the clipboard as it was, read and put back. Each use opens it
// with an owner window of its own, on its own thread.
class Clipboard {
public:
    Clipboard() {
        window = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, GetModuleHandleW(nullptr), nullptr);
        if (!window) throw std::runtime_error("clipboard owner failed");
    }
    ~Clipboard() { close(); DestroyWindow(window); }
    void open(unsigned long long waitMs = HelperConfig::clipboardOpenWaitMs) {
        const auto end = GetTickCount64() + waitMs;
        while (!OpenClipboard(window)) {
            if (GetTickCount64() >= end) throw std::runtime_error("clipboard busy");
            clipboardWait(5);
        }
        opened = true;
    }
    void close() { if (opened) { CloseClipboard(); opened = false; } }
    // Writes `text` over the open clipboard, kept out of clipboard monitors, history and the cloud.
    void putText(const std::wstring& text) {
        // All allocation and format registration precedes EmptyClipboard.
        ClipboardItem content(CF_UNICODETEXT, memoryCopy(text.c_str(), (text.size() + 1) * sizeof(wchar_t)));
        DWORD zero = 0;
        const UINT excluded = RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing");
        const UINT history = RegisterClipboardFormatW(L"CanIncludeInClipboardHistory");
        const UINT cloud = RegisterClipboardFormatW(L"CanUploadToCloudClipboard");
        if (!excluded || !history || !cloud) throw std::runtime_error("clipboard privacy format failed");
        ClipboardItem excludeItem(excluded, memoryCopy(&zero, sizeof(zero)));
        ClipboardItem historyItem(history, memoryCopy(&zero, sizeof(zero)));
        ClipboardItem cloudItem(cloud, memoryCopy(&zero, sizeof(zero)));
        if (!EmptyClipboard()) throw std::runtime_error("clipboard empty failed");
        excludeItem.publish(); historyItem.publish(); cloudItem.publish(); content.publish();
    }
    // Every format of the open clipboard, copied; nullopt for a clipboard not to be saved: a password
    // manager's (marked to be left out of clipboard monitors, told by its formats before any data is
    // asked for), one holding owner-display or application-private handles, which have no general
    // copying contract, or one with more formats or data than `rules` allow.
    std::optional<std::vector<ClipboardItem>> read(const ClipboardRules& rules) {
        const UINT excluded = RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing");
        if (!excluded) throw std::runtime_error("clipboard privacy format failed");
        std::vector<UINT> formats;
        for (UINT format = 0;;) {
            SetLastError(ERROR_SUCCESS);
            format = EnumClipboardFormats(format);
            if (!format) {
                if (GetLastError() != ERROR_SUCCESS) throw std::runtime_error("clipboard enumeration failed");
                break;
            }
            if (format == excluded || format == CF_OWNERDISPLAY || (format >= CF_PRIVATEFIRST && format <= CF_GDIOBJLAST)) return std::nullopt;
            formats.push_back(format);
        }
        if (formats.size() > rules.maxFormats) return std::nullopt;
        std::vector<ClipboardItem> items;
        unsigned long long bytes = 0;
        for (const UINT format : formats) {
            HANDLE source = GetClipboardData(format);
            if (!source) throw std::runtime_error("clipboard format unavailable");
            const UINT base = format == CF_DSPBITMAP ? CF_BITMAP : format == CF_DSPMETAFILEPICT ? CF_METAFILEPICT : format;
            HANDLE copy = nullptr;
            if (format == CF_ENHMETAFILE || format == CF_DSPENHMETAFILE) {
                copy = CopyEnhMetaFileW(static_cast<HENHMETAFILE>(source), nullptr);
            } else {
                const bool gdi = base == CF_BITMAP || base == CF_PALETTE || base == CF_METAFILEPICT;
                const unsigned long long size = gdi ? 0 : GlobalSize(source);
                if (!gdi && (!size || size > rules.maxBytes || bytes > rules.maxBytes - size)) return std::nullopt;
                bytes += size;
                copy = OleDuplicateData(source, static_cast<CLIPFORMAT>(base), GMEM_MOVEABLE);
            }
            if (!copy) throw std::runtime_error("clipboard copy failed");
            items.emplace_back(format, copy);
        }
        return items;
    }
    // Whether the open clipboard's text is `text`.
    bool holds(const std::wstring& text) const {
        const HANDLE data = GetClipboardData(CF_UNICODETEXT);
        if (!data) return false;
        const auto* chars = static_cast<const wchar_t*>(GlobalLock(data));
        if (!chars) return false;
        const size_t length = GlobalSize(data) / sizeof(wchar_t);
        const bool same = wcsnlen(chars, length) == text.size() && std::wmemcmp(chars, text.data(), text.size()) == 0;
        GlobalUnlock(data);
        return same;
    }
    // Puts `items` on the open clipboard in place of what it holds. They are published themselves:
    // Windows owns them from here.
    void put(std::vector<ClipboardItem>& items) {
        if (!EmptyClipboard()) throw std::runtime_error("clipboard empty failed");
        for (auto& item : items) item.publish();
    }
private:
    HWND window = nullptr;
    bool opened = false;
};
// The clipboard as it was before a paste, put back after it (ADR-DESK-002, amended 2026-10-08),
// as the Mac's ClipboardKeeper does.
//
// The paste never reads the clipboard: reading it asks its owner for every format's data, which a
// busy app hands over late. It is saved ahead, on a thread of its own, while the user speaks
// (`save`, which the app asks for from key-down until the paste, every `clipboardSaveInterval`). The clipboard goes back
// `restoreDelay` after the paste keys, on a thread of its own, and only while it still holds the
// paste's text (its sequence number) and was saved as it was just before the paste: a copy made in
// between is never overwritten, and a paste without such a save leaves its text. A password
// manager's clipboard is not saved, and not put back, where its manager would no longer clear it.
// A save still reading when a paste comes holds the clipboard open, and the paste waits for it as
// for any other program (`clipboardOpenWaitMs`).
class ClipboardKeeper {
public:
    explicit ClipboardKeeper(ClipboardRules rules) : state(std::make_shared<State>()) { state->rules = rules; }
    // Saves the clipboard in the background, unless it is saved, or being saved, as it is now.
    void save() {
        const DWORD sequence = GetClipboardSequenceNumber();
        uint64_t generation = 0;
        {
            std::lock_guard lock(state->mutex);
            if ((state->saved && state->saved->sequence == sequence) || (state->saving && state->savingFrom == sequence)) {
                log("clipboard unchanged since it was saved");
                return;
            }
            // One read at a time: an owner that never answers holds one thread, not one per copy.
            if (state->reading) { log("a save still reading; not saved again"); return; }
            state->reading = true;
            generation = ++state->generation;
            state->saving = generation;
            state->savingFrom = sequence;
        }
        std::thread([state = state, generation] {
            const auto started = GetTickCount64();
            std::optional<std::vector<ClipboardItem>> items;
            DWORD sequence = 0;
            bool read = false;
            try {
                Clipboard clipboard;
                clipboard.open();
                items = clipboard.read(state->rules);
                // Read while held, as the paste reads `before`: the number of the clipboard just
                // read, not of a copy another program makes once it is let go. After the read, so
                // it is the clipboard as it is once a late owner has handed every format over.
                sequence = GetClipboardSequenceNumber();
                clipboard.close();
                read = sequence != 0;
            } catch (const std::exception&) {}
            std::lock_guard lock(state->mutex);
            state->reading = false;
            // A paste took its place.
            if (state->saving != generation) return;
            state->saving = 0;
            if (!read) { log("clipboard couldn't be saved"); return; }
            const bool kept = items.has_value();
            state->saved = Saved{sequence, std::move(items)};
            log(std::string("clipboard ") + (kept ? "saved" : "not to be saved") + " after " + std::to_string(GetTickCount64() - started) + "ms");
        }).detach();
    }
    // The paste's text was written over the open clipboard, its sequence number going from `before`
    // to `ours`: the saved clipboard now holds while the text is there.
    void wrote(DWORD before, DWORD ours) {
        std::lock_guard lock(state->mutex);
        if (state->saved && state->saved->sequence == before) {
            state->saved->sequence = ours;
        } else {
            log(state->saving ? "the clipboard's save still under way; it won't be put back" : "no save of the clipboard as it was; it won't be put back");
            state->saved.reset();
        }
        // A save under way read a clipboard this write replaced.
        state->saving = 0;
    }
    // Puts the saved clipboard back `restoreDelay` from now, if the clipboard still holds the
    // paste's `text` and `ours`, its sequence number. The number is read once the paste closes the
    // clipboard, by when another program may have copied, so the text is checked too.
    void restore(DWORD ours, const std::wstring& text) noexcept {
        try {
            std::thread([state = state, ours, text] {
                const auto started = GetTickCount64();
                Sleep(state->rules.restoreDelay);
                const auto nothingSaved = [&] { return !state->saved || state->saved->sequence != ours || !state->saved->items; };
                {
                    // Nothing to put back: the clipboard isn't opened again.
                    std::lock_guard lock(state->mutex);
                    if (nothingSaved()) { log("nothing saved to put back; the paste's text stays"); return; }
                }
                try {
                    Clipboard clipboard;
                    clipboard.open();
                    std::lock_guard lock(state->mutex);
                    if (GetClipboardSequenceNumber() != ours || !clipboard.holds(text)) { log("clipboard changed since the paste; not put back"); return; }
                    if (nothingSaved()) { log("nothing saved to put back; the paste's text stays"); return; }
                    // Published, so Windows owns them: the next dictation reads the clipboard again.
                    auto items = std::move(*state->saved->items);
                    state->saved.reset();
                    clipboard.put(items);
                    log("clipboard put back after " + std::to_string(GetTickCount64() - started) + "ms");
                } catch (const std::exception&) {
                    log("clipboard couldn't be put back");
                }
            }).detach();
        } catch (...) {
            log("clipboard couldn't be put back");
        }
    }
private:
    static void log(const std::string& message) { std::cerr << "debug clipboard keeper: " + message + "\n"; }
    // The user's clipboard as saved (no items for one not to be saved), and the sequence number it
    // holds for: the clipboard's as it was read, then a paste's written over it.
    struct Saved {
        DWORD sequence = 0;
        std::optional<std::vector<ClipboardItem>> items;
    };
    struct State {
        ClipboardRules rules;
        std::mutex mutex;
        std::optional<Saved> saved;
        // The latest save's number, the one under way (0 for none), and the sequence it started at.
        uint64_t generation = 0, saving = 0;
        DWORD savingFrom = 0;
        // A read is running, kept or not.
        bool reading = false;
    };
    // Shared with the threads, which outlive no process but may outlive a keeper.
    std::shared_ptr<State> state;
};
}
