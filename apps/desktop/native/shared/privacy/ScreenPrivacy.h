// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "Redactor.h"
#include "../context/screen_context.h"
#ifndef _WIN32
#include <unicode/ustring.h>
#endif
#include <array>

namespace voice::privacy {
// Keep the native screen read's blocks and caret portions together until redaction,
// then render. Formatting markers must never break a secret before it is matched.
struct ScreenPrivacy {
    static std::u16string decode(const std::string& text) {
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
    static std::string encode(const std::u16string& text) {
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
    static std::string redact(const std::string& text) { return encode(Redactor::redact(decode(text))); }
    static bool apply(VisibleContext& context, std::array<std::string, 3>& caret) {
        Lines lines;
        size_t caretIndex = context.blocks.size();
        const std::vector<std::u16string> around{decode(caret[0]), decode(caret[1]), decode(caret[2])};
        for (size_t index = 0; index < context.blocks.size(); ++index) {
            if (context.blocks[index].kind == ContextKind::caret) { lines.push_back(around); caretIndex = index; }
            else lines.push_back({decode(context.blocks[index].text)});
        }
        if (caretIndex == context.blocks.size()) lines.push_back(around);
        const auto redacted = Redactor::redact(lines);
        const auto& selection = redacted[caretIndex][1];
        const bool changed = selection != around[1];
        const bool blank = std::all_of(selection.begin(), selection.end(), [](char16_t ch) { return u_isUWhiteSpace(ch) != 0; });
        caret = {encode(redacted[caretIndex][0]), encode(blank && changed ? std::u16string(placeholder) : selection), encode(redacted[caretIndex][2])};
        std::vector<ContextBlock> blocks;
        for (size_t index = 0; index < context.blocks.size(); ++index) {
            auto block = std::move(context.blocks[index]);
            if (block.kind == ContextKind::caret) {
                block.text = caret[0] + "‸" + caret[1] + (caret[1].empty() ? "" : "‸") + caret[2];
            } else {
                block.text = encode(redacted[index][0]);
                if (block.text.empty()) continue;
            }
            blocks.push_back(std::move(block));
        }
        context.blocks = std::move(blocks);
        context.bytes = 0;
        for (const auto& block : context.blocks) context.bytes += block.text.size();
        return changed;
    }
};
}
