// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The shared session cases through the C++ wrapper both voice-microphone helpers (Windows, Linux) use.
#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>
#include "sessions.h"

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    std::ifstream file(argv[1]);
    const auto cases = nlohmann::json::parse(file);
    if (cases.size() != 9) { std::cerr << "unexpected case count\n"; return 1; }
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
    std::cout << "shared microphone session cases passed\n";
}
