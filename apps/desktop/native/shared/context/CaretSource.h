// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "../rust/VoiceCore.h"
#include <array>
#include <optional>
#include <vector>
#include <string_view>

namespace voice {
struct CaretSource {
    std::array<std::string, 3> parts;
    bool selectionUnavailable = false;
    static CaretSource unavailable() { return {{"", "[redacted]", ""}, true}; }
    static CaretSource fromJSON(const nlohmann::json& result) {
        return {result.at("parts").get<std::array<std::string, 3>>(), result.at("selectionUnavailable").get<bool>()};
    }
    // What starts at the caret, as the provider lays the text out: from it the core tells whether the
    // caret starts a paragraph or an empty line, whose break the text before it may not show.
    // `lineText`: the line's first bytes, none when it holds more than the core's `caretLineBytes`.
    struct CaretStarts { bool paragraph; bool line; std::optional<std::string> lineText; };
    // Where the provider starts each paragraph near the caret (byte offsets into the parts joined,
    // ascending), whose break the text may leave out, and whether the caret ends the line before
    // one starting at its offset rather than starting it.
    struct ParagraphStarts { std::vector<size_t> starts; bool caretEndsLine; };
    static CaretSource window(const std::array<std::string, 3>& parts, bool startKnown, bool endKnown, const std::optional<CaretStarts>& starts,
                              const std::optional<ParagraphStarts>& paragraphs = std::nullopt) {
        nlohmann::json request{{"parts", parts}, {"startKnown", startKnown}, {"endKnown", endKnown}};
        if (paragraphs) {
            request["paragraphStarts"] = paragraphs->starts;
            request["caretEndsLine"] = paragraphs->caretEndsLine;
        }
        if (starts) request["caretStarts"] = {{"paragraph", starts->paragraph}, {"line", starts->line}, {"lineText", starts->lineText ? nlohmann::json(*starts->lineText) : nlohmann::json(nullptr)}};
        return fromJSON(core::request({{"caretWindow", request}}, voice_core_context_json));
    }
};
// Scoped transport only. Rust decides every requested range and source budget.
enum class SourceOffsets { utf16, unicodeScalar };
enum class SourcePurpose { caret, field, visibleField, block };
struct FieldSource { std::string text; bool complete; };
struct FieldProjection { std::array<std::string, 3> parts; bool complete; };
class NativeSource {
public:
    NativeSource(size_t count, size_t start, size_t end, SourceOffsets offsets, SourcePurpose purpose = SourcePurpose::caret) {
        const auto create = purpose == SourcePurpose::block
            ? (offsets == SourceOffsets::utf16 ? voice_core_block_utf16_new : voice_core_block_scalar_new)
            : purpose == SourcePurpose::visibleField
            ? (offsets == SourceOffsets::utf16 ? voice_core_visible_field_utf16_new : voice_core_visible_field_scalar_new)
            : purpose == SourcePurpose::field
            ? (offsets == SourceOffsets::utf16 ? voice_core_field_utf16_new : voice_core_field_scalar_new)
            : (offsets == SourceOffsets::utf16 ? voice_core_source_utf16_new : voice_core_source_scalar_new);
        if (voice_core_abi_version() != 1 || create(count, start, end, &state) != 0 || !state)
            throw std::runtime_error("shared source core refused");
    }
    ~NativeSource() { voice_core_source_free(state); }
    NativeSource(const NativeSource&) = delete;
    NativeSource& operator=(const NativeSource&) = delete;
    std::optional<std::pair<size_t, size_t>> next() const {
        size_t start = 0, length = 0;
        if (voice_core_source_next(state, &start, &length) != 0) throw std::runtime_error("shared source core refused");
        if (!length) return std::nullopt;
        return std::pair{start, length};
    }
    void offer(const uint16_t* data, size_t length) {
        if (voice_core_source_utf16_offer(state, data, length) != 0) throw std::runtime_error("shared source core refused");
    }
    void offer(const std::string& text) {
        if (voice_core_source_utf8_offer(state, reinterpret_cast<const uint8_t*>(text.data()), text.size()) != 0)
            throw std::runtime_error("shared source core refused");
    }
    CaretSource finish() const { return CaretSource::fromJSON(result()); }
    FieldSource field() const {
        const auto value = result();
        return {value.at("text").get<std::string>(), value.at("complete").get<bool>()};
    }
    FieldProjection projectedField() const {
        const auto value = result();
        return {value.at("parts").get<std::array<std::string, 3>>(), value.at("complete").get<bool>()};
    }
private:
    nlohmann::json result() const {
        struct Reply { VoiceCoreBuffer value{}; ~Reply() { voice_core_buffer_free(value); } } reply;
        if (voice_core_source_finish(state, &reply.value) != 0 || !reply.value.data)
            throw std::runtime_error("shared source core refused");
        return nlohmann::json::parse(reply.value.data, reply.value.data + reply.value.length);
    }
private:
    VoiceSource* state = nullptr;
};
template<class Read> CaretSource readUtf16Caret(size_t count, size_t start, size_t end, Read&& read) {
    NativeSource source(count, start, end, SourceOffsets::utf16);
    while (const auto next = source.next()) {
        const auto [at, length] = *next;
        const auto text = read(at, at + length);
        // Copy native UTF-16 code units without decoding or clipping surrogate halves.
        const std::vector<uint16_t> units(text.begin(), text.end());
        source.offer(units.data(), units.size());
    }
    return source.finish();
}
template<class Read> CaretSource readScalarCaret(size_t count, size_t start, size_t end, Read&& read) {
    NativeSource source(count, start, end, SourceOffsets::unicodeScalar);
    while (const auto next = source.next()) {
        const auto [at, length] = *next;
        source.offer(read(at, at + length));
    }
    return source.finish();
}
template<class Read> FieldSource readScalarField(size_t count, size_t start, size_t end, Read&& read) {
    NativeSource source(count, start, end, SourceOffsets::unicodeScalar, SourcePurpose::field);
    while (const auto next = source.next()) {
        const auto [at, length] = *next;
        source.offer(read(at, at + length));
    }
    return source.field();
}
template<class Read> FieldSource readUtf16Field(size_t count, size_t start, size_t end, Read&& read) {
    NativeSource source(count, start, end, SourceOffsets::utf16, SourcePurpose::field);
    while (const auto next = source.next()) {
        const auto [at, length] = *next;
        const auto text = read(at, at + length);
        const std::vector<uint16_t> units(text.begin(), text.end());
        source.offer(units.data(), units.size());
    }
    return source.field();
}

// An already-received immutable native string is a complete source domain.
// The common collector owns downstream copies and incomplete-edge handling.
template<class Read> FieldSource readScalarBlock(size_t count, Read&& read) {
    NativeSource source(count, 0, count, SourceOffsets::unicodeScalar, SourcePurpose::block);
    while (const auto next = source.next()) source.offer(read(next->first, next->first + next->second));
    return source.field();
}

template<class View> FieldSource readUtf16Snapshot(const View& text) {
    static_assert(sizeof(typename View::value_type) == sizeof(uint16_t), "snapshot must use UTF-16 code units");
    NativeSource source(text.size(), 0, text.size(), SourceOffsets::utf16, SourcePurpose::block);
    while (const auto next = source.next()) {
        const auto part = text.substr(next->first, next->second);
        const std::vector<uint16_t> units(part.begin(), part.end());
        source.offer(units.data(), units.size());
    }
    return source.field();
}

template<class Read> FieldProjection readScalarVisibleField(size_t count, size_t start, size_t end, Read&& read) {
    NativeSource source(count, start, end, SourceOffsets::unicodeScalar, SourcePurpose::visibleField);
    while (const auto next = source.next()) {
        const auto [at, length] = *next;
        source.offer(read(at, at + length));
    }
    return source.projectedField();
}
template<class Read> FieldProjection readUtf16VisibleField(size_t count, size_t start, size_t end, Read&& read) {
    NativeSource source(count, start, end, SourceOffsets::utf16, SourcePurpose::visibleField);
    while (const auto next = source.next()) {
        const auto [at, length] = *next;
        const auto text = read(at, at + length);
        const std::vector<uint16_t> units(text.begin(), text.end());
        source.offer(units.data(), units.size());
    }
    return source.projectedField();
}

}
