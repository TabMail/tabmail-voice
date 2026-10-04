// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>
#include <limits>
#include <optional>
#include "../text.h"
#include "../../../shared/privacy/ScreenExclusions.h"

namespace voice {
struct PageHost {
    enum class Kind { host, noHost, unknown };
    Kind kind = Kind::unknown;
    std::wstring name;
};
// Native acquisition and UTF-16 validation surround shared URL classification.
inline PageHost hostOfAddress(const std::wstring& address) {
    if (address.size() > 32768 || address.find(L'\0') != std::wstring::npos) return {};
    try {
        const auto result = classifyAddress(utf8(address));
        if (result.kind == AddressHost::Kind::noHost) return {PageHost::Kind::noHost, {}};
        if (result.kind == AddressHost::Kind::host) return {PageHost::Kind::host, utf16(result.name)};
    } catch (...) { /* Invalid native text remains unknown. */ }
    return {};
}

struct ScreenExclusions : SharedScreenExclusions {
    using SharedScreenExclusions::SharedScreenExclusions;
    bool excludesApp(const std::wstring& name) const {
        return SharedScreenExclusions::excludesApp(utf8(name));
    }
    bool excludesHost(const std::wstring& name) const {
        return SharedScreenExclusions::excludesHost(utf8(name));
    }
    bool excludes(const PageHost& page) const {
        return excludesPage(page.kind == PageHost::Kind::unknown ? "unknown" :
            page.kind == PageHost::Kind::noHost ? "noHost" : "host", utf8(page.name));
    }
};
}
