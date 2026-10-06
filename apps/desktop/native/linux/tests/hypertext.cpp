// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/hypertext.h"
#include <iostream>
#include <map>

using namespace voice;
static void expect(bool value, const char* message) { if (!value) throw std::runtime_error(message); }

// A rich editor's elements as Chromium's AT-SPI tree gives them (measured in Chrome on Ubuntu,
// 2026-10-06): each paragraph a block element in the editor's text as U+FFFC, an empty line one
// whose text is the `<br>`'s "\n", and each element's own caret and part of the selection.
struct Element {
    std::string text;
    int caret = -1;
    std::optional<std::pair<int, int>> selection;
    std::vector<std::pair<int, int>> links;  // offset, element
    bool block = true;
};
struct Fake {
    using Node = int;
    std::map<int, Element> elements;
    int reads = 0;
    // As AT-SPI is asked: its scalars counted first, and none read past `bytes` of them.
    std::optional<std::string> text(int node, size_t bytes) {
        const auto& text = elements.at(node).text;
        if (static_cast<size_t>(g_utf8_strlen(text.c_str(), -1)) > bytes) return {};
        ++reads;
        return text;
    }
    bool same(int first, int second) { return first == second; }
    int caret(int node) { return elements.at(node).caret; }
    std::optional<std::pair<int, int>> selection(int node) { return elements.at(node).selection; }
    std::vector<std::pair<int, int>> links(int node) { return elements.at(node).links; }
    bool block(int node) { return elements.at(node).block; }
};
static const std::string object = "\xEF\xBF\xBC";
static Fake paragraphs(bool leadingText) {
    Fake fake;
    const std::vector<std::string> lines{"Hi All,", "\n", "Why does it move?", "\n", "--"};
    Element root;
    for (size_t i = leadingText ? 1 : 0; i < lines.size(); ++i) {
        const int at = leadingText ? static_cast<int>(7 + i - 1) : static_cast<int>(i);
        root.links.push_back({at, static_cast<int>(i + 1)});
        fake.elements[static_cast<int>(i + 1)] = Element{lines[i], -1, std::nullopt, {}, true};
    }
    root.text = leadingText ? "Hi All," : "";
    for (size_t i = 0; i < root.links.size(); ++i) root.text += object;
    fake.elements[0] = root;
    return fake;
}
static std::string before(const Hypertext& flat) { return scalarSlice(flat.text, 0, *flat.caret); }

int main() {
    try {
        const std::string whole = "Hi All,\n\nWhy does it move?\n\n--";
        for (const bool leading : {false, true}) {
            auto onEmptyLine = paragraphs(leading);
            onEmptyLine.elements[4].caret = 0;
            auto flat = flattenHypertext(onEmptyLine, 0, 100, 1000);
            expect(flat.text == whole && flat.caret && before(flat) == "Hi All,\n\nWhy does it move?\n",
                "a caret on the empty line after a paragraph follows that paragraph's break");
            auto firstEmpty = paragraphs(leading);
            firstEmpty.elements[2].caret = 0;
            flat = flattenHypertext(firstEmpty, 0, 100, 1000);
            expect(flat.caret && before(flat) == "Hi All,\n", "a caret on the first empty line follows the first paragraph's break");
            auto sentenceEnd = paragraphs(leading);
            sentenceEnd.elements[3].caret = 17;
            flat = flattenHypertext(sentenceEnd, 0, 100, 1000);
            expect(flat.caret && before(flat) == "Hi All,\n\nWhy does it move?", "a caret at a sentence's end stays on its line");
        }
        // Chromium also puts the editor's own caret on the paragraph's embedded object; the caret
        // is where the paragraph's element says, inside it.
        auto bothCarets = paragraphs(false);
        bothCarets.elements[0].caret = 2;
        bothCarets.elements[3].caret = 4;
        auto inner = flattenHypertext(bothCarets, 0, 100, 1000);
        expect(inner.caret && before(inner) == "Hi All,\n\nWhy ", "a caret inside a paragraph is placed by the paragraph, not its object");
        auto selected = paragraphs(false);
        selected.elements[0].selection = std::pair{0, 3};
        selected.elements[1].selection = std::pair{3, 7};
        selected.elements[2].selection = std::pair{0, 1};
        selected.elements[3].selection = std::pair{0, 3};
        selected.elements[3].caret = 3;
        auto flat = flattenHypertext(selected, 0, 100, 1000);
        expect(flat.selection && scalarSlice(flat.text, flat.selection->first, flat.selection->second) == "All,\n\nWhy",
            "a selection across paragraphs is placed by each element's own part");
        Fake inlineLink;
        inlineLink.elements[0] = Element{"See " + object + " now", 9, std::nullopt, {{4, 1}}};
        inlineLink.elements[1] = Element{"d😀cs", -1, std::nullopt, {}, false};
        flat = flattenHypertext(inlineLink, 0, 100, 1000);
        expect(flat.text == "See d😀cs now" && flat.length == 12 && flat.caret == 12u, "a link joins its line; offsets count Unicode scalars");
        expect(!flattenHypertext(selected, 0, 5, 1000).complete, "more elements than the budget are not read");
        expect(!flattenHypertext(selected, 0, 100, 20).complete, "more text than the budget is not read");
        // An element holding more scalars than the bytes left is not read at all.
        Fake large;
        large.elements[0] = Element{std::string(30, 'a'), -1, std::nullopt, {}};
        flat = flattenHypertext(large, 0, 100, 20);
        expect(!flat.complete && large.reads == 0, "an element larger than the budget is never read");
        // GTK's labels (gtklabelaccessible.c): a link's text is inline, and its element is the label
        // itself. A link whose text is no embedded object is read as the text it is.
        Fake label;
        label.elements[0] = Element{"Visit example.com now", -1, std::nullopt, {{6, 0}}};
        flat = flattenHypertext(label, 0, 100, 1000);
        expect(flat.complete && flat.text == "Visit example.com now" && label.reads == 1, "a label linking to itself is read once, as it is");
        label.elements[0].links = {{6, 1}};
        label.elements[1] = Element{"", -1, std::nullopt, {}, false};
        flat = flattenHypertext(label, 0, 100, 1000);
        expect(flat.text == "Visit example.com now", "a link whose text is inline keeps its first character");
        // An embedded object standing for an element the read is already in is not gone into again.
        Fake cycle;
        cycle.elements[0] = Element{"a" + object + "b", -1, std::nullopt, {{1, 1}}};
        cycle.elements[1] = Element{"c" + object, -1, std::nullopt, {{1, 0}}, false};
        flat = flattenHypertext(cycle, 0, 100, 1000);
        expect(flat.complete && cycle.reads == 2 && scalarSlice(flat.text, 0, 2) == "ac", "a link back to an element being read is not followed");
        Fake outside;
        outside.elements[0] = Element{"ab", -1, std::nullopt, {{5, 1}}};
        outside.elements[1] = Element{"x", -1, std::nullopt, {}, true};
        bool refused = false;
        try { (void)flattenHypertext(outside, 0, 100, 1000); } catch (const std::exception&) { refused = true; }
        expect(refused, "a link outside its element's text is refused");
        std::cout << "rich editor hypertext flattening passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
