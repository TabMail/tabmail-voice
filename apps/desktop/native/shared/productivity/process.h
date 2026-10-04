// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <nlohmann/json.hpp>
#include <iostream>
#include <string>

namespace voice_productivity {
// One request per disposable process. The parent owns the total deadline and
// termination. Never print provider errors or partial results on failure.
template<class Operation> int serve(Operation operation) {
    try {
        std::string line;
        char ch;
        while (std::cin.get(ch) && ch != '\n') {
            if (line.size() >= 256 * 1024) return 1;
            line += ch;
        }
        auto output = operation(nlohmann::json::parse(line)).dump();
        if (output.size() > 1024 * 1024) return 1;
        std::cout << output << '\n';
        return 0;
    } catch (...) { std::cerr << "productivity request failed\n"; return 1; }
}
}
