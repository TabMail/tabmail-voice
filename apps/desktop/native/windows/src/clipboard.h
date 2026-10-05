// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <ole2.h>
#include <vector>
#include <stdexcept>
#include <cstring>
#include <utility>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>

namespace voice {
// Clipboard ownership sends synchronous window messages. Pump them during waits so a
// user's intervening copy can finish while the helper is waiting to restore.
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
// Refuse an uncopyable clipboard before changing it. Every format is captured, not just text.
// Owner-display and application-private handles have no general cloning/ownership contract.
class Clipboard {
public:
    Clipboard() {
        window = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, GetModuleHandleW(nullptr), nullptr);
        if (!window) throw std::runtime_error("clipboard owner failed");
    }
    ~Clipboard() { close(); DestroyWindow(window); }
    void open() {
        const auto end = GetTickCount64() + 500;
        while (!OpenClipboard(window)) {
            if (GetTickCount64() >= end) throw std::runtime_error("clipboard busy");
            clipboardWait(5);
        }
        opened = true;
    }
    void close() { if (opened) { CloseClipboard(); opened = false; } }
    void snapshot() {
        SIZE_T bytes = 0;
        UINT format = 0;
        while (true) {
            SetLastError(ERROR_SUCCESS);
            format = EnumClipboardFormats(format);
            if (!format) {
                if (GetLastError() != ERROR_SUCCESS) throw std::runtime_error("clipboard enumeration failed");
                break;
            }
            if (saved.size() >= 256 || format == CF_OWNERDISPLAY || (format >= CF_PRIVATEFIRST && format <= CF_GDIOBJLAST)) {
                throw std::runtime_error("clipboard cannot be preserved");
            }
            HANDLE source = GetClipboardData(format);
            if (!source) throw std::runtime_error("clipboard format unavailable (ID " + std::to_string(format) + ")");
            HANDLE copy = nullptr;
            const UINT base = format == CF_DSPBITMAP ? CF_BITMAP : format == CF_DSPMETAFILEPICT ? CF_METAFILEPICT : format;
            if (format == CF_ENHMETAFILE || format == CF_DSPENHMETAFILE) {
                copy = CopyEnhMetaFileW(static_cast<HENHMETAFILE>(source), nullptr);
            } else {
                const bool gdi = base == CF_BITMAP || base == CF_PALETTE || base == CF_METAFILEPICT;
                const auto size = gdi ? 0 : GlobalSize(source);
                if (!gdi && (!size || size > 64 * 1024 * 1024 || bytes > 64 * 1024 * 1024 - size)) {
                    throw std::runtime_error("clipboard snapshot too large");
                }
                bytes += size;
                copy = OleDuplicateData(source, static_cast<CLIPFORMAT>(base), GMEM_MOVEABLE);
            }
            if (!copy) throw std::runtime_error("clipboard copy failed");
            saved.emplace_back(format, copy);
        }
    }
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
        changed = true;
        try {
            excludeItem.publish(); historyItem.publish(); cloudItem.publish(); content.publish();
        } catch (...) {
            // Still holding the clipboard, so an intervening copy cannot be overwritten.
            restoreHeld(); throw;
        }
        close();
        sequence = GetClipboardSequenceNumber();
        if (!sequence) throw std::runtime_error("clipboard sequence unavailable");
    }
    void restoreSnapshot() { open(); restoreHeld(); close(); }
    std::vector<ClipboardItem> take() { return std::move(saved); }
    void adopt(std::vector<ClipboardItem> items) { saved = std::move(items); }
    // The clipboard as it was could not be saved: it is not put back.
    void forget() { restorable = false; }
    void restore() {
        if (!changed || !restorable) return;
        open();
        if (GetClipboardSequenceNumber() == sequence && GetClipboardOwner() == window) restoreHeld();
        close();
        changed = false;
    }
private:
    void restoreHeld() {
        if (!EmptyClipboard()) throw std::runtime_error("clipboard restore failed");
        for (auto& item : saved) item.publish();
        changed = false;
    }
    HWND window = nullptr;
    bool opened = false, changed = false, restorable = true;
    DWORD sequence = 0;
    std::vector<ClipboardItem> saved;
};
// The clipboard as it was, saved on a thread of its own: a clipboard owner that renders late
// keeps GetClipboardData (and the clipboard, held open by the reader) waiting for up to 30 s.
// `read` waits `milliseconds`; past that the reader goes on alone and its result is dropped.
struct ClipboardSave {
    enum class Outcome { saved, unpreservable, unavailable };
    Outcome outcome;
    std::vector<ClipboardItem> items;
    static ClipboardSave read(unsigned milliseconds) {
        struct Shared {
            std::mutex lock;
            std::condition_variable done;
            bool finished = false;
            Outcome outcome = Outcome::unavailable;
            std::vector<ClipboardItem> items;
        };
        auto shared = std::make_shared<Shared>();
        std::thread([shared] {
            auto outcome = Outcome::unavailable;
            std::vector<ClipboardItem> items;
            try {
                Clipboard clipboard;
                clipboard.open();
                try { clipboard.snapshot(); items = clipboard.take(); outcome = Outcome::saved; }
                catch (const std::exception&) { outcome = Outcome::unpreservable; }
            } catch (const std::exception&) {}
            std::lock_guard<std::mutex> guard(shared->lock);
            shared->finished = true; shared->outcome = outcome; shared->items = std::move(items);
            shared->done.notify_all();
        }).detach();
        std::unique_lock<std::mutex> guard(shared->lock);
        if (!shared->done.wait_for(guard, std::chrono::milliseconds(milliseconds), [&] { return shared->finished; }))
            return {Outcome::unavailable, {}};
        return {shared->outcome, std::move(shared->items)};
    }
};
}
