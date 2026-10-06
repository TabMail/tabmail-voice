// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The shared policy cases (`shared/privacy/policy-cases.json`), run through the C ABI this helper
// links and through the exclusion wrapper its screen reads use. Linux builds this file too.
#include "../../shared/privacy/ScreenExclusions.h"
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

using JSON = nlohmann::json;
static void expect(bool value, const std::string& message) {
    if (!value) throw std::runtime_error(message);
}

// What the wrapper answers for `input`, as the core's reply would put it; throws when it refuses.
// A null app or host is never asked (the helpers ask nothing for a missing identity), and a page
// is asked with its host, which the wrapper always has.
static JSON throughWrapper(const JSON& input) {
    const voice::SharedScreenExclusions exclusions(input);
    JSON result = JSON::object();
    if (input.contains("app") && input["app"].is_string()) result["app"] = exclusions.excludesApp(input["app"].get<std::string>());
    if (input.contains("host") && input["host"].is_string()) result["host"] = exclusions.excludesHost(input["host"].get<std::string>());
    if (input.contains("page") && (input["page"] != "host" || input.contains("host")))
        result["page"] = exclusions.excludesPage(input["page"].get<std::string>().c_str(), input.value("host", std::string()));
    return result;
}

static int run(int argc, char** argv) {
    expect(argc == 2, "policy corpus path required");
    std::ifstream file(argv[1]);
    const auto corpus = JSON::parse(file);
    unsigned refused = 0, answered = 0;
    for (const auto& item : corpus.at("cases")) {
        const auto name = item.at("name").get<std::string>();
        const auto& input = item.at("input");
        bool coreRefused = false, wrapperRefused = false;
        JSON core, wrapper;
        try { core = voice::core::request(input, voice_core_policy_json); } catch (const std::exception&) { coreRefused = true; }
        try { wrapper = throughWrapper(input); } catch (const std::exception&) { wrapperRefused = true; }
        if (item.value("refused", false)) {
            ++refused;
            expect(coreRefused, name + ": the core answered a refused case");
            // The one refusal the wrapper can't be asked: a page said to have a host, with none.
            expect(wrapperRefused || name == "missing page host", name + ": the wrapper answered a refused case");
        } else {
            ++answered;
            expect(!coreRefused && core == item.at("output"), name + ": the core's answer differs");
            expect(!wrapperRefused, name + ": the wrapper refused");
            for (const auto& [key, value] : wrapper.items())
                expect(item.at("output").contains(key) && item.at("output")[key] == value, name + ": the wrapper's " + key + " differs");
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
