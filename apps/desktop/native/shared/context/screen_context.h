// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <algorithm>
#include <array>
#include <optional>
#include <string>
#include <vector>
#include "../rust/VoiceCore.h"

namespace voice::privacy { struct ScreenPrivacy; }

namespace voice {
inline std::string normalizedContextText(const std::string& text, const std::optional<std::string>& previous = {}) {
    return core::request({{"normalize", text}, {"previous", previous ? nlohmann::json(*previous) : nlohmann::json(nullptr)}},
        voice_core_context_json).at("text").get<std::string>();
}
// Formatting mirrors ScreenContext.swift. Coordinates share the provider’s window space;
// ratios and reading order are independent of the Windows display scale.
struct ContextFrame { double x, y, width, height; };
enum class ContextKind { text, heading, link, row, field, caret };
struct ContextBlock {
    ContextKind kind;
    std::string text;
    std::optional<ContextFrame> frame;
    std::optional<std::array<std::string, 3>> source = {};
    std::optional<nlohmann::json> runs = {};
};
class VisibleContext {
public:
    static size_t sourceLimit() { return core::request({{"limits", true}}, voice_core_context_json).at("screenBytes").get<size_t>(); }
    explicit VisibleContext(const std::array<std::string, 3>& caret = {}) {
        const auto result = core::request({{"reserveCaret", caret}}, voice_core_context_json);
        bytes = result.at("used").get<size_t>();
        textBudgetFull = result.at("budgetFull").get<bool>();
    }
    bool textBudgetFull = false;
    size_t nodes = 0;
    std::string stopped;
    bool hasCaret = false;

    void append(ContextKind kind, std::string text, std::optional<ContextFrame> frame = {}) {
        if (kind != ContextKind::caret) {
            const auto result = core::request({{"admit", text}, {"previous", blocks.empty() || blocks.back().kind == ContextKind::caret ? nlohmann::json(nullptr) : nlohmann::json(blocks.back().text)}, {"used", bytes}}, voice_core_context_json);
            text = result.at("text").get<std::string>();
            bytes = result.at("used").get<size_t>();
            textBudgetFull = result.at("budgetFull").get<bool>();
            if (textBudgetFull) stopped = "text budget";
            if (text.empty()) return;
        }
        if (kind == ContextKind::caret) hasCaret = true;
        blocks.push_back({kind, std::move(text), frame});
    }
    void appendField(const std::array<std::string, 3>& parts, std::optional<ContextFrame> frame = {}) {
        const auto result = core::request({{"admitField", parts}, {"used", bytes}}, voice_core_context_json);
        const auto source = result.at("parts").get<std::array<std::string, 3>>();
        bytes = result.at("used").get<size_t>();
        textBudgetFull = result.at("budgetFull").get<bool>();
        if (textBudgetFull) stopped = "text budget";
        if (!source[1].empty()) blocks.push_back({ContextKind::field, source[1], frame, source});
    }
    void appendSemantic(ContextKind kind, const nlohmann::json& source, std::optional<ContextFrame> frame = {}) {
        auto block = source; block["kind"] = kinds[static_cast<size_t>(kind)];
        const auto previous = blocks.empty() ? nlohmann::json(nullptr) : blockJSON(blocks.back());
        const auto result = core::request({{"admitSemantic", block}, {"used", bytes}, {"previous", previous}}, voice_core_context_json);
        bytes = result.at("used").get<size_t>(); textBudgetFull = result.at("budgetFull").get<bool>();
        if (textBudgetFull) stopped = "text budget";
        const auto text = result.at("text").get<std::string>();
        if (!text.empty()) blocks.push_back({kind, text, frame, {}, std::optional<nlohmann::json>(std::in_place, result.at("runs"))});
    }
    // Private staging transport for a field nested inside a semantic container.
    // These parts must still pass semantic admission and final shared redaction.
    std::vector<std::array<std::string, 3>> fieldSources() const {
        std::vector<std::array<std::string, 3>> result;
        for (const auto& block : blocks) {
            if (block.kind != ContextKind::field || !block.source || block.runs)
                throw std::runtime_error("invalid projected field staging");
            result.push_back(*block.source);
        }
        return result;
    }
    size_t count() const { return blocks.size(); }
    std::string render() const {
        return core::request({{"blocks", blocksJSON()}}, voice_core_context_json).at("rendered").get<std::string>();
    }

private:
    friend struct privacy::ScreenPrivacy;
    size_t bytes = 0;
    std::vector<ContextBlock> blocks;
    static constexpr const char* kinds[] = {"text", "heading", "link", "row", "field", "caret"};
    static nlohmann::json blockJSON(const ContextBlock& block) {
        nlohmann::json value = {{"kind", kinds[static_cast<size_t>(block.kind)]}, {"text", block.text}};
        if (block.source) value["source"] = *block.source;
        if (block.runs) value["runs"] = *block.runs;
        if (block.frame) { const auto& f = *block.frame; value["frame"] = {f.x, f.y, f.width, f.height}; }
        return value;
    }
    nlohmann::json blocksJSON() const {
        auto result = nlohmann::json::array();
        for (const auto& block : blocks) result.push_back(blockJSON(block));
        return result;
    }
    static ContextBlock blockFromJSON(const nlohmann::json& value) {
        if (value.contains("source") || value.contains("runs")) throw std::runtime_error("private source survived finalization");
        const auto kind = value.at("kind").get<std::string>();
        size_t index = 0;
        while (index < std::size(kinds) && kind != kinds[index]) ++index;
        if (index == std::size(kinds)) throw std::runtime_error("invalid context kind");
        ContextBlock block{static_cast<ContextKind>(index), value.at("text").get<std::string>(), {}};
        if (value.contains("frame") && !value.at("frame").is_null()) {
            const auto f = value.at("frame").get<std::array<double, 4>>();
            block.frame = ContextFrame{f[0], f[1], f[2], f[3]};
        }
        return block;
    }
};
}
