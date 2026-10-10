// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include <windows.h>
#include <nlohmann/json.hpp>
#include <array>
#include <atomic>
#include <cmath>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include "gesture.h"
#include "modifier.h"
#include "output.h"

using JSON = nlohmann::json;
namespace {
constexpr UINT requestMessage = WM_APP + 1;
constexpr size_t maxRequestBytes = 1024 * 1024;
DWORD hookThread = 0;
voice::Output* output = nullptr;
HHOOK hook = nullptr;
std::atomic<unsigned> queuedRequests{0};
voice::Gesture gesture;
voice::ModifierChoice modifier;
std::array<bool, 256> pressed{};
std::array<bool, 256> swallowed{};
// An unassigned virtual key: the app in front ignores it, but after it Windows counts the Alt
// release as Alt used with another key, not a lone Alt press (which opens the menu bar).
constexpr WORD menuMaskKey = 0xE8;
bool altMasked = false; // menuMaskKey was sent during this Right Alt hold

// A blocked/broken parent must not leave a helper owning keys. Windows bounds the message
// queue; exhaustion ends this process and removes its hook instead of dropping an action.
void post(DWORD thread, UINT message, WPARAM value = 0, LPARAM data = 0) {
    if (!PostThreadMessageW(thread, message, value, data)) ExitProcess(1);
}
void emit(voice::Action action) { output->action(action); }
void reply(JSON value) { output->send(std::move(value)); }
double monotonicSeconds() { return static_cast<double>(GetTickCount64()) / 1000.0; }

LRESULT CALLBACK keyboard(int code, WPARAM message, LPARAM data) {
    if (code < 0) return CallNextHookEx(hook, code, message, data);
    const auto& event = *reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
    const unsigned key = event.vkCode;
    if (key >= pressed.size()) return CallNextHookEx(hook, code, message, data);
    const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
    const bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
    if (!down && !up) return CallNextHookEx(hook, code, message, data);
    if (modifier.bypass(key, down, (event.flags & LLKHF_INJECTED) != 0)) return CallNextHookEx(hook, code, message, data);
    bool owns = false;
    std::optional<voice::Action> action;
    // Windows passes on the key event of a hook that answers too late (under heavy load; current
    // Windows may also remove the hook), so the key-down reaches the system anyway. Swallowing its
    // key-up then leaves the system holding the key, and every paste after it sees a modifier held.
    // So a key-up goes through when GetAsyncKeyState, which here gives the state from before this
    // event, says the system holds the key.
    const bool systemHolds = (GetAsyncKeyState(static_cast<int>(key)) & 0x8000) != 0;
    const bool leaked = up && systemHolds;
    if (key == modifier.selected) {
        // The system holds Right Alt from a leaked key-down: its release alone would open the menu
        // bar of the app in front. Pressing menuMaskKey now makes it Alt used with another key. The
        // real release still goes through below; if the mask is lost, the worst is that menu bar.
        if (down && systemHolds && key == voice::ModifierChoice::rightAlt && !altMasked) {
            INPUT mask[2]{};
            for (auto& input : mask) { input.type = INPUT_KEYBOARD; input.ki.wVk = menuMaskKey; }
            mask[1].ki.dwFlags = KEYEVENTF_KEYUP;
            altMasked = SendInput(2, mask, sizeof(INPUT)) == 2; // Injected keys pass this hook.
        }
        if (up) altMasked = false;
        owns = down || (swallowed[key] && !leaked);
        if (down) swallowed[key] = true;
        else swallowed[key] = false;
        action = gesture.modifier(down, monotonicSeconds(), modifier.agentIntent());
    } else if (down) {
        owns = swallowed[key] || gesture.owns(key);
        if (owns) swallowed[key] = true;
        action = gesture.keyPressed(key, pressed[key]);
    } else {
        owns = swallowed[key] && !leaked;
        swallowed[key] = false;
    }
    pressed[key] = down;
    if (action) emit(*action);
    // No JSON encoding, heap allocation or pipe I/O occurs in this callback.
    return owns ? 1 : CallNextHookEx(hook, code, message, data);
}

JSON handle(const std::string& method, const JSON& params) {
    if (method == "configure") {
        if (!params.is_object()) throw std::runtime_error("configure needs parameters");
        const auto hotkey = params.value("hotkey", std::string());
        if ((hotkey != "rightControl" && hotkey != "rightAlt") ||
            !params.contains("tapMaxDuration") || !params["tapMaxDuration"].is_number() ||
            !params.contains("doubleTapWindow") || !params["doubleTapWindow"].is_number()) {
            throw std::runtime_error("configure needs a supported modifier and gesture durations");
        }
        const double tap = params["tapMaxDuration"].get<double>();
        const double window = params["doubleTapWindow"].get<double>();
        if (!std::isfinite(tap) || tap < 0 || !std::isfinite(window) || window < 0) {
            throw std::runtime_error("gesture durations must be finite and nonnegative");
        }
        const unsigned selected = hotkey == "rightAlt" ? VK_RMENU : VK_RCONTROL;
        if (modifier.selected != selected || gesture.tapMaxDuration != tap || gesture.doubleTapWindow != window) {
            if (gesture.active()) emit(voice::Action::cancel);
            const bool chat = gesture.chatOpen;
            gesture = voice::Gesture{};
            gesture.chatOpen = chat;
            gesture.tapMaxDuration = tap;
            gesture.doubleTapWindow = window;
        }
        modifier.selected = selected;
        if (!hook) modifier.seedControls((GetAsyncKeyState(VK_LCONTROL) & 0x8000) != 0, (GetAsyncKeyState(VK_RCONTROL) & 0x8000) != 0);
        if (!hook) modifier.seedShifts((GetAsyncKeyState(VK_LSHIFT) & 0x8000) != 0, (GetAsyncKeyState(VK_RSHIFT) & 0x8000) != 0);
        if (!hook) hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard, GetModuleHandleW(nullptr), 0);
        return {{"installed", hook != nullptr}};
    }
    if (method == "dictationEnded") {
        gesture.dictationEnded();
        return JSON::object();
    }
    if (method == "setChatOpen") {
        if (!params.is_object() || !params.contains("isOpen") || !params["isOpen"].is_boolean()) {
            throw std::runtime_error("setChatOpen needs isOpen");
        }
        gesture.chatOpen = params["isOpen"].get<bool>();
        return JSON::object();
    }
    throw std::runtime_error("unknown method");
}

