// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// voice-screen-reader.exe: reads the screen of the window in front, and does nothing else. A read
// may take as long as another app's UI Automation provider takes; in a process of its own it holds
// up no paste or recording, and the app ends the process when it no longer wants the read
// (`ScreenReader` in the app, ADR-DESK-053). Reads run one at a time on a thread of their own, so
// this thread keeps reading requests: `readScreenStop {read}` asks the read it names, and any
// numbered before it, to end at its next element with what it has read so far. EOF ends it.
#include <windows.h>
#include <nlohmann/json.hpp>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include "accessibility.h"
#include "output.h"

using JSON = nlohmann::json;

namespace {
// A read as it arrived: the window in front then is the one read, or nothing is.
struct Read {
    JSON id, params;
    HWND window = nullptr;
    int64_t number = 0;
    bool wholeWindow = false;
    ULONGLONG started = 0; // For the debug log's failure line.
};

// The reads not yet served, in the order they arrived, served by one thread with its own COM.
class Reads {
public:
    explicit Reads(const voice::Output& output) : output(output) {
        std::thread([this] { serve(); }).detach();
    }
    void add(Read read) {
        std::lock_guard lock(mutex);
        waiting.push_back(std::move(read));
        ready.notify_one();
    }
private:
    const voice::Output& output;
    std::mutex mutex;
    std::condition_variable ready;
    std::deque<Read> waiting;

    void serve() {
        voice::COM com;
        for (;;) {
            Read read;
            {
                std::unique_lock lock(mutex);
                ready.wait(lock, [this] { return !waiting.empty(); });
                read = std::move(waiting.front());
                waiting.pop_front();
            }
            voice::walk::readStops().reading = read.number;
            voice::walk::readingWholeWindow() = read.wholeWindow;
            try {
                output.send({{"id", read.id}, {"result", voice::screenAccess(read.params, read.window, voice::executableName,
                    [](HWND target, const voice::ScreenExclusions& exclusions) {
                        voice::Automation automation;
                        return automation.readScreen(target, exclusions);
                    })}});
            } catch (const std::exception& error) {
                // Never echo parameters or captured text into logs; our failure reasons are fixed phrases and HRESULT codes.
                std::cerr << "debug readScreen failed after " << (GetTickCount64() - read.started) << "ms: " << error.what() << "\n";
                output.send({{"id", read.id}, {"error", {{"message", "Windows accessibility request failed"}}}});
            } catch (...) {
                std::cerr << "debug readScreen failed after " << (GetTickCount64() - read.started) << "ms: unknown exception\n";
                output.send({{"id", read.id}, {"error", {{"message", "Windows accessibility request failed"}}}});
            }
        }
    }
};
}

int main(int argc, char**) {
    if (argc != 1) return 1;
    // Native geometry is in physical pixels; Electron converts it to display-independent points.
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    voice::Output output;
    Reads reads(output);
    voice::walk::LastReadWindow<HWND> lastRead;
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
        if (!input.is_object() || !input.contains("id") || !input["id"].is_number_integer() ||
            !input.contains("method") || !input["method"].is_string()) continue;
        const auto id = input["id"];
        const auto method = input["method"].get<std::string>();
        const auto params = input.value("params", JSON::object());
        if (method != "readScreen" && method != "readScreenStop") {
            output.send({{"id", id}, {"error", {{"message", "Windows native request failed"}}}});
            continue;
        }
        voice::walk::ScreenRead request;
        try {
            if (method == "readScreen") request = voice::walk::screenRead(params);
            else request.number = voice::walk::readNumber(method, params);
        } catch (...) {
            output.send({{"id", id}, {"error", {{"message", "Windows native request failed"}}}});
            continue;
        }
        if (method == "readScreenStop") {
            voice::walk::readStops().ask(request.number);
            output.send({{"id", id}, {"result", nullptr}});
            continue;
        }
        // A read of the whole window bound to an earlier read's window (`sameWindowAs`) reads that
        // window only if it is still the one in front; otherwise there is no screen to give.
        const auto window = GetForegroundWindow();
        if (!lastRead.admits(request, window)) {
            output.send({{"id", id}, {"result", nullptr}});
            continue;
        }
        reads.add({id, params, window, request.number, request.wholeWindow, GetTickCount64()});
    }
    // Output owns a process-lifetime writer thread, and the reads theirs; EOF ends the process with them.
    ExitProcess(0);
}
