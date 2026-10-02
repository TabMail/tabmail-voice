// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <windows.h>
#include <nlohmann/json.hpp>
#include "../text.h"

namespace voice::privacy {
// Identify the selected executable without loading or running it. Windows exclusions
// use its file name, matching the process identity used before a screen read.
inline nlohmann::json appInfo(const nlohmann::json& params) {
    if (!params.is_object() || !params.contains("path") || !params["path"].is_string()) throw std::runtime_error("invalid app path");
    const auto path = utf16(params["path"].get<std::string>());
    if (path.size() > 32767) throw std::runtime_error("invalid app path");
    const auto slash = path.find_last_of(L"\\/");
    const auto name = slash == std::wstring::npos ? path : path.substr(slash + 1);
    if (name.size() <= 4 || _wcsicmp(name.c_str() + name.size() - 4, L".exe") != 0) return nullptr;
    const DWORD attributes = GetFileAttributesW(path.c_str());
    DWORD type = 0;
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) ||
        !GetBinaryTypeW(path.c_str(), &type) || (type != SCS_32BIT_BINARY && type != SCS_64BIT_BINARY)) return nullptr;
    return {{"bundleIdentifier", utf8(name)}, {"name", utf8(name.substr(0, name.size() - 4))}, {"path", utf8(path)}};
}
}
