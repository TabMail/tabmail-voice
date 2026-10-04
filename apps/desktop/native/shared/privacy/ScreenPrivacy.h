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
    static std::u16string decode(const std::string& text) { return decodeUtf8(text); }
    static std::string encode(const std::u16string& text) { return encodeUtf16(text); }
    static std::string redact(const std::string& text) { return encode(Redactor::redact(decode(text))); }
    static bool apply(VisibleContext& context, std::array<std::string, 3>& caret) {
        try {
            const auto result = core::request({{"blocks", context.blocksJSON()}, {"caret", caret}}, voice_core_context_json);
            auto changedCaret = result.at("caret").get<std::array<std::string, 3>>();
            std::vector<ContextBlock> blocks;
            size_t bytes = 0;
            for (const auto& value : result.at("blocks")) {
                blocks.push_back(VisibleContext::blockFromJSON(value));
                bytes += blocks.back().text.size();
            }
            const bool changed = result.at("selectionRedacted").get<bool>();
            if (result.at("truncated").get<bool>() && context.stopped.empty()) context.stopped = "text budget";
            caret = std::move(changedCaret);
            context.blocks = std::move(blocks);
            context.bytes = bytes;
            return changed;
        } catch (...) { throw std::runtime_error("screen finalization refused"); }
    }
};
}