void request(const JSON& input) {
    if (!input.is_object() || !input.contains("id") || !input["id"].is_number_integer() ||
        !input.contains("method") || !input["method"].is_string()) return;
    const auto id = input["id"];
    try {
        reply({{"id", id}, {"result", handle(input["method"].get<std::string>(), input.value("params", JSON::object()))}});
    } catch (const std::exception&) {
        // Request bodies can carry private text: never log or echo parser exceptions.
        reply({{"id", id}, {"error", {{"message", "hotkey request failed"}}}});
    }
}
}

int main() {
    hookThread = GetCurrentThreadId();
    MSG initial{};
    PeekMessageW(&initial, nullptr, 0, 0, PM_NOREMOVE);
    voice::Output writer;
    output = &writer;
    std::thread([] {
        // Bounded input; EOF is the app's lifetime boundary, including EOF mid-request.
        std::string line;
        char byte;
        while (std::cin.get(byte)) {
            if (byte != '\n') {
                if (line.size() == maxRequestBytes) ExitProcess(1);
                line.push_back(byte);
                continue;
            }
            auto parsed = JSON::parse(line, nullptr, false);
            line.clear();
            if (parsed.is_discarded()) continue;
            if (queuedRequests.fetch_add(1) >= 32) ExitProcess(1);
            auto value = std::make_unique<JSON>(std::move(parsed));
            post(hookThread, requestMessage, 0, reinterpret_cast<LPARAM>(value.release()));
        }
        post(hookThread, WM_QUIT);
    }).detach();
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (message.message == requestMessage) {
            std::unique_ptr<JSON> input(reinterpret_cast<JSON*>(message.lParam));
            queuedRequests.fetch_sub(1);
            request(*input);
        }
    }
    if (hook) UnhookWindowsHookEx(hook);
    ExitProcess(0);
}
