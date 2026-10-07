// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// voice-screen-reader.exe: reads the screen of the window in front, and does nothing else. A read
// may take as long as another app's UI Automation provider takes; in a process of its own it holds
// up no paste or recording, and the app ends the process when it no longer wants the read
// (`ScreenReader` in the app, ADR-DESK-053). One request at a time; EOF ends it.
#include <windows.h>
#include <nlohmann/json.hpp>
#include <iostream>
#include <stdexcept>
#include <string>
#include "accessibility.h"
#include "output.h"

using JSON = nlohmann::json;

int main(int argc, char**) {
    if (argc != 1) return 1;
    // Native geometry is in physical pixels; Electron converts it to display-independent points.
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    voice::Output output;
    voice::COM com;
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
        if (input["method"] != "readScreen") {
            output.send({{"id", id}, {"error", {{"message", "Windows native request failed"}}}});
            continue;
        }
        // The window in front as the request arrives: the read is of it, or of nothing.
        const HWND window = GetForegroundWindow();
        try {
            output.send({{"id", id}, {"result", voice::screenAccess(input.value("params", JSON::object()), window, voice::executableName,
                [](HWND target, const voice::ScreenExclusions& exclusions) {
                    voice::Automation automation(false);
                    return automation.readScreen(target, exclusions);
                })}});
        } catch (...) {
            // Never echo parameters, captured text, or native exception details into logs.
            output.send({{"id", id}, {"error", {{"message", "Windows accessibility request failed"}}}});
        }
    }
    // Output owns a process-lifetime writer thread; EOF ends the process with it.
    ExitProcess(0);
}
