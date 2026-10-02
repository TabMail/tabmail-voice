// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <urlmon.h>
#include <wrl/client.h>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>
#include <limits>
#include <optional>
#include "../text.h"

namespace voice {
struct PageHost {
    enum class Kind { host, noHost, unknown };
    Kind kind = Kind::unknown;
    std::wstring name;
};
// Address parsing uses Windows' URL parser, never the page title or address-bar text.
inline PageHost hostOfAddress(const std::wstring& address) {
    if (address.empty()) return {PageHost::Kind::noHost, {}};
    if (address.size() > 32768 || address.find(L'\0') != std::wstring::npos) return {};
    Microsoft::WRL::ComPtr<IUri> uri;
    if (FAILED(CreateUri(address.c_str(), Uri_CREATE_CANONICALIZE, 0, &uri))) return {PageHost::Kind::noHost, {}};
    BSTR scheme = nullptr;
    if (FAILED(uri->GetSchemeName(&scheme))) return {};
    std::wstring name(scheme ? scheme : L"", scheme ? SysStringLen(scheme) : 0);
    SysFreeString(scheme);
    if (_wcsicmp(name.c_str(), L"http") == 0 || _wcsicmp(name.c_str(), L"https") == 0) {
        BSTR host = nullptr;
        if (FAILED(uri->GetHost(&host))) return {};
        name.assign(host ? host : L"", host ? SysStringLen(host) : 0);
        SysFreeString(host);
    }
    if (name.empty()) return {PageHost::Kind::noHost, {}};
    return {PageHost::Kind::host, std::move(name)};
}

struct ScreenExclusions {
    std::vector<std::wstring> appIDs, hosts;
    explicit ScreenExclusions(const nlohmann::json& params)
        : appIDs(strings(params, "excludedAppIDs")), hosts(strings(params, "excludedHosts")) {}
    bool excludesApp(const std::wstring& name) const {
        if (name.empty()) return false;
        for (const auto& id : appIDs) if (equal(name, id)) return true;
        return false;
    }
    bool excludesHost(std::wstring name) const {
        if (name.ends_with(L'.')) name.pop_back();
        if (name.empty()) return false;
        for (auto site : hosts) {
            if (site.ends_with(L'.')) site.pop_back();
            if (site.empty()) continue;
            if (equal(name, site)) return true;
            if (name.size() > site.size() && name[name.size() - site.size() - 1] == L'.' &&
                equal(name.substr(name.size() - site.size()), site)) return true;
        }
        return false;
    }
    bool excludes(const PageHost& page) const {
        return page.kind == PageHost::Kind::unknown ||
            (page.kind == PageHost::Kind::host && excludesHost(page.name));
    }
private:
    static bool equal(const std::wstring& a, const std::wstring& b) {
        return a.size() == b.size() && CompareStringOrdinal(a.data(), static_cast<int>(a.size()),
            b.data(), static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
    }
    static std::vector<std::wstring> strings(const nlohmann::json& params, const char* key) {
        if (!params.is_object() || !params.contains(key) || !params[key].is_array()) throw std::runtime_error("invalid screen policy");
        std::vector<std::wstring> result;
        for (const auto& item : params[key]) {
            if (!item.is_string()) throw std::runtime_error("invalid screen policy");
            const auto text = item.get<std::string>();
            if (text.size() > static_cast<size_t>(std::numeric_limits<int>::max())) throw std::runtime_error("invalid screen policy");
            if (text.empty()) { result.emplace_back(); continue; }
            const int length = static_cast<int>(text.size());
            const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), length, nullptr, 0);
            if (!count) throw std::runtime_error("invalid screen policy");
            std::wstring value(static_cast<size_t>(count), L'\0');
            if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), length, value.data(), count)) throw std::runtime_error("invalid screen policy");
            result.push_back(std::move(value));
        }
        return result;
    }
};
}
