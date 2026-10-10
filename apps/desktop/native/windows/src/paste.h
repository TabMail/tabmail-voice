// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "accessibility.h"
#include "clipboard.h"
#include "helper_config.h"
#include <algorithm>
#include <functional>
#include <string>
#include <vector>
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
// Pastes `text` into `window`'s focused field. The clipboard as it was is never read here:
// `keeper` saved it ahead, and puts it back after the paste keys.
inline void paste(HWND window, const std::wstring& text, uint64_t deadline, const std::function<bool()>& canceled, ClipboardKeeper& keeper) {
    const auto started = GetTickCount64();
    const auto stage = [started](const char* name) {
        std::cerr << "debug paste stage: " + std::string(name) + " after " + std::to_string(GetTickCount64() - started) + "ms\n";
    };
    stage("focus-check");
    Automation automation;
    const char* refusal = nullptr;
    auto field = automation.focused(window, &refusal);
    // Send the ordinary paste command; the target decides whether to consume it.
    // Editable-value patterns govern field reading, not keyboard input.
    if (!field) throw std::runtime_error(std::string("target focus unavailable or protected: ") + (refusal ? refusal : "unknown"));
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
    Clipboard clipboard;
    stage("clipboard-open");
    const auto now = unixMilliseconds();
    clipboard.open(std::min<unsigned long long>(HelperConfig::clipboardOpenWaitMs, deadline > now ? deadline - now : 0));
    const DWORD before = GetClipboardSequenceNumber();
    stage("final-focus-check");
    guard();
    stage("clipboard-write");
    clipboard.putText(text);
    clipboard.close();
    // Read once closed: closing adds the formats Windows makes from the text, each a new number.
    const DWORD ours = GetClipboardSequenceNumber();
    keeper.wrote(before, ours);
    // Whether the keys are sent or the paste is refused from here, the clipboard as it was goes back.
    struct PutBack {
        ClipboardKeeper& keeper;
        DWORD ours;
        const std::wstring& text;
        ~PutBack() { keeper.restore(ours, text); }
    } const putBack{keeper, ours, text};
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
    stage("send-input");
    const auto sent = SendInput(4, keys, sizeof(INPUT));
    if (sent != 4) {
        // Release only our own injected keys if a partial insertion was reported.
        if (sent) SendInput(2, keys + 2, sizeof(INPUT));
        throw std::runtime_error("native insertion failed");
    }
    stage("complete");
}
}
