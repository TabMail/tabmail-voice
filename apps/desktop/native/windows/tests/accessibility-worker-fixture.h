// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Synthetic OS/provider boundaries for the actual production request worker.
// No UI, clipboard or audio operations occur in this fixture.
#include <nlohmann/json.hpp>
#include "../../shared/rust/VoiceCore.h"
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <stdexcept>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "../src/helper_config.h"
using JSON = nlohmann::json;
using HWND = void*;
using ULONGLONG = uint64_t;
std::atomic<HWND> foreground{reinterpret_cast<HWND>(uintptr_t{42})};
HWND GetForegroundWindow() { return foreground.load(); }
uint64_t GetTickCount64() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
void Sleep(int milliseconds) { std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds)); }
[[noreturn]] void ExitProcess(int code) { std::_Exit(code); }
namespace voice {
struct COM { COM() {} ~COM() {} };
struct ScreenExclusions {};
struct Output {
 mutable std::mutex mutex;
 mutable std::condition_variable changed;
 mutable std::map<int64_t, JSON> replies;
 void send(JSON reply) const { std::lock_guard lock(mutex); replies.emplace(reply["id"].get<int64_t>(), std::move(reply)); changed.notify_all(); }
 JSON take(int64_t id, std::chrono::milliseconds wait = std::chrono::seconds(2)) const { std::unique_lock lock(mutex); if (!changed.wait_for(lock, wait, [&]{return replies.contains(id);})) throw std::runtime_error("missing reply"); return replies.at(id); }
};
std::mutex gateMutex;
std::condition_variable gateChanged;
bool blockNext = false, entered = false, released = false, providerFailure = false;
std::atomic<int> caretCalls{0}, inserts{0}, fieldCalls{0};
void gate() {
 std::unique_lock lock(gateMutex);
 if (!blockNext) return;
 blockNext = false; entered = true; gateChanged.notify_all();
 if (!gateChanged.wait_for(lock, std::chrono::seconds(1), []{return released;})) throw std::runtime_error("test gate timeout");
}
void armGate() { std::lock_guard lock(gateMutex); blockNext = true; entered = false; released = false; }
void waitEntered() { std::unique_lock lock(gateMutex); if (!gateChanged.wait_for(lock, std::chrono::seconds(1), []{return entered;})) throw std::runtime_error("test gate not entered"); }
void releaseGate() { std::lock_guard lock(gateMutex); released = true; gateChanged.notify_all(); }
uint64_t unixMilliseconds() { return 1000; }
std::wstring utf16(std::string s) { return std::wstring(s.begin(), s.end()); }
std::wstring executableName(HWND) { return L"Synthetic.exe"; }
void paste(HWND, std::wstring, uint64_t, std::function<bool()> canceled) { if (!canceled()) ++inserts; }
template<class Name, class Read> JSON screenAccess(const JSON&, HWND w, Name, Read read, bool = false) { return read(w, ScreenExclusions{}); }
struct Automation {
 JSON caret(HWND w) { ++caretCalls; gate(); if (providerFailure) throw std::runtime_error("synthetic provider failure"); if (!w || w != GetForegroundWindow()) return nullptr; return {{"x", reinterpret_cast<uintptr_t>(w)}, {"y", 20}, {"width", 1}, {"height", 20}}; }
 JSON fieldValue(HWND w, unsigned, const ScreenExclusions&) { ++fieldCalls; return w ? JSON{{"value","synthetic"}} : JSON(nullptr); }
};
}
