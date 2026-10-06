// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "../../shared/privacy/ScreenExclusions.h"
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace voice {
struct PrivacyHidden {};
inline nlohmann::json hiddenScreen() { return {{"hidden", true}}; }
using PageHost = AddressHost;
inline PageHost hostOfAddress(const std::optional<std::string>& address) {
    if (!address) return {}; // Provider failed or does not establish whether a URI exists.
    return classifyAddress(*address);
}
struct ScreenExclusions : SharedScreenExclusions {
    using SharedScreenExclusions::SharedScreenExclusions;
    bool excludes(const PageHost& page) const {
        return excludesPage(page.kind == PageHost::Kind::unknown ? "unknown" :
            page.kind == PageHost::Kind::noHost ? "noHost" : "host", page.name);
    }
};
// Validate both policy arrays and resolve the native desktop identity before any
// remote app metadata or text access. Missing IDs cannot match an app exclusion.
template<class Target, class Identity, class Read>
nlohmann::json screenAccess(const nlohmann::json& params, Target target, Identity identity, Read read) {
    const ScreenExclusions exclusions(params);
    if (!target) return nullptr;
    const auto id = identity(target);
    if (id && !id->empty() && exclusions.excludesApp(*id)) return hiddenScreen();
    return read(target, exclusions);
}
}
