// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "../../shared/rust/VoiceCore.h"
#include <glib.h>
#include <array>
#include <algorithm>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace voice {
// A rich editor's text (Chromium's contenteditable; Gmail's compose), whose paragraphs and links
// AT-SPI gives as embedded objects (U+FFFC), each an element with text of its own and its own caret
// and part of the selection. This walk sends each element's own text, caret, part of the selection,
// whether it is a block and its links, in the order it goes into them; the shared core places the
// caret, the selection and the blocks' breaks and joins them (`hypertext`, ADR-DESK-007, -054).
// Offsets count Unicode scalars, as AT-SPI does.
struct Hypertext {
    std::string text;
    size_t length = 0;
    std::optional<size_t> caret;
    std::optional<std::pair<size_t, size_t>> selection;
    // False when it holds more elements or text than the read may take: none of it is read.
    bool complete = true;
};

// `Source` gives, for an element: `text` (UTF-8; none when it holds more than the bytes it is given,
// before reading it), `caret` (-1 when the caret is elsewhere), `selection` (its part, or none),
// `links` (each link's offset and the element it stands for, in order; none when there are more than
// the elements it is given, before fetching any), `block` (whether the element
// starts a line of its own) and `same`. At most `limit` elements are visited, and at most `bytes` of
// text read; past either, the result is not complete.
// A link stands for an element of its own only where its text is an embedded object (U+FFFC) and
// that element is not one the read is already in. Elsewhere it is read as the text it is: GTK's
// labels give a link's text inline, and the label itself as its element. Where the caret and the
// selection's ends fall between the elements is the core's to decide (`hypertext`'s `elements`).
template<class Source>
Hypertext flattenHypertext(Source& source, const typename Source::Node& root, size_t limit, size_t bytes) {
    auto elements = nlohmann::json::array();
    size_t read = 0;
    bool fits = true;
    std::vector<typename Source::Node> path;
    const auto collect = [&](auto& self, const typename Source::Node& node) -> void {
        if (elements.size() >= limit) { fits = false; return; }
        const auto owned = source.text(node, bytes - read);
        if (!owned || (read += owned->size()) > bytes) { fits = false; return; }
        const size_t id = elements.size();
        const int caret = source.caret(node);
        const auto selected = source.selection(node);
        elements.push_back({{"text", *owned}, {"caret", caret < 0 ? nlohmann::json() : nlohmann::json(caret)},
                            {"selection", selected ? nlohmann::json::array({selected->first, selected->second}) : nlohmann::json()},
                            {"block", source.block(node)}, {"links", nlohmann::json::array()}});
        const auto found = source.links(node, limit - elements.size());
        if (!found) { fits = false; return; }
        // Each link's offset counts Unicode scalars; what is there says whether it is an object.
        std::vector<gunichar> scalars;
        for (const char* at = owned->c_str(); *at; at = g_utf8_next_char(at)) scalars.push_back(g_utf8_get_char(at));
        path.push_back(node);
        for (const auto& [offset, child] : *found) {
            const bool embedded = offset >= 0 && static_cast<size_t>(offset) < scalars.size() && scalars[static_cast<size_t>(offset)] == 0xFFFC;
            if (!embedded || std::any_of(path.begin(), path.end(), [&](const auto& on) { return source.same(on, child); })) {
                elements[id]["links"].push_back({offset, nullptr});
                continue;
            }
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
    const auto begin = g_utf8_offset_to_pointer(text.c_str(), static_cast<glong>(from));
    return std::string(begin, g_utf8_offset_to_pointer(begin, static_cast<glong>(to - from)));
}
}
