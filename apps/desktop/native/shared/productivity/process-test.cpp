// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "process.h"
#include <sstream>
#include <stdexcept>

void require(bool value) { if (!value) throw std::runtime_error("process contract failed"); }
template<class Operation> void check(std::string input, Operation operation, int status, std::string expected) {
    std::istringstream source(input);
    std::ostringstream output, errors;
    auto* oldInput = std::cin.rdbuf(source.rdbuf());
    auto* oldOutput = std::cout.rdbuf(output.rdbuf());
    auto* oldError = std::cerr.rdbuf(errors.rdbuf());
    const int actual = voice_productivity::serve(operation);
    std::cin.rdbuf(oldInput); std::cout.rdbuf(oldOutput); std::cerr.rdbuf(oldError);
    std::cin.clear();
    require(actual == status && output.str() == expected);
    require(errors.str().find("synthetic-private-error") == std::string::npos);
}
int main() {
    try {
        auto identity = [](auto const& request) { return request; };
        check("{\"text\":\"synthetic\"}\n", identity, 0, "{\"text\":\"synthetic\"}\n");
        check("invalid\n", identity, 1, "");
        check("{}\n", [](auto const&) -> nlohmann::json { throw std::runtime_error("synthetic-private-error"); }, 1, "");
        bool called = false;
        check(std::string(256 * 1024 + 1, ' '), [&](auto const&) { called = true; return nlohmann::json(); }, 1, "");
        require(!called);
        check(std::string(256 * 1024 - 2, ' ') + "{}\n", identity, 0, "{}\n");
        check("{}\n", [](auto const&) { return nlohmann::json(std::string(1024 * 1024, 'x')); }, 1, "");
        std::cout << "PRODUCTIVITY_PROCESS_PASS 6 cases\n";
    } catch (...) { return 1; }
}
