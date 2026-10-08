// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>
#include "../rust/VoiceCore.h"

namespace voice {
// The screen read's whole reply, built by the shared core (ADR-DESK-054): the helper's fields (the
// app, window title, host, terminal program and focused role, with the blocks and the text around the
// caret, or a terminal's viewport request), the read's exclusion lists, its node count, time and stop
// reason. {"hidden":true} when the page read is excluded; throws when the core refuses.
inline nlohmann::json screenReply(nlohmann::json request, const nlohmann::json& exclusions, size_t nodes,
                                  uint64_t milliseconds, const std::string& stopped) {
    request["exclusions"] = exclusions;
    request["nodes"] = nodes;
    request["milliseconds"] = milliseconds;
    request["stopped"] = stopped.empty() ? nlohmann::json(nullptr) : nlohmann::json(stopped);
    return core::request(request, voice_core_screen_json);
}
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
    // Where its text starts and ends on screen: the box of its first line (or character) and of
    // its last. A piece that wraps has one frame over all its lines.
    std::optional<std::array<ContextFrame, 2>> ends = {};
};
class VisibleContext {
public:
    static size_t sourceLimit() { return core::request({{"limits", true}}, voice_core_context_json).at("screenBytes").get<size_t>(); }
    // What stands in for a part withheld for privacy.
    static std::string hiddenMarker() { return core::request({{"limits", true}}, voice_core_context_json).at("hiddenMarker").get<std::string>(); }
    explicit VisibleContext(const std::array<std::string, 3>& caret = {}) {
        const auto result = core::request({{"reserveCaret", caret}}, voice_core_context_json);
        bytes = result.at("used").get<size_t>();
        textBudgetFull = result.at("budgetFull").get<bool>();
    }
    bool textBudgetFull = false;
    size_t nodes = 0;
    std::string stopped;
    bool hasCaret = false;

    void append(ContextKind kind, std::string text, std::optional<ContextFrame> frame = {},
                std::optional<std::array<ContextFrame, 2>> ends = {}) {
        if (kind != ContextKind::caret) {
            const auto result = core::request({{"admit", text}, {"previous", blocks.empty() || blocks.back().kind == ContextKind::caret ? nlohmann::json(nullptr) : nlohmann::json(blocks.back().text)}, {"used", bytes}}, voice_core_context_json);
            text = result.at("text").get<std::string>();
            bytes = result.at("used").get<size_t>();
            textBudgetFull = result.at("budgetFull").get<bool>();
            if (!result.at("stop").is_null()) stopped = result.at("stop").get<std::string>();
            if (text.empty()) return;
        }
        if (kind == ContextKind::caret) hasCaret = true;
        blocks.push_back({kind, std::move(text), frame, {}, {}, ends});
    }
    void appendField(const std::array<std::string, 3>& parts, std::optional<ContextFrame> frame = {}) {
        const auto result = core::request({{"admitField", parts}, {"used", bytes}}, voice_core_context_json);
        const auto source = result.at("parts").get<std::array<std::string, 3>>();
        bytes = result.at("used").get<size_t>();
        textBudgetFull = result.at("budgetFull").get<bool>();
        if (!result.at("stop").is_null()) stopped = result.at("stop").get<std::string>();
        if (!source[1].empty()) blocks.push_back({ContextKind::field, source[1], frame, source});
    }
    void appendSemantic(ContextKind kind, const nlohmann::json& source, std::optional<ContextFrame> frame = {},
                        std::optional<std::array<ContextFrame, 2>> ends = {}) {
        auto block = source; block["kind"] = kinds[static_cast<size_t>(kind)];
        const auto previous = blocks.empty() ? nlohmann::json(nullptr) : blockJSON(blocks.back());
        const auto result = core::request({{"admitSemantic", block}, {"used", bytes}, {"previous", previous}}, voice_core_context_json);
        bytes = result.at("used").get<size_t>(); textBudgetFull = result.at("budgetFull").get<bool>();
        if (!result.at("stop").is_null()) stopped = result.at("stop").get<std::string>();
        const auto text = result.at("text").get<std::string>();
        if (!text.empty()) blocks.push_back({kind, text, frame, {}, std::optional<nlohmann::json>(std::in_place, result.at("runs")), ends});
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
    // This read's reply (`screenReply`), its blocks with the text around the caret.
    nlohmann::json reply(nlohmann::json fields, const std::array<std::string, 3>& caret, bool selectionUnavailable,
                         const nlohmann::json& exclusions, uint64_t milliseconds) const {
        fields["blocks"] = blocksJSON();
        fields["caret"] = caret;
        fields["selectionUnavailable"] = selectionUnavailable;
        return screenReply(std::move(fields), exclusions, nodes, milliseconds, stopped);
    }

private:
    size_t bytes = 0;
    std::vector<ContextBlock> blocks;
    static constexpr const char* kinds[] = {"text", "heading", "link", "row", "field", "caret"};
    static nlohmann::json blockJSON(const ContextBlock& block) {
        nlohmann::json value = {{"kind", kinds[static_cast<size_t>(block.kind)]}, {"text", block.text}};
        if (block.source) value["source"] = *block.source;
        if (block.runs) value["runs"] = *block.runs;
        if (block.frame) { const auto& f = *block.frame; value["frame"] = {f.x, f.y, f.width, f.height}; }
        if (block.ends) {
            value["ends"] = nlohmann::json::array();
            for (const auto& f : *block.ends) value["ends"].push_back({f.x, f.y, f.width, f.height});
        }
        return value;
    }
    nlohmann::json blocksJSON() const {
        auto result = nlohmann::json::array();
        for (const auto& block : blocks) result.push_back(blockJSON(block));
        return result;
    }
};
}
