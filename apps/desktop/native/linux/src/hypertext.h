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
// and part of the selection. This walk sends each element's own text in order, with where its caret
// and selection are and where a block element starts and ends; the shared core joins them
// (`hypertext`, ADR-DESK-007). Offsets count Unicode scalars, as AT-SPI does.
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
// `links` (each link's offset and the element it stands for, in order), `block` (whether the element
// starts a line of its own) and `same`. At most `limit` elements are visited, and at most `bytes` of
// text read; past either, the result is not complete.
// A link stands for an element of its own only where its text is an embedded object (U+FFFC) and
// that element is not one the read is already in. Elsewhere it is read as the text it is: GTK's
// labels give a link's text inline, and the label itself as its element.
template<class Source>
Hypertext flattenHypertext(Source& source, const typename Source::Node& root, size_t limit, size_t bytes) {
    auto parts = nlohmann::json::array();
    size_t visited = 0, read = 0;
    bool fits = true;
    std::vector<typename Source::Node> path;
    const auto mark = [&](const char* name) { parts.push_back({{"mark", name}}); };
    const auto emit = [&](auto& self, const typename Source::Node& node) -> void {
        if (++visited > limit) { fits = false; return; }
        const auto owned = source.text(node, bytes - read);
        if (!owned || (read += owned->size()) > bytes) { fits = false; return; }
        const std::string& text = *owned;
        const int caret = source.caret(node);
        const auto selected = source.selection(node);
        const auto links = source.links(node);
        std::string run;
        const auto flush = [&] { if (!run.empty()) { parts.push_back({{"text", run}}); run.clear(); } };
        size_t next = 0;
        int index = 0;
        path.push_back(node);
        for (const char* at = text.c_str(); *at; at = g_utf8_next_char(at), ++index) {
            const bool embedded = g_utf8_get_char(at) == 0xFFFC;
            while (next < links.size() && links[next].first == index && (!embedded ||
                   std::any_of(path.begin(), path.end(), [&](const auto& on) { return source.same(on, links[next].second); })))
                ++next;
            if (next < links.size() && links[next].first == index) {
                flush();
                const auto& child = links[next++].second;
                const bool block = source.block(child);
                if (block) mark("blockStart");
                // A caret before the element: Chromium gives the caret at the end of the text before
                // a link to the text holding it, at the link's object, and none to the link itself.
                if (caret == index && source.caret(child) < 0) mark("caret");
                // So is a selection's start or end there, at an element with no part of its own (an
                // image, or a link with no text), or an empty one.
                const auto part = selected && index >= selected->first && index < selected->second ? source.selection(child) : std::nullopt;
                const bool own = part && part->first < part->second;
                if (selected && index == selected->first && !own) mark("selectionStart");
                self(self, child);
                if (!fits) return;
                if (selected && index + 1 == selected->second && !own) mark("selectionEnd");
                if (block) mark("blockEnd");
                continue;
            }
            const bool chosen = selected && index >= selected->first && index < selected->second;
            if (caret == index) { flush(); mark("caret"); }
            if (chosen && index == selected->first) { flush(); mark("selectionStart"); }
            run.append(at, g_utf8_next_char(at));
            if (chosen && index + 1 == selected->second) { flush(); mark("selectionEnd"); }
        }
        flush();
        path.pop_back();
        if (next != links.size()) throw std::runtime_error("hypertext link outside its text");
        if (caret == index) mark("caret");
    };
    emit(emit, root);
    if (!fits) return Hypertext{{}, 0, std::nullopt, std::nullopt, false};
    const auto reply = core::request({{"hypertext", {{"parts", parts}}}}, voice_core_context_json);
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
