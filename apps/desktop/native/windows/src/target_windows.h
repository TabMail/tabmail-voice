// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <tlhelp32.h>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <nlohmann/json.hpp>

namespace voice {
inline DWORD parentProcess() {
    const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
    DWORD parent = 0;
    if (Process32FirstW(snapshot, &entry)) do {
        if (entry.th32ProcessID == GetCurrentProcessId()) { parent = entry.th32ParentProcessID; break; }
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    return parent;
}
inline DWORD windowProcess(HWND window) { DWORD pid = 0; GetWindowThreadProcessId(window, &pid); return pid; }

// Observe focus, without polling: Voice's windows never replace the most recent external window.
// The helper has process lifetime; the input loop calls ExitProcess at EOF.
class TargetWindows {
    DWORD owner = parentProcess();
    HWND previous = nullptr;
    DWORD previousPid = 0;
    std::mutex mutex;
    std::condition_variable ready;
    bool started = false;
    static inline thread_local TargetWindows* observing = nullptr;
    static void CALLBACK changed(HWINEVENTHOOK, DWORD, HWND window, LONG, LONG, DWORD, DWORD) {
        if (observing) observing->remember(window);
    }
    void remember(HWND window) {
        const DWORD pid = windowProcess(window);
        if (!window || !pid || pid == owner) return;
        std::lock_guard lock(mutex);
        previous = window;
        previousPid = pid;
    }
public:
    TargetWindows() {
        std::thread([this] {
            observing = this;
            const auto hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
                nullptr, changed, 0, 0, WINEVENT_OUTOFCONTEXT);
            remember(GetForegroundWindow());
            { std::lock_guard lock(mutex); started = true; ready.notify_one(); }
            MSG message;
            while (hook && GetMessageW(&message, nullptr, 0, 0) > 0) {
                TranslateMessage(&message); DispatchMessageW(&message);
            }
            if (hook) UnhookWinEvent(hook);
        }).detach();
        std::unique_lock lock(mutex);
        ready.wait(lock, [this] { return started; });
    }
    nlohmann::json capture() {
        const auto front = GetForegroundWindow();
        if (!front || !owner) return nullptr;
        remember(front);
        std::lock_guard lock(mutex);
        const auto window = windowProcess(front) == owner ? previous : front;
        const auto pid = windowProcess(front) == owner ? previousPid : windowProcess(front);
        if (!window || !pid || !IsWindow(window) || windowProcess(window) != pid) return nullptr;
        return {{"window", reinterpret_cast<uintptr_t>(window)}, {"pid", pid}};
    }
};
}
