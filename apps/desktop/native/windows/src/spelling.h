// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <windows.h>
#include <spellcheck.h>
#include <nlohmann/json.hpp>
#include <map>
#include <string>
#include <vector>
#include "com.h"
#include "text.h"
#include "../../shared/rust/VoiceCore.h"

namespace voice {
/// Which words are everyday words of the user's languages, by the Windows spell checker: the screen
/// terms' test (ADR-DESK-038, amended 2026-11-04). The shared core picks which of the checker's
/// languages serves each of the user's; the words are checked as given (the app sends them in
/// lowercase). Called on the helper's request thread only, which keeps COM, the factory and each
/// language's checker for the life of the process.
inline nlohmann::json knownWords(const nlohmann::json& params) {
    if (!params.is_object() || !params.contains("words") || !params["words"].is_array()) throw std::runtime_error("knownWords needs words");
    std::vector<std::wstring> words;
    for (const auto& word : params["words"]) {
        if (!word.is_string()) throw std::runtime_error("knownWords needs words");
        words.push_back(utf16(word.get<std::string>()));
    }
    static COM com;
    static const ComPtr<ISpellCheckerFactory> factory = [] {
        ComPtr<ISpellCheckerFactory> created;
        require(CoCreateInstance(__uuidof(SpellCheckerFactory), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&created)));
        return created;
    }();
    static std::map<std::wstring, ComPtr<ISpellChecker>> checkers;
    nlohmann::json available = nlohmann::json::array();
    ComPtr<IEnumString> supported;
    require(factory->get_SupportedLanguages(&supported));
    LPOLESTR name = nullptr;
    while (supported->Next(1, &name, nullptr) == S_OK) {
        available.push_back(utf8(name));
        CoTaskMemFree(name);
    }
    const auto chosen = core::request({{"languages", params.value("languages", nlohmann::json())}, {"available", available}}, voice_core_dictionaries_json);
    std::vector<ISpellChecker*> dictionaries;
    for (const auto& language : chosen.at("dictionaries")) {
        const auto tag = utf16(language.get<std::string>());
        auto& checker = checkers[tag];
        if (!checker) require(factory->CreateSpellChecker(tag.c_str(), &checker));
        dictionaries.push_back(checker.Get());
    }
    nlohmann::json known = nlohmann::json::array();
    for (size_t index = 0; index < words.size(); ++index) {
        for (auto* checker : dictionaries) {
            ComPtr<IEnumSpellingError> errors;
            require(checker->Check(words[index].c_str(), &errors));
            ComPtr<ISpellingError> error;
            if (errors->Next(&error) == S_FALSE) {
                known.push_back(params["words"][index]);
                break;
            }
        }
    }
    return {{"known", known}, {"unavailable", chosen.at("unavailable")}};
}
}
