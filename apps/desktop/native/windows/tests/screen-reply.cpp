// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The shared screen-reply cases (`shared/context/screen-cases.json`), run through the C ABI this
// helper links and through the wrapper its screen reads use. Linux builds this file too.
#include "../../shared/context/screen_context.h"
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

using JSON = nlohmann::json;
static void expect(bool value, const std::string& message) {
    if (!value) throw std::runtime_error(message);
}

// The case's request split as a helper passes it: its fields, then the read's lists, node count,
// time and stop reason.
static JSON throughWrapper(JSON request) {
    const auto exclusions = request.at("exclusions");
    const auto nodes = request.at("nodes").get<size_t>();
    const auto milliseconds = request.at("milliseconds").get<uint64_t>();
    const auto stopped = request.contains("stopped") && request["stopped"].is_string() ? request["stopped"].get<std::string>() : std::string();
    for (const auto* key : {"exclusions", "nodes", "milliseconds", "stopped"}) request.erase(key);
    return voice::screenReply(request, exclusions, nodes, milliseconds, stopped);
}

static int run(int argc, char** argv) {
    expect(argc == 2, "screen corpus path required");
    std::ifstream file(argv[1]);
    const auto corpus = JSON::parse(file);
    unsigned refused = 0, answered = 0;
    for (const auto& item : corpus.at("cases")) {
        const auto name = item.at("name").get<std::string>();
        const auto& request = item.at("request");
        bool coreRefused = false;
        JSON core;
        try { core = voice::core::request(request, voice_core_screen_json); } catch (const std::exception&) { coreRefused = true; }
        if (item.value("refused", false)) {
            ++refused;
            expect(coreRefused, name + ": the core answered a refused case");
        } else {
            ++answered;
            expect(!coreRefused && core == item.at("expected"), name + ": the core's reply differs");
            expect(throughWrapper(request) == item.at("expected"), name + ": the wrapper's reply differs");
        }
    }
    expect(refused > 0 && answered > 0 && refused + answered == corpus.at("cases").size(), "every case run");
    return 0;
}

int main(int argc, char** argv) {
    try { return run(argc, argv); }
    catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
