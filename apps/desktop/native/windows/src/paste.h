// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "accessibility.h"
#include "clipboard.h"
#include "helper_config.h"
#include <functional>
#include <iostream>

namespace voice {
inline uint64_t unixMilliseconds() {
    FILETIME value{}; GetSystemTimeAsFileTime(&value);
    ULARGE_INTEGER ticks{}; ticks.LowPart = value.dwLowDateTime; ticks.HighPart = value.dwHighDateTime;
    return ticks.QuadPart / 10000 - 11644473600000ULL;
}
inline DWORD integrity(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) throw std::runtime_error("target process inaccessible");
    HANDLE token = nullptr;
    const bool opened = OpenProcessToken(process, TOKEN_QUERY, &token) != FALSE;
    CloseHandle(process);
    if (!opened) throw std::runtime_error("target token inaccessible");
    DWORD size = 0;
    GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &size);
    std::vector<BYTE> data(size);
    const bool read = size && GetTokenInformation(token, TokenIntegrityLevel, data.data(), size, &size);
    CloseHandle(token);
    if (!read) throw std::runtime_error("target integrity unavailable");
    const auto label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(data.data());
    if (!IsValidSid(label->Label.Sid)) throw std::runtime_error("target integrity invalid");
    const auto count = *GetSidSubAuthorityCount(label->Label.Sid);
    if (!count) throw std::runtime_error("target integrity invalid");
    return *GetSidSubAuthority(label->Label.Sid, count - 1);
}
// Types `text` into the focused field, for when the clipboard can't be used. On one line: a typed
// line break is a key press, which in a single-line field (a search box, a chat) submits it, so
// every line break, or character that may act as one, is typed as a space (owner, 2026-10-05).
inline void typeText(const std::wstring& text) {
    std::vector<INPUT> keys;
    const auto key = [&](wchar_t unit, DWORD flags) {
        INPUT input{}; input.type = INPUT_KEYBOARD;
        input.ki.wScan = unit; input.ki.dwFlags = KEYEVENTF_UNICODE | flags;
        keys.push_back(input);
    };
    for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] == L'\r' && i + 1 < text.size() && text[i + 1] == L'\n') continue;
        // A tab moves focus out of a form field, so it is a space too.
        const bool lineBreak = text[i] == L'\r' || text[i] == L'\n' || text[i] == L'\v' || text[i] == L'\f' || text[i] == L'\t' ||
            text[i] == L'\x85' || text[i] == L'\x2028' || text[i] == L'\x2029';
        const wchar_t unit = lineBreak ? L' ' : text[i];
        key(unit, 0); key(unit, KEYEVENTF_KEYUP);
    }
    if (keys.empty()) return;
    if (SendInput(static_cast<UINT>(keys.size()), keys.data(), sizeof(INPUT)) != keys.size()) throw std::runtime_error("native insertion failed");
}
inline void paste(HWND window, const std::wstring& text, unsigned restoreDelay, uint64_t deadline, const std::function<bool()>& canceled) {
    std::cerr << "debug paste stage: focus-check\n";
    Automation automation;
    auto field = automation.focused(window);
    // Send the ordinary paste command; the target decides whether to consume it.
    // Editable-value patterns govern field reading, not keyboard input.
    if (!field) throw std::runtime_error("target focus unavailable or protected");
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (!pid || integrity(pid) > integrity(GetCurrentProcessId())) throw std::runtime_error("target integrity refused");
    const auto guard = [&] {
        if (canceled() || unixMilliseconds() >= deadline || GetForegroundWindow() != window) {
            throw std::runtime_error("paste is no longer current");
        }
        auto current = automation.focused(window);
        if (!current || !automation.same(field.Get(), current.Get())) {
            throw std::runtime_error("focused field changed");
        }
        for (const int key : {VK_LCONTROL, VK_RCONTROL, VK_LSHIFT, VK_RSHIFT, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN}) {
            if (GetAsyncKeyState(key) & 0x8000) throw std::runtime_error("modifier held");
        }
        // A provider call may have blocked; these checks must also follow the final UIA call.
        if (canceled() || unixMilliseconds() >= deadline || GetForegroundWindow() != window) {
            throw std::runtime_error("paste is no longer current");
        }
    };
    guard();
    GUITHREADINFO focus{}; focus.cbSize = sizeof(focus);
    const DWORD thread = GetWindowThreadProcessId(window, nullptr);
    if (!GetGUIThreadInfo(thread, &focus) || !focus.hwndFocus) throw std::runtime_error("focus unavailable");
    std::cerr << "debug paste stage: clipboard-snapshot\n";
    auto save = ClipboardSave::read(HelperConfig::clipboardSnapshotWaitMs);
    if (save.outcome == ClipboardSave::Outcome::unavailable) {
        // Not saved in time, or held by another program: the clipboard can't be used, so type.
        std::cerr << "debug paste stage: clipboard unavailable, typing the text\n";
        guard();
        typeText(text);
        std::cerr << "debug paste stage: complete (typed)\n";
        return;
    }
    Clipboard clipboard;
    if (save.outcome == ClipboardSave::Outcome::saved) clipboard.adopt(std::move(save.items));
    else {
        std::cerr << "debug paste stage: clipboard not saved, pasting without restoring it\n";
        clipboard.forget();
    }
    std::cerr << "debug paste stage: clipboard-open\n";
    clipboard.open();
    if (GetClipboardSequenceNumber() != save.sequence) {
        // Copied to since it was saved: that copy is kept, and the text typed.
        clipboard.close();
        std::cerr << "debug paste stage: clipboard changed since it was saved, typing the text\n";
        guard();
        typeText(text);
        std::cerr << "debug paste stage: complete (typed)\n";
        return;
    }
    std::cerr << "debug paste stage: final-focus-check\n";
    guard();
    try {
        std::cerr << "debug paste stage: clipboard-write\n";
        clipboard.putText(text);
        GUITHREADINFO current{}; current.cbSize = sizeof(current);
        if (canceled() || unixMilliseconds() >= deadline || GetForegroundWindow() != window ||
            !GetGUIThreadInfo(thread, &current) || current.hwndFocus != focus.hwndFocus) {
            throw std::runtime_error("paste is no longer current");
        }
        for (const int key : {VK_LCONTROL, VK_RCONTROL, VK_LSHIFT, VK_RSHIFT, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN}) {
            if (GetAsyncKeyState(key) & 0x8000) throw std::runtime_error("modifier held");
        }
        INPUT keys[4]{};
        for (auto& key : keys) key.type = INPUT_KEYBOARD;
        keys[0].ki.wVk = VK_LCONTROL; keys[1].ki.wVk = 'V';
        keys[2].ki.wVk = 'V'; keys[2].ki.dwFlags = KEYEVENTF_KEYUP;
        keys[3].ki.wVk = VK_LCONTROL; keys[3].ki.dwFlags = KEYEVENTF_KEYUP;
        std::cerr << "debug paste stage: send-input\n";
        const auto sent = SendInput(4, keys, sizeof(INPUT));
        if (sent != 4) {
            // Release only our own injected keys if a partial insertion was reported.
            if (sent) SendInput(2, keys + 2, sizeof(INPUT));
            throw std::runtime_error("native insertion failed");
        }
        clipboardWait(restoreDelay);
        std::cerr << "debug paste stage: clipboard-restore\n";
        clipboard.restore();
        std::cerr << "debug paste stage: complete\n";
    } catch (...) {
        clipboard.restore(); throw;
    }
}
}
