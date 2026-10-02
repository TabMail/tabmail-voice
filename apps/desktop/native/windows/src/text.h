// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <windows.h>
#include <string>
#include <stdexcept>

namespace voice {
inline std::wstring utf16(const std::string& value) {
    if (value.empty() || value.size() > 512 * 1024 || value.find('\0') != std::string::npos) throw std::runtime_error("invalid paste text");
    const auto size = static_cast<int>(value.size());
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), size, nullptr, 0);
    if (!count) throw std::runtime_error("text conversion failed");
    std::wstring result(static_cast<size_t>(count), L'\0');
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), size, result.data(), count)) throw std::runtime_error("text conversion failed");
    return result;
}
inline std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    if (value.size() > 1024 * 1024) throw std::runtime_error("text too long");
    const auto size = static_cast<int>(value.size());
    const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), size, nullptr, 0, nullptr, nullptr);
    if (!count) throw std::runtime_error("text conversion failed");
    std::string result(static_cast<size_t>(count), '\0');
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), size, result.data(), count, nullptr, nullptr)) {
        throw std::runtime_error("text conversion failed");
    }
    return result;
}
}
