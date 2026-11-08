// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <oleacc.h>
#include "../vendor/ia2/Accessible2.h"
#include "../vendor/ia2/AccessibleHypertext.h"
#include "com.h"
#include "text.h"
#include "../../shared/context/hypertext.h"
#include "../../shared/context/walk.h"
#include <algorithm>
#include <array>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace voice {
// A rich editor's elements through IAccessible2, for the shared walk (`flattenHypertext`), as
// Linux reads them through AT-SPI: Firefox and Chromium give each paragraph, a code editor's
// line, a link or an image as an embedded object (U+FFFC) in its parent's text, with text, a caret
// and a part of the selection of its own. IAccessible2 counts UTF-16 units; the walk and the core
// count Unicode scalars, so each element's offsets are counted over in its own text.
// Each element read keeps its size, caret and selection as they were when its text was read; a read
// is one only when every one is still so after the last (`unchanged`), as the field's own are
// checked. The elements' attributes, together, have a budget of their own, as many UTF-16 units
// as the read has bytes (`attributeUnits`).
struct AccessibleHypertextSource {
    struct Node {
        ComPtr<IUnknown> element;
        // None for an element with no text (an image): it reads as empty, as on Linux.
        ComPtr<IAccessibleText> text;
        // The element's text as the walk read it, which its offsets are counted in.
        std::shared_ptr<std::wstring> units = std::make_shared<std::wstring>();
    };

    explicit AccessibleHypertextSource(size_t attributeUnits) : attributesLeft(attributeUnits) {}

    static Node nodeOf(IUnknown* element) {
        Node result;
        require(element->QueryInterface(IID_PPV_ARGS(&result.element)));
        if (FAILED(element->QueryInterface(IID_PPV_ARGS(&result.text)))) result.text.Reset();
        return result;
    }

    // Whether the text holds elements of its own: a rich editor's, read through them.
    static bool hasLinks(IAccessibleText* text) {
        ComPtr<IAccessibleHypertext> links;
        if (FAILED(text->QueryInterface(IID_PPV_ARGS(&links))) || !links) return false;
        long count = 0;
        require(links->get_nHyperlinks(&count));
        return count > 0;
    }

    std::optional<std::string> text(const Node& node, size_t bytes) {
        if (!node.text) return std::string();
        const auto before = state(node.text.Get());
        const long count = before[0];
        if (count < 0) throw std::runtime_error("invalid hypertext count");
        // UTF-8 takes at least a byte for each UTF-16 unit: more of them than `bytes` are not read.
        if (static_cast<size_t>(count) > bytes) return {};
        read.emplace_back(node.text, before);
        *node.units = range(node.text.Get(), 0, count);
        return utf8(*node.units);
    }
    // Whether every element read still has the size, caret and selection it had when its text was.
    bool unchanged() const {
        return std::all_of(read.begin(), read.end(), [](const auto& each) { return state(each.first.Get()) == each.second; });
    }
    // What a text says of its size, caret and selection, raw: the caret of a rich editor's field can
    // be in none of its own text (Firefox's, on an empty line).
    static std::array<long, 5> state(IAccessibleText* text) {
        long length = 0, caret = -1, count = 0, start = -1, end = -1;
        require(text->get_nCharacters(&length));
        if (FAILED(text->get_caretOffset(&caret))) throw std::runtime_error("accessible caret unavailable");
        require(text->get_nSelections(&count));
        if (count == 1) require(text->get_selection(0, &start, &end));
        return {length, caret, count, start, end};
    }
    // One COM object is one element, whichever interface or wrapper it is reached through.
    bool same(const Node& first, const Node& second) {
        return first.element.Get() == second.element.Get();
    }
    // A screen read the app stopped (the field reader's reads have no number, never stopped).
    bool stopped() { return walk::readStops().asked(); }
    int caret(const Node& node) {
        if (!node.text) return -1;
        long offset = -1;
        const HRESULT status = node.text->get_caretOffset(&offset);
        if (FAILED(status)) throw std::runtime_error("hypertext caret unavailable");
        // S_FALSE, or -1: the caret is in no text of this element's.
        if (status == S_FALSE || offset < 0) return -1;
        return static_cast<int>(scalars(*node.units, offset));
    }
    std::optional<std::pair<int, int>> selection(const Node& node) {
        if (!node.text) return {};
        long count = 0;
        require(node.text->get_nSelections(&count));
        if (count == 0) return {};
        if (count != 1) throw std::runtime_error("hypertext selection count");
        long start = -1, end = -1;
        require(node.text->get_selection(0, &start, &end));
        if (start < 0 || end < start) throw std::runtime_error("hypertext selection");
        return std::pair{static_cast<int>(scalars(*node.units, start)), static_cast<int>(scalars(*node.units, end))};
    }
    std::optional<std::vector<std::pair<int, Node>>> links(const Node& node, size_t most) {
        std::vector<std::pair<int, Node>> result;
        ComPtr<IAccessibleHypertext> links;
        if (!node.text || FAILED(node.text->QueryInterface(IID_PPV_ARGS(&links))) || !links) return result;
        long count = 0;
        require(links->get_nHyperlinks(&count));
        if (count < 0) throw std::runtime_error("hypertext link count");
        if (static_cast<size_t>(count) > most) return {};
        for (long index = 0; index < count; ++index) {
            ComPtr<IAccessibleHyperlink> link;
            require(links->get_hyperlink(index, &link));
            long start = -1;
            if (!link) throw std::runtime_error("hypertext link unavailable");
            require(link->get_startIndex(&start));
            if (start < 0) throw std::runtime_error("hypertext link unavailable");
            // The link is its element: Firefox and Chromium give the element itself.
            result.emplace_back(static_cast<int>(scalars(*node.units, start)), nodeOf(link.Get()));
        }
        std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
        return result;
    }
    // A block element starts a line of its own; a link or image joins its line.
    bool block(const Node& node) {
        ComPtr<IAccessible2> element;
        require(node.element.As(&element));
        BSTR raw = nullptr;
        require(element->get_attributes(&raw));
        const std::unique_ptr<OLECHAR, decltype(&SysFreeString)> attributes(raw, &SysFreeString);
        const size_t units = raw ? SysStringLen(raw) : 0;
        // More attributes than their budget has left are not looked through: not read.
        if (units > attributesLeft) throw std::runtime_error("hypertext attributes past the read's bytes");
        attributesLeft -= units;
        if (const auto display = attribute(std::wstring_view(raw ? raw : L"", units), L"display")) return display->rfind(L"inline", 0) != 0;
        long role = 0;
        require(element->role(&role));
        return role != ROLE_SYSTEM_LINK && role != ROLE_SYSTEM_GRAPHIC;
    }

