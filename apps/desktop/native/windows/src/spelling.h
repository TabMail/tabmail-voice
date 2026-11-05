// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <windows.h>
#include <spellcheck.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <map>
#include <string>
#include <vector>
#include "com.h"
#include "dictionary_choice.h"
#include "text.h"
#include "../../shared/rust/VoiceCore.h"

namespace voice {
/// Which words are everyday words of the user's languages, by the Windows spell checker: the screen
/// terms' test (ADR-DESK-038, amended 2026-11-04). The shared core picks which of the checker's
/// languages serves each of the user's, without one that knows a word in no language
/// (`workingDictionaries`); the words are checked as given (the app sends them in lowercase). Called
/// on the helper's request thread only, which keeps COM, the factory and each language's checker for
/// the life of the process.
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
    const auto checker = [&](const std::string& language) {
        const auto tag = utf16(language);
        auto& created = checkers[tag];
        if (!created) require(factory->CreateSpellChecker(tag.c_str(), &created));
        return created.Get();
    };
    const auto knows = [](ISpellChecker* dictionary, const std::wstring& word) {
        ComPtr<IEnumSpellingError> errors;
        require(dictionary->Check(word.c_str(), &errors));
        ComPtr<ISpellingError> error;
        return errors->Next(&error) == S_FALSE;
    };
    const auto chosen = workingDictionaries(params.value("languages", nlohmann::json()), available,
        [&](const std::string& word, const std::string& language) { return knows(checker(language), utf16(word)); });
    std::vector<ISpellChecker*> dictionaries;
    for (const auto& language : chosen.at("dictionaries")) dictionaries.push_back(checker(language.get<std::string>()));
    nlohmann::json known = nlohmann::json::array();
    for (size_t index = 0; index < words.size(); ++index) {
        if (std::any_of(dictionaries.begin(), dictionaries.end(), [&](auto* dictionary) { return knows(dictionary, words[index]); }))
            known.push_back(params["words"][index]);
    }
    return {{"known", known}, {"unavailable", chosen.at("unavailable")}, {"dictionaries", dictionaries.size()}};
}
}
