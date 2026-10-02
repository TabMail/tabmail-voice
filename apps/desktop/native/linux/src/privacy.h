// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <glib.h>
#include <algorithm>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>
#include <stdexcept>

namespace voice {
struct PrivacyHidden {};
inline nlohmann::json hiddenScreen() { return {{"hidden", true}}; }
struct PageHost {
    enum class Kind { host, noHost, unknown };
    Kind kind = Kind::unknown;
    std::string name;
};
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
    if (address->empty()) return {PageHost::Kind::noHost, {}};
    if (address->size() > 32768 || address->find('\0') != std::string::npos) return {};
    GError* error = nullptr;
    auto uri = g_uri_parse(address->c_str(), G_URI_FLAGS_NONE, &error);
    if (error) g_error_free(error);
    if (!uri) return {};
    const auto scheme = g_uri_get_scheme(uri);
    const std::string name = scheme ? folded(scheme) : "";
    PageHost result;
    if (name == "http" || name == "https") {
        const auto host = g_uri_get_host(uri);
        if (host && *host) result = {PageHost::Kind::host, folded(host)};
    } else if (!name.empty()) result = {PageHost::Kind::host, name};
    g_uri_unref(uri);
    return result;
}
struct ScreenExclusions {
    std::vector<std::string> apps, hosts;
    explicit ScreenExclusions(const nlohmann::json& params)
        : apps(strings(params, "excludedAppIDs")), hosts(strings(params, "excludedHosts")) {}
    bool excludesApp(const std::string& id) const {
        const auto candidate = folded(id);
        return std::find(apps.begin(), apps.end(), candidate) != apps.end();
    }
    bool excludesHost(std::string host) const {
        host = folded(host);
        if (host.ends_with('.')) host.pop_back();
        for (auto site : hosts) {
            if (site.ends_with('.')) site.pop_back();
            if (site.empty()) continue;
            if (host == site || (host.size() > site.size() && host.ends_with("." + site))) return true;
        }
        return false;
    }
    bool excludes(const PageHost& page) const {
        return page.kind == PageHost::Kind::unknown ||
            (page.kind == PageHost::Kind::host && excludesHost(page.name));
    }
private:
    static std::vector<std::string> strings(const nlohmann::json& params, const char* key) {
        if (!params.is_object() || !params.contains(key) || !params[key].is_array())
            throw std::runtime_error("invalid screen policy");
        std::vector<std::string> result;
        for (const auto& value : params[key]) {
            if (!value.is_string()) throw std::runtime_error("invalid screen policy");
            const auto text = value.get<std::string>();
            if (text.size() > 32768) throw std::runtime_error("invalid screen policy");
            result.push_back(folded(text));
        }
        return result;
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
