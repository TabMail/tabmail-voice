// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "../rust/VoiceCore.h"
#include <array>
#include <algorithm>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace voice {
// A rich editor's text (Chromium's contenteditable, Gmail's compose; Firefox's, and a code editor's
// lines), whose paragraphs and links AT-SPI and IAccessible2 give as embedded objects (U+FFFC), each
// an element with text of its own and its own caret and part of the selection. This walk sends each element's own text, caret, part of the selection,
// whether it is a block and its links, in the order it goes into them; the shared core places the
// caret, the selection and the blocks' breaks and joins them (`hypertext`, ADR-DESK-007, -054).
// Offsets count Unicode scalars, as AT-SPI does (Windows counts IAccessible2's UTF-16 units over).
// The bytes of the UTF-8 sequence starting at `at` (the text is well formed: the provider's, or the core's).
inline size_t utf8Width(const std::string& text, size_t at) {
    const auto lead = static_cast<unsigned char>(text[at]);
    const size_t width = lead < 0x80 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4;
    return std::min(width, text.size() - at);
}
// The text's Unicode scalars, in order.
inline std::vector<char32_t> unicodeScalars(const std::string& text) {
    std::vector<char32_t> scalars;
    for (size_t at = 0; at < text.size();) {
        const size_t width = utf8Width(text, at);
        char32_t value = static_cast<unsigned char>(text[at]) & (width == 1 ? 0x7F : width == 2 ? 0x1F : width == 3 ? 0x0F : 0x07);
        for (size_t next = 1; next < width; ++next) value = (value << 6) | (static_cast<unsigned char>(text[at + next]) & 0x3F);
        scalars.push_back(value);
        at += width;
    }
    return scalars;
}

struct Hypertext {
    std::string text;
    size_t length = 0;
    std::optional<size_t> caret;
    std::optional<std::pair<size_t, size_t>> selection;
    // False when it holds more text than the read may take, or is malformed: none of it is read.
    bool complete = true;
};

// `Source` gives, for an element: `text` (UTF-8; none when it holds more than the bytes it is given,
// before reading it), `caret` (-1 when the caret is elsewhere), `selection` (its part, or none),
// `links` (each link's offset and the element it stands for, in order; none when there are more than
// the count it is given, before fetching any), `block` (whether the element starts a line of its
// own), `same` and `stopped` (whether the read was asked to stop, `readScreenStop`). At most `bytes`
// of text are read, objects included, and elements nested at most `depth` deep; past either, or
// once the read is asked to stop, the result is not complete. However many elements that text
// holds, every one is read: a link sits on a character of its element's text, so an element is
// asked for no more links than it has characters, and the bytes bound the elements. With no
// element budget, a stop is looked for at each element, so a stopped screen read answers at once
// with what it already has (ADR-DESK-053), and the depth bounds the walk's recursion (#361).
// A link stands for an element of its own only where its text is an embedded object (U+FFFC) and
// that element is not one the read is already in. Elsewhere it is read as the text it is: GTK's
// labels give a link's text inline, and the label itself as its element. Where the caret and the
// selection's ends fall between the elements is the core's to decide (`hypertext`'s `elements`).
template<class Source>
Hypertext flattenHypertext(Source& source, const typename Source::Node& root, size_t bytes, size_t depth) {
    auto elements = nlohmann::json::array();
    size_t read = 0;
    bool fits = true;
    std::vector<typename Source::Node> path;
    const auto collect = [&](auto& self, const typename Source::Node& node) -> void {
        if (source.stopped()) { fits = false; return; }
        const auto owned = source.text(node, bytes - read);
        if (!owned || (read += owned->size()) > bytes) { fits = false; return; }
        const size_t id = elements.size();
        const int caret = source.caret(node);
        const auto selected = source.selection(node);
        elements.push_back({{"text", *owned}, {"caret", caret < 0 ? nlohmann::json() : nlohmann::json(caret)},
                            {"selection", selected ? nlohmann::json::array({selected->first, selected->second}) : nlohmann::json()},
                            {"block", source.block(node)}, {"links", nlohmann::json::array()}});
        // Each link's offset counts Unicode scalars; what is there says whether it is an object.
        const auto scalars = unicodeScalars(*owned);
        const auto found = source.links(node, scalars.size());
        if (!found) { fits = false; return; }
        path.push_back(node);
        for (const auto& [offset, child] : *found) {
            const bool embedded = offset >= 0 && static_cast<size_t>(offset) < scalars.size() && scalars[static_cast<size_t>(offset)] == 0xFFFC;
            if (!embedded || std::any_of(path.begin(), path.end(), [&](const auto& on) { return source.same(on, child); })) {
                elements[id]["links"].push_back({offset, nullptr});
                continue;
            }
            // `path` holds the elements the read is in: the child is that many levels deep.
            if (path.size() > depth) { fits = false; return; }
            elements[id]["links"].push_back({offset, elements.size()});
            self(self, child);
            if (!fits) return;
        }
        path.pop_back();
    };
    collect(collect, root);
    if (!fits) return Hypertext{{}, 0, std::nullopt, std::nullopt, false};
    const auto reply = core::request({{"hypertext", {{"elements", elements}}}}, voice_core_context_json);
    Hypertext flat{reply.at("text").get<std::string>(), reply.at("length").get<size_t>(), std::nullopt, std::nullopt};
    if (!reply.at("caret").is_null()) flat.caret = reply.at("caret").get<size_t>();
    if (!reply.at("selection").is_null()) {
        const auto range = reply.at("selection").get<std::array<size_t, 2>>();
        flat.selection = std::pair{range[0], range[1]};
    }
    return flat;
}

// A Unicode-scalar slice of UTF-8 text, as AT-SPI ranges count.
inline std::string scalarSlice(const std::string& text, size_t from, size_t to) {
    if (from >= to) return {};
    size_t at = 0, index = 0;
    for (; at < text.size() && index < from; ++index) at += utf8Width(text, at);
    const size_t begin = at;
    for (; at < text.size() && index < to; ++index) at += utf8Width(text, at);
    return text.substr(begin, at - begin);
}
}
