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
    std::optional<std::vector<std::pair<int, int>>> links(int node, size_t most) {
        if (elements.at(node).links.size() > most) return {};
        return elements.at(node).links;
    }
    bool block(int node) { return elements.at(node).block; }
};
static const std::string object = "\xEF\xBF\xBC";
// The line break the core puts between blocks.
static const std::string blockBreak = "\n";
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
        const std::string whole = "Hi All," + blockBreak + "\nWhy does it move?" + blockBreak + "\n--";
        for (const bool leading : {false, true}) {
            auto onEmptyLine = paragraphs(leading);
            onEmptyLine.elements[4].caret = 0;
            auto flat = flattenHypertext(onEmptyLine, 0, 100, 1000);
            expect(flat.text == whole && flat.caret && before(flat) == "Hi All," + blockBreak + "\nWhy does it move?" + blockBreak,
                "a caret on the empty line after a paragraph follows that paragraph's break");
            auto firstEmpty = paragraphs(leading);
            firstEmpty.elements[2].caret = 0;
            flat = flattenHypertext(firstEmpty, 0, 100, 1000);
            expect(flat.caret && before(flat) == "Hi All," + blockBreak, "a caret on the first empty line follows the first paragraph's break");
            auto sentenceEnd = paragraphs(leading);
            sentenceEnd.elements[3].caret = 17;
            flat = flattenHypertext(sentenceEnd, 0, 100, 1000);
            expect(flat.caret && before(flat) == "Hi All," + blockBreak + "\nWhy does it move?", "a caret at a sentence's end stays on its line");
        }
        // Chromium also puts the editor's own caret on the paragraph's embedded object; the caret
        // is where the paragraph's element says, inside it.
        auto bothCarets = paragraphs(false);
        bothCarets.elements[0].caret = 2;
        bothCarets.elements[3].caret = 4;
        auto inner = flattenHypertext(bothCarets, 0, 100, 1000);
        expect(inner.caret && before(inner) == "Hi All," + blockBreak + "\nWhy ", "a caret inside a paragraph is placed by the paragraph, not its object");
        // A caret just before an element its text holds is the text's, at the element's object, when
        // the element reports none: before a link's text, and at the start of a paragraph's line.
        Fake beforeLink;
        beforeLink.elements[0] = Element{"ab" + object + "cd", 2, std::nullopt, {{2, 1}}, true};
        beforeLink.elements[1] = Element{"link", -1, std::nullopt, {}, false};
        auto atLink = flattenHypertext(beforeLink, 0, 100, 1000);
        expect(atLink.text == "ablinkcd" && atLink.caret && before(atLink) == "ab", "a caret before a link its paragraph reports is kept");
        auto beforeParagraph = paragraphs(false);
        beforeParagraph.elements[0].caret = 2;
        atLink = flattenHypertext(beforeParagraph, 0, 100, 1000);
        expect(atLink.caret && before(atLink) == "Hi All," + blockBreak + "\n", "a caret before a paragraph that reports none starts its line");
        // A selection starting or ending at an element with no part of its own (an image) keeps
        // that edge: the text holding the element marks it.
        Fake image;
        image.elements[0] = Element{"a" + object + "bc", -1, std::pair{1, 4}, {{1, 1}}, true};
        image.elements[1] = Element{"", -1, std::nullopt, {}, false};
        auto edged = flattenHypertext(image, 0, 100, 1000);
        expect(edged.selection && edged.selection->first == 1 && edged.selection->second == 3, "a selection starting at an image keeps its start");
        image.elements[0].selection = std::pair{0, 2};
        edged = flattenHypertext(image, 0, 100, 1000);
        expect(edged.selection && edged.selection->first == 0 && edged.selection->second == 1, "a selection ending at an image keeps its end");
        image.elements[1].selection = std::pair{0, 0};
        edged = flattenHypertext(image, 0, 100, 1000);
        expect(edged.selection && edged.selection->first == 0 && edged.selection->second == 1, "an image reporting an empty part keeps the end");
        // A selection from a paragraph's end, which Chromium gives that paragraph no part of (or an
        // empty one) and the editor the paragraph's object, starts at the paragraph's end: the break
        // and the words after it are selected, not the paragraph.
        const auto twoParagraphs = [&](std::pair<int, int> range) {
            Fake fake;
            fake.elements[0] = Element{object + object + object, -1, range, {{0, 1}, {1, 2}, {2, 3}}, true};
            fake.elements[1] = Element{"Hi All,", -1, std::nullopt, {}, true};
            fake.elements[2] = Element{"Why does it move?", -1, std::nullopt, {}, true};
            fake.elements[3] = Element{"--", -1, std::nullopt, {}, true};
            return fake;
        };
        const auto selectedText = [](const Hypertext& flat) {
            return flat.selection ? scalarSlice(flat.text, flat.selection->first, flat.selection->second) : std::string("none");
        };
        auto fromEnd = twoParagraphs({0, 2});
        fromEnd.elements[2].selection = std::pair{0, 3};
        expect(selectedText(flattenHypertext(fromEnd, 0, 100, 1000)) == blockBreak + "Why", "a selection from a paragraph's end starts there");
        fromEnd.elements[1].selection = std::pair{7, 7};
        expect(selectedText(flattenHypertext(fromEnd, 0, 100, 1000)) == blockBreak + "Why", "a paragraph reporting an empty part at its end starts the selection there");
        auto onlyBreak = twoParagraphs({0, 1});
        expect(selectedText(flattenHypertext(onlyBreak, 0, 100, 1000)) == blockBreak, "a selection of the break between paragraphs is the break");
        auto toStart = twoParagraphs({0, 2});
        toStart.elements[1].selection = std::pair{3, 7};
        toStart.elements[2].selection = std::pair{0, 17};
        const auto upTo = selectedText(flattenHypertext(toStart, 0, 100, 1000));
        expect(upTo.rfind("All," + blockBreak + "Why does it move?", 0) == 0 && upTo.find("--") == std::string::npos, "a selection ending at a paragraph's start leaves that paragraph out");
        // A line selected down to the next one's start (Shift+Down), the caret there, holds its break.
        auto lineDown = twoParagraphs({1, 2});
        lineDown.elements[2].selection = std::pair{0, 17};
        lineDown.elements[3].caret = 0;
        expect(selectedText(flattenHypertext(lineDown, 0, 100, 1000)) == "Why does it move?" + blockBreak, "a line selected to the next one's start holds its break");
        lineDown.elements[3].caret = -1;
        lineDown.elements[2].caret = 17;
        expect(selectedText(flattenHypertext(lineDown, 0, 100, 1000)) == "Why does it move?", "a line selected to its own end does not");
        // More links than the elements left are never fetched or read.
        auto many = twoParagraphs({0, 0});
        many.elements[0].selection.reset();
        expect(!flattenHypertext(many, 0, 3, 1000).complete && many.reads == 1, "an element with more links than the budget left is not read");
        expect(flattenHypertext(many, 0, 4, 1000).complete, "links within the budget left are read");
        // Elements nested past the budget are not read, though no one element has more links than it.
        Fake nested;
        nested.elements[0] = Element{object + object, -1, std::nullopt, {{0, 1}, {1, 2}}, true};
        nested.elements[1] = Element{object, -1, std::nullopt, {{0, 3}}, true};
        nested.elements[2] = Element{"b", -1, std::nullopt, {}, true};
        nested.elements[3] = Element{"a", -1, std::nullopt, {}, true};
        expect(!flattenHypertext(nested, 0, 3, 1000).complete && flattenHypertext(nested, 0, 4, 1000).complete, "elements nested past the budget are not read");
        // Text after a paragraph starts a line of its own.
        Fake after;
        after.elements[0] = Element{object + "tail", -1, std::nullopt, {{0, 1}}, true};
        after.elements[1] = Element{"para", -1, std::nullopt, {}, true};
        expect(flattenHypertext(after, 0, 100, 1000).text == "para" + blockBreak + "tail", "text after a paragraph starts its own line");
        // The budget counts bytes: four two-byte scalars take eight.
        Fake wide;
        wide.elements[0] = Element{object, -1, std::nullopt, {{0, 1}}, true};
        wide.elements[1] = Element{"\xC3\xA9\xC3\xA9\xC3\xA9\xC3\xA9", -1, std::nullopt, {}, true};
        expect(!flattenHypertext(wide, 0, 100, 10).complete && flattenHypertext(wide, 0, 100, 11).complete, "the budget counts a rich text's bytes");
        auto selected = paragraphs(false);
        selected.elements[0].selection = std::pair{0, 3};
        selected.elements[1].selection = std::pair{3, 7};
        selected.elements[2].selection = std::pair{0, 1};
        selected.elements[3].selection = std::pair{0, 3};
        selected.elements[3].caret = 3;
        auto flat = flattenHypertext(selected, 0, 100, 1000);
        expect(flat.selection && scalarSlice(flat.text, flat.selection->first, flat.selection->second) == "All," + blockBreak + "\nWhy",
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
        // The second paragraph fits the whole budget but not what the first left of it: it is never read.
        Fake rest;
        rest.elements[0] = Element{object + object, -1, std::nullopt, {{0, 1}, {1, 2}}, true};
        rest.elements[1] = Element{"aaaaaaaaaa", -1, std::nullopt, {}, true};
        rest.elements[2] = Element{"bbbbbbbbbb", -1, std::nullopt, {}, true};
        flat = flattenHypertext(rest, 0, 100, 20);
        expect(!flat.complete && rest.reads == 2, "an element larger than the budget left is never read");
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
