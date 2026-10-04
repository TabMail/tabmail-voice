// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "../rust/VoiceCore.h"

namespace voice {
struct AddressHost {
    enum class Kind { host, noHost, unknown };
    Kind kind = Kind::unknown;
    std::string name;
};
inline AddressHost classifyAddress(const std::string& address) {
    try {
        const auto result = core::request({{"address", address}}, voice_core_address_json);
        const auto kind = result.at("kind").get<std::string>();
        if (kind == "noHost") return {AddressHost::Kind::noHost, {}};
        if (kind == "host") return {AddressHost::Kind::host, result.at("host").get<std::string>()};
    } catch (...) { /* A failed classification cannot permit a provider read. */ }
    return {};
}
class SharedScreenExclusions {
    nlohmann::json policy;
    bool decision(const char* key, const std::string& value) const {
        auto input = policy;
        input[key] = value;
        return core::request(input, voice_core_policy_json).at(key).get<bool>();
    }
public:
    explicit SharedScreenExclusions(const nlohmann::json& params) {
        // Validate before the adapter acquires any provider metadata or text.
        if (!params.is_object() || !params.contains("excludedAppIDs") || !params.contains("excludedHosts"))
            throw std::runtime_error("invalid screen policy");
        policy = {{"excludedAppIDs", params["excludedAppIDs"]}, {"excludedHosts", params["excludedHosts"]}};
        core::request(policy, voice_core_policy_json);
    }
    bool excludesApp(const std::string& name) const { return decision("app", name); }
    bool excludesHost(const std::string& name) const { return decision("host", name); }
    bool excludesPage(const char* kind, const std::string& host) const {
        auto input = policy;
        input["page"] = kind;
        input["host"] = host;
        return core::request(input, voice_core_policy_json).at("page").get<bool>();
    }
};
}
