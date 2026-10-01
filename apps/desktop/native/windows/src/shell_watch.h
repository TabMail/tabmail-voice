// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <thread>
#include "output.h"
#include "shell_bounds.h"

namespace voice {
// Geometry events only, with a one-shot coalescing timer. No accessibility tree polling.
class ShellWatch {
public:
    explicit ShellWatch(const Output& output) {
        std::thread([&output] {
            MSG message{};
            PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
            const auto foreground = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
                nullptr, changed, 0, 0, WINEVENT_OUTOFCONTEXT);
            const auto location = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE,
                nullptr, changed, 0, 0, WINEVENT_OUTOFCONTEXT);
            const auto visibility = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_HIDE,
                nullptr, changed, 0, 0, WINEVENT_OUTOFCONTEXT);
            if (!foreground || !location || !visibility) ExitProcess(1);
            auto previous = shellExclusionBounds();
            while (GetMessageW(&message, nullptr, 0, 0) > 0) {
                if (message.message == WM_TIMER && message.wParam == timer) {
                    KillTimer(nullptr, timer);
                    timer = 0;
                    auto current = shellExclusionBounds();
                    if (current != previous) {
                        previous = std::move(current);
                        output.send({{"event", "shellGeometryChanged"}});
                    }
                }
                DispatchMessageW(&message);
            }
            UnhookWinEvent(foreground);
            UnhookWinEvent(location);
            UnhookWinEvent(visibility);
        }).detach();
    }
private:
    inline static thread_local UINT_PTR timer = 0;
    static void CALLBACK changed(HWINEVENTHOOK, DWORD event, HWND window, LONG object, LONG child, DWORD, DWORD) {
        if (!window) return;
        if (event != EVENT_SYSTEM_FOREGROUND && (object != OBJID_WINDOW || child != CHILDID_SELF)) return;
        // Do not postpone an existing timer: continuous animations still receive bounded updates.
        if (!timer) timer = SetTimer(nullptr, 0, 100, nullptr);
    }
};
}
