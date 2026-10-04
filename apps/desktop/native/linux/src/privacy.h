// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <glib.h>
#include "../../shared/privacy/ScreenExclusions.h"
#include <algorithm>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>
#include <stdexcept>

namespace voice {
struct PrivacyHidden {};
inline nlohmann::json hiddenScreen() { return {{"hidden", true}}; }
using PageHost = AddressHost;
inline std::string folded(const std::string& text) {
    if (text.find('\0') != std::string::npos || !g_utf8_validate(text.data(), static_cast<gssize>(text.size()), nullptr))
        throw std::runtime_error("invalid UTF-8");
    auto result = g_utf8_casefold(text.data(), static_cast<gssize>(text.size()));
    const std::string value = result;
    g_free(result);
    return value;
}
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
