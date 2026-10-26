// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A small window of its own, on top and never activated, that the hotkey protocol test clicks with
// injected input, so the click lands on nothing else; the cursor goes back where it was. Says
// {"ready":true} once shown; for each "press" line, says whether its window got the click.
#include <windows.h>
#include <iostream>
#include <string>
#include <thread>

namespace {
constexpr UINT pressMessage = WM_APP + 1;
constexpr DWORD pressTimeoutMilliseconds = 2000;
bool released = false;

LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM value, LPARAM data) {
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    if (message == WM_LBUTTONUP) released = true;
    return DefWindowProcW(window, message, value, data);
}

bool press(HWND window) {
    RECT frame{};
    if (!GetWindowRect(window, &frame)) return false;
    const POINT center{(frame.left + frame.right) / 2, (frame.top + frame.bottom) / 2};
    // Something else on top there would get the click instead.
    if (WindowFromPoint(center) != window) return false;
    POINT saved{};
    if (!GetCursorPos(&saved) || !SetCursorPos(center.x, center.y)) return false;
    released = false;
    INPUT click[2]{};
    click[0].type = click[1].type = INPUT_MOUSE;
    click[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    click[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    const bool sent = SendInput(2, click, sizeof(INPUT)) == 2;
    const ULONGLONG deadline = GetTickCount64() + pressTimeoutMilliseconds;
    MSG message{};
    while (sent && !released && GetTickCount64() < deadline) {
        MsgWaitForMultipleObjects(0, nullptr, FALSE, 50, QS_ALLINPUT);
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
    }
    SetCursorPos(saved.x, saved.y);
    return sent && released;
}
}

int main() {
    WNDCLASSW type{};
    type.lpfnWndProc = procedure;
    type.hInstance = GetModuleHandleW(nullptr);
    type.lpszClassName = L"VoiceMouseFixture";
    type.hbrBackground = static_cast<HBRUSH>(GetStockObject(GRAY_BRUSH));
    if (!RegisterClassW(&type)) return 1;
    const HWND window = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, type.lpszClassName, L"",
                                        WS_POPUP, 40, 40, 120, 120, nullptr, nullptr, type.hInstance, nullptr);
    if (!window) return 1;
    ShowWindow(window, SW_SHOWNOACTIVATE);
    UpdateWindow(window);
    const DWORD thread = GetCurrentThreadId();
    MSG message{};
    PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
    std::thread([thread] {
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line == "press") PostThreadMessageW(thread, pressMessage, 0, 0);
        }
        PostThreadMessageW(thread, WM_QUIT, 0, 0);
    }).detach();
    std::cout << "{\"ready\":true}\n" << std::flush;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (message.message == pressMessage) {
            std::cout << (press(window) ? "{\"pressed\":true}\n" : "{\"pressed\":false}\n") << std::flush;
            continue;
        }
        DispatchMessageW(&message);
    }
    DestroyWindow(window);
    return 0;
}
