// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <windows.h>
#include <UIAutomation.h>
#include <wrl/client.h>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <thread>
#include "activation_retry.h"

namespace voice {
// Run in an isolated mode of the helper: a slow third-party UIA provider must not
// occupy the caret/context queue or terminate the process that owns microphone capture.
class AccessibilityActivator {
public:
    void foreground(HWND window) {
        std::lock_guard lock(mutex);
        retry.enter(reinterpret_cast<uintptr_t>(window), GetTickCount64());
        changed.notify_one();
    }
    void work() {
        if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
            std::cerr << "error accessibility warmup: com-unavailable\n"; return;
        }
        Microsoft::WRL::ComPtr<IUIAutomation2> automation;
        if (FAILED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&automation))) ||
            FAILED(automation->put_ConnectionTimeout(HelperConfig::accessibilityRequestTimeoutMs)) ||
            FAILED(automation->put_TransactionTimeout(HelperConfig::accessibilityRequestTimeoutMs)) ||
            FAILED(automation->put_AutoSetFocus(FALSE))) {
            std::cerr << "error accessibility warmup: uia-configuration-unavailable\n";
            automation.Reset(); CoUninitialize(); return;
        }
        std::unique_lock lock(mutex);
        for (;;) {
            const auto due = retry.next();
            if (!due) { changed.wait(lock); continue; }
            const auto now = GetTickCount64();
            if (now < *due) {
                changed.wait_for(lock, std::chrono::milliseconds(*due - now));
                continue;
            }
            const auto attempt = retry.take(now);
            if (!attempt) continue;
            lock.unlock();
            const auto window = reinterpret_cast<HWND>(attempt->target);
            bool success = false;
            if (window && GetForegroundWindow() == window) {
                Microsoft::WRL::ComPtr<IUIAutomationElement> focused;
                // Querying the focused provider asks lazy accessibility providers to
                // expose their tree. No text, value, title or caret is collected here.
                const auto result = automation->GetFocusedElement(&focused);
                success = SUCCEEDED(result) && focused && GetForegroundWindow() == window;
                if (!success && GetForegroundWindow() == window)
                    std::cerr << "debug accessibility warmup: "
                        << (FAILED(result) ? "provider-unavailable" : "no-focused-element") << '\n';
            }
            lock.lock();
            retry.complete(*attempt, success, GetTickCount64());
        }
    }
private:
    std::mutex mutex;
    std::condition_variable changed;
    ActivationRetry retry;
};
inline thread_local AccessibilityActivator* foregroundActivator = nullptr;
inline void CALLBACK activationForeground(HWINEVENTHOOK, DWORD, HWND window, LONG, LONG, DWORD, DWORD) {
    if (foregroundActivator) foregroundActivator->foreground(window);
}
inline int runAccessibilityActivator() {
    // Process lifetime owns these detached threads. EOF always exits, including when
    // a broken provider ignores its UIA timeout; no foreground polling is performed.
    auto* activator = new AccessibilityActivator;
    std::thread([activator] { activator->work(); }).detach();
    std::thread([activator] {
        foregroundActivator = activator;
        const auto hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
            nullptr, activationForeground, 0, 0, WINEVENT_OUTOFCONTEXT);
        if (!hook) { std::cerr << "error accessibility warmup: foreground-hook-unavailable\n"; return; }
        activator->foreground(GetForegroundWindow());
        MSG message;
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        UnhookWinEvent(hook);
    }).detach();
    char byte;
    while (std::cin.get(byte)) {} // Parent closes the pipe at application shutdown.
    ExitProcess(0);
}
}