    // An IAccessible2 object attribute's value: `name:value;` pairs, `\` escaping any of `\:;,=`.
    // Only the value of the name asked for is kept: each name is matched as it is read.
    static std::optional<std::wstring> attribute(std::wstring_view attributes, std::wstring_view name) {
        std::wstring value;
        size_t keyLength = 0;
        bool keyMatches = true, inValue = false;
        for (size_t at = 0; at <= attributes.size(); ++at) {
            if (at == attributes.size() || (attributes[at] == L';')) {
                if (inValue && keyMatches && keyLength == name.size()) return value;
                value.clear(); keyLength = 0; keyMatches = true; inValue = false;
                continue;
            }
            wchar_t c = attributes[at];
            if (c == L'\\' && at + 1 < attributes.size()) c = attributes[++at];
            else if (c == L':' && !inValue) { inValue = true; continue; }
            if (!inValue) {
                keyMatches = keyMatches && keyLength < name.size() && name[keyLength] == c;
                ++keyLength;
            } else if (keyMatches && keyLength == name.size()) {
                value.push_back(c);
            }
        }
        return std::nullopt;
    }
    // The Unicode scalars in the first `offset` UTF-16 units of `units`; an offset past the text or
    // inside a surrogate pair is the provider's error.
    static size_t scalars(const std::wstring& units, long offset) {
        if (offset < 0 || static_cast<size_t>(offset) > units.size()) throw std::runtime_error("hypertext offset");
        size_t count = 0;
        for (size_t at = 0; at < static_cast<size_t>(offset); ++at) {
            if (IS_HIGH_SURROGATE(units[at])) {
                if (at + 1 >= static_cast<size_t>(offset)) throw std::runtime_error("hypertext offset");
                ++at;
            }
            ++count;
        }
        return count;
    }

private:
    static std::wstring range(IAccessibleText* text, long start, long end) {
        if (start == end) return {};
        BSTR raw = nullptr;
        const HRESULT status = text->get_text(start, end, &raw);
        const std::unique_ptr<OLECHAR, decltype(&SysFreeString)> value(raw, &SysFreeString);
        const auto length = raw ? SysStringLen(raw) : 0;
        if (FAILED(status) || length != static_cast<unsigned long>(end - start)) throw std::runtime_error("accessible text range unavailable");
        return std::wstring(raw, length);
    }
    size_t attributesLeft;
    // Each element read, and its size, caret and selection when its text was read.
    std::vector<std::pair<ComPtr<IAccessibleText>, std::array<long, 5>>> read;
};
}
