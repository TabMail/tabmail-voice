// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// voice-field-reader.exe: reads the focused field that correction learning watches after a paste,
// and does nothing else. A read may take as long as another app's UI Automation provider takes; in
// a process of its own it holds up no caret lookup, paste or recording, and the app ends the
// process when it no longer wants the read (`FieldReader` in the app, ADR-DESK-053). One request at
// a time; EOF ends it.
//
// - `frontmostApp` → `{window}` of the window in front, or null: the field the watch reads is in it.
// - `focusedFieldValue {window, maxLength, excludedAppIDs, excludedHosts}` → `{value}`.
#include <windows.h>
#include <nlohmann/json.hpp>
#include <iostream>
#include <stdexcept>
#include <string>
#include "accessibility.h"
#include "output.h"

using JSON = nlohmann::json;

namespace {

JSON handle(const std::string& method, const JSON& params) {
    if (method == "frontmostApp") {
        const HWND window = GetForegroundWindow();
        if (!window) return nullptr;
        return {{"window", reinterpret_cast<uintptr_t>(window)}};
    }
    // The field is read in the window the watch started on, and in no other.
    if (!params.is_object() || !params.contains("window") || !params["window"].is_number_unsigned()) {
        throw std::runtime_error("invalid target");
    }
    const auto window = reinterpret_cast<HWND>(params["window"].get<uintptr_t>());
    const auto limit = voice::core::request({{"field", {{"maxLength", params.value("maxLength", JSON())}}}}, voice_core_request_json)
                           .at("maxLength").get<uint64_t>();
    return voice::screenAccess(params, window, voice::executableName, [&](HWND target, const voice::ScreenExclusions& exclusions) {
        voice::Automation automation;
        return automation.fieldValue(target, static_cast<unsigned>(limit), exclusions);
    }, true);
}

}

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
        if (input["method"] != "frontmostApp" && input["method"] != "focusedFieldValue") {
            output.send({{"id", id}, {"error", {{"message", "Windows native request failed"}}}});
            continue;
        }
        try {
            output.send({{"id", id}, {"result", handle(input["method"].get<std::string>(), input.value("params", JSON::object()))}});
        } catch (...) {
            // Never echo parameters, captured text, or native exception details into logs.
            output.send({{"id", id}, {"error", {{"message", "Windows accessibility request failed"}}}});
        }
    }
    // Output owns a process-lifetime writer thread; EOF ends the process with it.
    ExitProcess(0);
}
