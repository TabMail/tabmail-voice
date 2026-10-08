// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include <windows.h>
#include <security.h>
#include <nlohmann/json.hpp>
#include <iostream>
#include <string>
#include <vector>
#include "accessibility.h"
#include "text.h"
#include "shell_bounds.h"
#include "Privacy/Apps.h"
#include "shell_watch.h"
#include "paste.h"
#include "accessibility_activator.h"
#include "update_signature.h"
#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>

using JSON = nlohmann::json;
namespace {

JSON handle(const std::string& method, const JSON& params) {
    if (method == "redactText") return voice::core::request(params, voice_core_redact_text_json);
    if (method == "appInfo") return voice::privacy::appInfo(params);
    if (method == "shellExclusionBounds") return voice::shellExclusionBounds();
    if (method == "frontmostApp") {
        const HWND window = GetForegroundWindow();
        if (!window) return nullptr;
        // A window identity detects switching between documents in the same application too.
        return {{"window", reinterpret_cast<uintptr_t>(window)}};
    }
    if (method == "keyboardLanguage") {
        const HWND window = GetForegroundWindow();
        if (!window) return {{"code", nullptr}};
        const DWORD thread = GetWindowThreadProcessId(window, nullptr);
        const auto language = LOWORD(reinterpret_cast<uintptr_t>(GetKeyboardLayout(thread)));
        wchar_t name[LOCALE_NAME_MAX_LENGTH]{};
        if (!LCIDToLocaleName(MAKELCID(language, SORT_DEFAULT), name, LOCALE_NAME_MAX_LENGTH, 0)) {
            return {{"code", nullptr}};
        }
        return {{"code", voice::utf8(name)}};
    }
    if (method == "fullUserName") {
        ULONG size = 0;
        GetUserNameExW(NameDisplay, nullptr, &size);
        std::vector<wchar_t> name(size);
        if (size && GetUserNameExW(NameDisplay, name.data(), &size)) return {{"name", voice::utf8(name.data())}};
        // A local development account often has no separate full/display name.
        return {{"name", ""}};
    }
    throw std::runtime_error("unsupported native operation");
}
// UIA providers belong to other applications and can block. Keep them off the request thread; a
// bounded queue and process deadline prevent an unresponsive provider from holding the queue or
// performing stale requests after an app timeout. The microphone is voice-microphone.exe's.
class AccessibilityWorker {
public:
    explicit AccessibilityWorker(const voice::Output& output) : output(output) {
        std::thread([this] {
            voice::COM com;
            while (true) {
                JSON input;
                HWND requestedWindow = nullptr;
                {
                    std::unique_lock lock(mutex);
                    changed.wait(lock, [this] { return !queue.empty(); });
                    input = std::move(queue.front().input);
                    requestedWindow = queue.front().window;
                    queue.pop_front();
                    active = true;
                    busyUntil = GetTickCount64() + voice::HelperConfig::accessibilityWatchdogMs;
                    activeID = input["id"].get<int64_t>();
                    canceled = false;
                }
                const auto id = input["id"];
                try {
                    const auto params = input.value("params", JSON::object());
                    const auto method = input["method"].get<std::string>();
                    HWND window = requestedWindow;
                    // A foreground caret request captures its HWND at enqueue time, so
                    // callers need no preliminary IPC that another request could overtake.
                    const bool foregroundCaret = method == "caretAnchor" && params.is_object() && !params.contains("window");
                    if (!foregroundCaret) {
                        if (!params.is_object() || !params.contains("window") || !params["window"].is_number_unsigned()) {
                            throw std::runtime_error("invalid target");
                        }
                        window = reinterpret_cast<HWND>(params["window"].get<uintptr_t>());
                    }
                    JSON result;
                    if (method == "insert") {
                        if (!params.contains("deadline") || !params["deadline"].is_number_unsigned()) throw std::runtime_error("invalid paste");
                        const auto deadline = params["deadline"].get<uint64_t>();
                        const auto now = voice::unixMilliseconds();
                        // The shared core decides what may be pasted and how far ahead its deadline may be.
                        const auto wait = voice::core::request({{"insert", {{"text", params.value("text", JSON())}, {"deadline", deadline}, {"now", now}}}},
                                                               voice_core_request_json).at("wait").get<uint64_t>();
                        {
                            std::lock_guard lock(mutex);
                            // Paste checks its insertion deadline before mutation and input; its clipboard
                            // wait ends at the deadline, and this margin keeps the watchdog clear of it.
                            busyUntil = GetTickCount64() + wait + voice::HelperConfig::clipboardOpenWaitMs;
                        }
                        voice::paste(window, voice::utf16(params["text"].get<std::string>()), deadline, [this] { return canceled.load(); });
                        result = JSON::object();
                    } else {
                        voice::Automation automation;
                        result = automation.caret(window);
                    }
                    this->output.send({{"id", id}, {"result", result}});
                } catch (...) {
                    if (input["method"] == "caretAnchor") std::cerr << "debug caret lookup: provider-call-failed\n";
                    this->output.send({{"id", id}, {"error", {{"message", "Windows accessibility request failed"}}}});
                }
                {
                    std::lock_guard lock(mutex);
                    busyUntil = 0;
                    active = false;
                    changed.notify_all();
                }
            }
        }).detach();
        std::thread([this] {
            while (true) {
                {
                    // Check under the completion lock: a timestamp sampled from an old
                    // request must never terminate a newer request after a scheduling delay.
                    std::lock_guard lock(mutex);
                    if (active && busyUntil && GetTickCount64() > busyUntil) {
                        std::cerr << "error accessibility request: watchdog deadline exceeded\n";
                        ExitProcess(1);
                    }
                }
                Sleep(50);
            }
        }).detach();
    }
    void request(JSON input) {
        std::lock_guard lock(mutex);
        // Starting dictation locates the caret while other requests may still run.
        // Serialize that normal overlap instead of rejecting the overlay lookup.
        if (queue.size() >= 4) {
            this->output.send({{"id", input["id"]}, {"error", {{"message", "Windows accessibility helper busy"}}}});
            return;
        }
        queue.push_back({std::move(input), GetForegroundWindow()});
        changed.notify_one();
    }
    void finish() {
        std::unique_lock lock(mutex);
        canceled = true;
        queue.clear();
        changed.wait(lock, [this] { return !active; });
    }
    void cancel(int64_t id) {
        std::lock_guard lock(mutex);
        if (active && id == activeID) canceled = true;
        // A request canceled before its turn is still answered: every request gets its one reply.
        if (std::erase_if(queue, [id](const Request& request) { return request.input["id"] == id; })) {
            this->output.send({{"id", id}, {"error", {{"message", "Windows accessibility request canceled"}}}});
        }
    }
private:
    const voice::Output& output;
    std::mutex mutex;
    std::condition_variable changed;
    struct Request { JSON input; HWND window; };
    std::deque<Request> queue;
    ULONGLONG busyUntil = 0; // Protected with active by mutex.
    bool active = false;
    int64_t activeID = 0;
    std::atomic<bool> canceled{false};
};

}
int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--accessibility-activator") return voice::runAccessibilityActivator();
    if (argc >= 2 && std::string(argv[1]) == "--verify-update") return voice::runVerifyUpdate();
    if (argc != 1) return 1;
    // Native geometry is in physical pixels; Electron converts it to display-independent points.
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    voice::Output output;
    voice::ShellWatch shellWatch(output);
    AccessibilityWorker accessibility(output);
    std::string line;
    char byte;
    while (std::cin.get(byte)) {
        if (byte != '\n') {
            if (line.size() >= 1024 * 1024) ExitProcess(1);
            line.push_back(byte);
            continue;
        }
        auto input = JSON::parse(line, nullptr, false);
        line.clear();
        if (input.is_object() && input.value("method", JSON()) == "cancel") {
            const auto params = input.value("params", JSON());
            if (params.is_object() && params.contains("id") && params["id"].is_number_integer()) {
                try { accessibility.cancel(params["id"].get<int64_t>()); } catch (...) {}
            }
            continue;
        }
        if (!input.is_object() || !input.contains("id") || !input["id"].is_number_integer() ||
            !input.contains("method") || !input["method"].is_string()) continue;
        const auto id = input["id"];
        // The screen is read by voice-screen-reader.exe and the focused field by voice-field-reader.exe,
        // programs of their own.
        if (input["method"] == "caretAnchor" || input["method"] == "insert") { accessibility.request(std::move(input)); continue; }
        try {
            output.send({{"id", id}, {"result", handle(input["method"].get<std::string>(), input.value("params", JSON::object()))}});
        } catch (...) {
            // Never echo parameters, captured text, or native exception details into logs.
            output.send({{"id", id}, {"error", {{"message", "Windows native request failed"}}}});
        }
    }
    accessibility.finish();
    // Output owns a process-lifetime writer thread. EOF closes all native resources together.
    ExitProcess(0);
}
