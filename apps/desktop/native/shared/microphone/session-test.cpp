// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The shared session cases through the C++ wrapper both voice-microphone helpers (Windows, Linux) use,
// and that wrapper's request check (its cases are `../context/request-cases.json`'s).
#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>
#include "sessions.h"

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    std::ifstream file(argv[1]);
    const auto cases = nlohmann::json::parse(file);
    if (cases.size() != 10) { std::cerr << "unexpected case count\n"; return 1; }
    for (const auto& test : cases) {
        voice::MicrophoneSessions sessions;
        const auto name = test["name"].get<std::string>();
        for (const auto& step : test["steps"]) {
            const auto session = step["session"].get<int64_t>();
            const auto event = step["event"].get<std::string>();
            bool ok = true;
            if (event == "start") {
                const auto decision = sessions.start(session);
                const auto expected = step["decision"].get<std::string>();
                ok = expected == (decision == voice::MicrophoneSessions::Start::runs ? "runs"
                    : decision == voice::MicrophoneSessions::Start::endsProcess ? "endsProcess" : "skipped");
            } else if (event == "stop") {
                ok = sessions.stop(session) == step["stopped"].get<bool>();
            } else if (event == "failed") {
                sessions.failed(session);
            } else ok = false;
            const auto running = sessions.running();
            ok = ok && (step["running"].is_null() ? !running : running && *running == step["running"].get<int64_t>());
            ok = ok && sessions.mayPrepare() == step["mayPrepare"].get<bool>();
            if (!ok) { std::cerr << "failed: " << name << '\n'; return 1; }
        }
    }
    const auto start = voice::microphoneRequest("microphoneStart", {{"session", 2}, {"sampleRate", 16000}});
    const auto stop = voice::microphoneRequest("microphoneStop", {{"session", 3}});
    if (start.session != 2 || start.sampleRate != 16000 || stop.session != 3) { std::cerr << "request not passed on\n"; return 1; }
    for (const auto& [method, params] : std::initializer_list<std::pair<const char*, nlohmann::json>>{
             {"microphoneStart", {{"session", 0}, {"sampleRate", 16000}}}, {"microphoneStart", {{"session", 1}, {"sampleRate", 96001}}},
             {"microphoneStop", {{"session", -1}}}, {"microphoneStop", nlohmann::json::array()}}) {
        try { voice::microphoneRequest(method, params); std::cerr << "request not refused\n"; return 1; }
        catch (const std::runtime_error&) {}
    }
    std::cout << "shared microphone session cases passed\n";
}
