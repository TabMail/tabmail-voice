// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#ifdef _WIN32
#include <icu.h>
#else
#include <unicode/ustring.h>
#include <unicode/uchar.h>
#endif
#include <algorithm>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include "../rust/VoiceCore.h"

namespace voice::privacy {
using Lines = std::vector<std::vector<std::u16string>>;
inline constexpr std::u16string_view placeholder = u"[redacted]";
// ICU remains for OS string conversion only; matching is exclusively Rust.
inline std::u16string decodeUtf8(const std::string& text) {
        if (text.empty()) return {};
        if (text.size() > static_cast<size_t>(std::numeric_limits<int32_t>::max())) throw std::runtime_error("invalid text");
        UErrorCode error = U_ZERO_ERROR;
        int32_t count = 0;
        u_strFromUTF8(nullptr, 0, &count, text.data(), static_cast<int32_t>(text.size()), &error);
        if (error != U_BUFFER_OVERFLOW_ERROR) throw std::runtime_error("invalid UTF-8");
        error = U_ZERO_ERROR;
        std::u16string result(static_cast<size_t>(count), u'\0');
        u_strFromUTF8(result.data(), count, nullptr, text.data(), static_cast<int32_t>(text.size()), &error);
        if (U_FAILURE(error)) throw std::runtime_error("invalid UTF-8");
        return result;
    }
inline std::string encodeUtf16(const std::u16string& text) {
        if (text.empty()) return {};
        if (text.size() > static_cast<size_t>(std::numeric_limits<int32_t>::max())) throw std::runtime_error("invalid text");
        UErrorCode error = U_ZERO_ERROR;
        int32_t count = 0;
        u_strToUTF8(nullptr, 0, &count, text.data(), static_cast<int32_t>(text.size()), &error);
        if (error != U_BUFFER_OVERFLOW_ERROR) throw std::runtime_error("invalid UTF-16");
        error = U_ZERO_ERROR;
        std::string result(static_cast<size_t>(count), '\0');
        u_strToUTF8(result.data(), count, nullptr, text.data(), static_cast<int32_t>(text.size()), &error);
        if (U_FAILURE(error)) throw std::runtime_error("invalid UTF-16");
        return result;
    }

class Redactor {
public:
    static Lines redact(const Lines& lines) {
        if (voice_core_abi_version() != 1) throw std::runtime_error("redaction ABI mismatch");
        auto request = nlohmann::json::array();
        for (const auto& line : lines) {
            auto parts = nlohmann::json::array();
            for (const auto& part : line) parts.push_back(encodeUtf16(part));
            request.push_back(std::move(parts));
        }
        try {
            const auto result = core::request(request, voice_core_redact_json);
            if (!result.is_array() || result.size() != lines.size()) throw std::runtime_error("shape");
            Lines output;
            for (size_t index = 0; index < result.size(); ++index) {
                const auto& row = result[index];
                if (!row.is_array() || row.size() != lines[index].size()) throw std::runtime_error("shape");
                std::vector<std::u16string> parts;
                for (const auto& value : row) parts.push_back(decodeUtf8(value.get<std::string>()));
                output.push_back(std::move(parts));
            }
            return output;
        } catch (...) { throw std::runtime_error("invalid redaction reply"); }
    }
    static std::u16string redact(const std::u16string& text) { return redact(Lines{{text}})[0][0]; }
};
}
