// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <algorithm>
#include <optional>
#include <string>
#include <vector>

namespace voice::privacy { struct ScreenPrivacy; }

namespace voice {
// Formatting mirrors ScreenContext.swift. Coordinates are physical pixels;
// ratios and reading order are independent of the Windows display scale.
struct ContextFrame { double x, y, width, height; };
enum class ContextKind { text, heading, link, row, field, caret };
struct ContextBlock {
    ContextKind kind;
    std::string text;
    std::optional<ContextFrame> frame;
};
class VisibleContext {
public:
    static constexpr size_t maxBytes = 256 * 1024;
    size_t nodes = 0;
    std::string stopped;
    bool hasCaret = false;

    void append(ContextKind kind, std::string text, std::optional<ContextFrame> frame = {}) {
        const auto first = text.find_first_not_of(" \t\r\n");
        if (first == std::string::npos) return;
        text = text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
        if (!blocks.empty() && blocks.back().text == text) return;
        // Bound aggregate output as well as individual native reads. Never cut
        // a UTF-8 character when a provider supplies a large amount of text.
        const size_t remaining = maxBytes - bytes;
        if (text.size() > remaining) {
            size_t cut = remaining;
            while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xc0) == 0x80) --cut;
            text.resize(cut);
            stopped = "text budget";
        }
        if (text.empty()) return;
        bytes += text.size();
        if (kind == ContextKind::caret) hasCaret = true;
        blocks.push_back({kind, std::move(text), frame});
    }
    size_t count() const { return blocks.size(); }
    std::string render() const {
        std::string output;
        for (size_t index = 0; index < blocks.size(); ++index) {
            const auto& block = blocks[index];
            if (index > 0) output += separator(blocks[index - 1], block);
            switch (block.kind) {
                case ContextKind::heading: output += "## " + block.text; break;
                case ContextKind::link: output += "[" + block.text + "]"; break;
                case ContextKind::row: output += "| " + block.text; break;
                case ContextKind::field: output += lines(block.text, "> "); break;
                case ContextKind::caret: output += lines(block.text, "» "); break;
                default: output += block.text;
            }
        }
        return output;
    }
private:
    friend struct privacy::ScreenPrivacy;
    size_t bytes = 0;
    std::vector<ContextBlock> blocks;
    static bool inlineText(ContextKind kind) { return kind == ContextKind::text || kind == ContextKind::link; }
    static std::string separator(const ContextBlock& first, const ContextBlock& second) {
        if (!first.frame || !second.frame) return "\n";
        const auto& a = *first.frame;
        const auto& b = *second.frame;
        if (std::min({a.width, a.height, b.width, b.height}) <= 0) return "\n";
        const double overlap = std::min(a.y + a.height, b.y + b.height) - std::max(a.y, b.y);
        if (inlineText(first.kind) && inlineText(second.kind) && b.x >= a.x && overlap >= std::min(a.height, b.height) * 0.5) return " ";
        return b.y + b.height <= a.y ? "\n\n" : "\n";
    }
    static std::string lines(const std::string& text, const std::string& prefix) {
        std::string output = prefix;
        for (const char character : text) {
            output += character;
            if (character == '\n') output += prefix;
        }
        return output;
    }
};
}
