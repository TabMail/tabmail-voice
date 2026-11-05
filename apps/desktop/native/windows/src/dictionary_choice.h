// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <string>
#include <vector>
#include "../../shared/rust/VoiceCore.h"

namespace voice {
/// The shared core's choice of the system's dictionaries for the user's `languages`
/// (`{"dictionaries":[name…],"unavailable":[tag…],…}`), made again without each chosen one that
/// knows the core's word in no language (`madeUp`): such a dictionary tells no name from an everyday
/// word (ADR-DESK-038, amended 2026-11-05). `knows(word, name)` asks the system's dictionary `name`.
/// Each pass leaves out one more of `available`, so it ends.
template <typename Knows>
nlohmann::json workingDictionaries(const nlohmann::json& languages, nlohmann::json available, Knows&& knows) {
    while (true) {
        auto chosen = core::request({{"languages", languages}, {"available", available}}, voice_core_dictionaries_json);
        const auto madeUp = chosen.at("madeUp").get<std::string>();
        std::vector<std::string> refused;
        for (const auto& name : chosen.at("dictionaries"))
            if (knows(madeUp, name.get<std::string>())) refused.push_back(name.get<std::string>());
        if (refused.empty()) return chosen;
        nlohmann::json kept = nlohmann::json::array();
        for (const auto& name : available)
            if (std::find(refused.begin(), refused.end(), name.get<std::string>()) == refused.end()) kept.push_back(name);
        available = std::move(kept);
    }
}
}
