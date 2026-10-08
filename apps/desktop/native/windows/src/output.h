// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <windows.h>
#include <nlohmann/json.hpp>
#include <atomic>
#include <iostream>
#include <memory>
#include <thread>
#include "gesture.h"

namespace voice {
using JSON = nlohmann::json;

// One writer per helper. PostThreadMessage provides a bounded queue: a parent that stops
// reading cannot grow the helper indefinitely. Failure ends the helper, releasing its devices.
// Actions are small integers until this thread encodes them, never I/O in the keyboard hook.
class Output {
public:
    Output() {
        HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!ready) ExitProcess(1);
        std::thread([this, ready] {
            thread = GetCurrentThreadId();
            MSG message{};
            PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
            SetEvent(ready);
            while (GetMessageW(&message, nullptr, 0, 0) > 0) {
                queued.fetch_sub(1);
                try {
                    JSON value;
                    if (message.message == actionMessage) {
                        value = {{"event", "action"}, {"action", actionName(static_cast<Action>(message.wParam))}};
                    } else if (message.message == jsonMessage) {
                        std::unique_ptr<JSON> response(reinterpret_cast<JSON*>(message.lParam));
                        value = std::move(*response);
                    } else if (message.message == endMessage) {
                        ExitProcess(static_cast<UINT>(message.wParam));
                    } else continue;
                    std::cout << value.dump() << '\n' << std::flush;
                    if (!std::cout) ExitProcess(1);
                } catch (...) { ExitProcess(1); }
            }
        }).detach();
        WaitForSingleObject(ready, INFINITE);
        CloseHandle(ready);
    }
    void action(Action value) const { post(actionMessage, static_cast<WPARAM>(value), 0); }
    void send(JSON value) const {
        auto message = std::make_unique<JSON>(std::move(value));
        post(jsonMessage, 0, reinterpret_cast<LPARAM>(message.release()));
    }
    // Ends the process with `code` once everything sent before has been written.
    void end(UINT code) const { post(endMessage, code, 0); }
private:
    static constexpr UINT actionMessage = WM_APP + 20;
    static constexpr UINT jsonMessage = WM_APP + 21;
    static constexpr UINT endMessage = WM_APP + 22;
    DWORD thread = 0;
    mutable std::atomic<unsigned> queued{0};
    void post(UINT message, WPARAM value, LPARAM data) const {
        if (queued.fetch_add(1) >= 256) ExitProcess(1);
        if (!PostThreadMessageW(thread, message, value, data)) ExitProcess(1);
    }
};
}
