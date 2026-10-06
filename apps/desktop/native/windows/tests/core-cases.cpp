// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A shared case corpus run through the C ABI this helper links: `core-cases request
// request-cases.json` (a field read's bound and reply, a paste's text and deadline) or `core-cases
// viewport surface-cases.json` (a terminal surface's runs, selection and caret). Linux builds this
// file too.
#include "../../shared/rust/VoiceCore.h"
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <map>
#include <string>

using JSON = nlohmann::json;
static void expect(bool value, const std::string& message) {
    if (!value) throw std::runtime_error(message);
}

static int run(int argc, char** argv) {
    expect(argc == 3, "operation and corpus path required");
    const std::map<std::string, voice::core::Operation> operations{{"request", voice_core_request_json}, {"viewport", voice_core_viewport_json}};
    const auto operation = operations.find(argv[1]);
    expect(operation != operations.end(), "unknown operation");
    std::ifstream file(argv[2]);
    const auto corpus = JSON::parse(file);
    unsigned refused = 0, answered = 0;
    for (const auto& item : corpus.at("cases")) {
        const auto name = item.at("name").get<std::string>();
        bool coreRefused = false;
        JSON reply;
        try { reply = voice::core::request(item.at("request"), operation->second); } catch (const std::exception&) { coreRefused = true; }
        if (item.value("refused", false)) {
            ++refused;
            expect(coreRefused, name + ": the core answered a refused case");
        } else {
            ++answered;
            expect(!coreRefused && reply == item.at("expected"), name + ": the core's reply differs");
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
