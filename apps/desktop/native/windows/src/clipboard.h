// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "helper_config.h"
#include <windows.h>
#include <stdexcept>
#include <cstring>
#include <string>
#include <utility>

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
// The clipboard a paste writes. It is never read: what it held before is replaced, and the text
// stays on it (ADR-DESK-002).
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
        close();
    }
private:
    HWND window = nullptr;
    bool opened = false;
};
}
