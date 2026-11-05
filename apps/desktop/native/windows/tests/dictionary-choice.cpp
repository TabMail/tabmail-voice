// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/dictionary_choice.h"
#include <iostream>

using namespace voice;
static void expect(bool ok, const char* name) { if (!ok) throw std::runtime_error(name); }
// A dictionary that knows a word in no language tells no name from an everyday word (Ubuntu's
// Ukrainian takes every word in Latin letters): its language's next one serves, and a language with
// no other has none. Here en-GB and la know every word, en only its own.
int main() {
    try {
        std::vector<std::string> asked;
        const auto knows = [&](const std::string& word, const std::string& name) {
            asked.push_back(name);
            return name == "en-GB" || name == "la" || word == "colour";
        };
        const auto chosen = workingDictionaries(nlohmann::json{"en-GB", "la"}, nlohmann::json{"en", "en-GB", "la"}, knows);
        expect(chosen.at("dictionaries") == nlohmann::json{"en"}, "a dictionary knowing a word in no language gives way to its language's next");
        expect(chosen.at("unavailable") == nlohmann::json{"la"}, "a language whose only dictionary knows a word in no language has none");
        expect(std::count(asked.begin(), asked.end(), "en") == 1, "a dictionary is asked once per choice it is in");
        const auto every = workingDictionaries(nlohmann::json{"en-US"}, nlohmann::json{"en-US"}, [](const std::string&, const std::string&) { return false; });
        expect(every.at("dictionaries") == nlohmann::json{"en-US"} && every.at("unavailable").empty(), "a dictionary that knows no word in no language serves");
        const auto none = workingDictionaries(nlohmann::json{"en-US"}, nlohmann::json{"en-US", "en-GB"}, [](const std::string&, const std::string&) { return true; });
        expect(none.at("dictionaries").empty() && none.at("unavailable") == nlohmann::json{"en-US"}, "dictionaries that all know one serve none, and the choice ends");
        std::cout << "dictionary choice passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << "\n";
        return 1;
    }
}
