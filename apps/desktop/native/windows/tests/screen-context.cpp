// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include "screen_context.h"
#include "../../shared/context/CaretSource.h"
#include "../../shared/context/SemanticText.h"
#include <filesystem>
#include <iostream>
#include <fstream>
#include <stdexcept>

using namespace voice;
static void expect(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}
int main(int argc, char** argv) {
    expect(argc == 2, "shared context corpus path required");
    {
        SemanticText reducer(SemanticText::Kind::row);
        reducer.offer(SemanticText::Event::descendant, "Label");
        reducer.offerProjected(SemanticText::Event::descendant, {"password: ", "syntheticSecret123", ""});
        reducer.offer(SemanticText::Event::complete);
        bool refused = false; try { (void)reducer.source(); } catch (const std::exception&) { refused = true; }
        expect(refused, "projected semantic source cannot use string-only transport");
        VisibleContext context;
        context.appendSemantic(ContextKind::row, reducer.projectedSource());
        expect(context.render() == "| Label | [redacted]", "semantic hidden source redacts without rendering");
        context.appendSemantic(ContextKind::row, reducer.projectedSource());
        expect(context.count() == 1, "identical private semantic source still deduplicates");
    }

    {
        const std::u16string value = u"Visible. password: " + std::u16string(600000, u'x');
        const auto snapshot = readUtf16Snapshot(std::u16string_view(value));
        expect(!snapshot.complete && snapshot.text == "Visible. ", "native snapshot withholds incomplete credential suffix");
        const auto complete = readUtf16Snapshot(std::u16string_view(u"é😀 Caption"));
        expect(complete.complete && complete.text == "é😀 Caption", "snapshot preserves complete native Unicode source");
    }
    const std::string scalarText = "a😀é";
    const std::array<size_t, 4> scalarOffsets{0, 1, 5, 7};
    const auto scalar = readScalarCaret(3, 1, 2, [&](size_t from, size_t to) {
        expect(to <= 3 && from <= to, "scalar source request uses provider character offsets");
        return scalarText.substr(scalarOffsets[from], scalarOffsets[to] - scalarOffsets[from]);
    });
    expect(!scalar.selectionUnavailable && scalar.parts == std::array<std::string, 3>{"a", "😀", "é"},
        "scalar UTF-8 transport preserves non-BMP selection and adjacent text");
    bool scalarShortRefused = false;
    try { readScalarCaret(2, 0, 2, [](size_t, size_t) { return std::string("😀"); }); }
    catch (const std::exception&) { scalarShortRefused = true; }
    expect(scalarShortRefused, "short scalar response refused despite multiple UTF-8 bytes");
    const std::string fieldText = "prefix unknown123. Visible! unfinished456 suffix";
    const auto field = readScalarField(fieldText.size(), 7, fieldText.size() - 7, [&](size_t from, size_t to) {
        expect(from >= 7 && to <= fieldText.size() - 7 && to - from <= 4096, "field transport stays within visible interval");
        return fieldText.substr(from, to - from);
    });
    expect(field.complete && field.text == ". Visible! ", "field source withholds both open recognition edges");
    const std::u16string unicodeField = u"Field 😀 text";
    const auto wholeField = readUtf16Field(unicodeField.size(), 0, unicodeField.size(), [&](size_t from, size_t to) {
        return unicodeField.substr(from, to - from);
    });
    expect(wholeField.complete && wholeField.text == "Field 😀 text", "UTF16 field transport preserves complete Unicode source");
    // Native transport feeds the same Rust UTF-16 source planner as macOS.
    const auto readSource = [](const std::u16string& text, size_t start, size_t end) {
        return readUtf16Caret(text.size(), start, end, [&](size_t from, size_t to) {
            expect(to >= from && to - from <= 4096 && to <= text.size(), "bounded native source request");
            return text.substr(from, to - from);
        });
    };
    std::u16string complete = u"a";
    for (size_t i = 0; i < 65534; ++i) complete += u"\U0001F600";
    complete += u"x";
    auto acquired = readSource(complete, 0, complete.size());
    expect(!acquired.selectionUnavailable && acquired.parts[1].size() == 262138, "complete exact-byte selection across surrogate chunks");
    complete += u"x";
    acquired = readSource(complete, 0, complete.size());
    expect(acquired.selectionUnavailable && acquired.parts[1] == "[redacted]", "oversized selection never becomes a prefix");
    const std::u16string left = std::u16string(300000, u'a') + u". Before ";
    const std::u16string selected(20001, u's');
    acquired = readSource(left + selected + u" after! " + std::u16string(300000, u'b'), left.size(), left.size() + selected.size());
    expect(!acquired.selectionUnavailable && acquired.parts[1] == std::string(20001, 's'), "large field retains the complete selection");
    bool shortRefused = false;
    try { readUtf16Caret(10, 0, 10, [](size_t, size_t) { return std::u16string(9, u'a'); }); }
    catch (const std::exception&) { shortRefused = true; }
    expect(shortRefused, "short native response refused");

    {
        VisibleContext projected;
        const std::string text = "Offscreen. password: syntheticSecret123. Footer";
        const size_t start = std::string("Offscreen. password: ").size();
        const auto source = readScalarVisibleField(text.size(), start, start + std::string("syntheticSecret123").size(), [&](size_t from, size_t to) {
            return text.substr(from, to - from);
        });
        expect(source.complete, "visible field acquires its complete target");
        projected.appendField(source.parts);
        const nlohmann::json none{{"excludedAppIDs", nlohmann::json::array()}, {"excludedHosts", nlohmann::json::array()}};
        expect(projected.reply({{"appName", "Synthetic"}}, {"", "", ""}, false, none, 0).at("renderedText") == "> [redacted]",
            "private field sides redact the visible target and never render");
    }
    std::ifstream file(argv[1]);
    nlohmann::json corpus; file >> corpus;
    expect(corpus.at("cases").size() >= 11, "nonempty shared corpus");
    for (const auto& item : corpus.at("cases")) {
        const auto result = core::request(item.at("request"), voice_core_context_json);
        for (const auto& [key, expected] : item.at("expected").items()) {
            expect(result.at(key) == expected, item.at("name").get<std::string>().c_str());
        }
    }
    std::ifstream semanticFile(std::filesystem::path(argv[1]).parent_path() / "semantic-cases.json");
    nlohmann::json semanticCorpus; semanticFile >> semanticCorpus;
    expect(semanticCorpus.at("cases").size() >= 11, "nonempty common semantic corpus");
    const auto repeat = [](const nlohmann::json& value) {
        std::string result;
        for (size_t i = 0; i < value.at("repeat").get<size_t>(); ++i) result += value.at("text").get<std::string>();
        return result;
    };
    for (const auto& item : semanticCorpus.at("cases")) {
        SemanticText text(static_cast<SemanticText::Kind>(item.at("kind").get<uint32_t>()));
        expect(static_cast<uint32_t>(text.decision()) == item.at("initial"), "semantic initial acquisition decision");
        for (const auto& event : item.at("events")) {
            text.offer(static_cast<SemanticText::Event>(event.at("event").get<uint32_t>()), repeat(event));
            expect(static_cast<uint32_t>(text.decision()) == event.at("decision"), item.at("name").get<std::string>().c_str());
        }
        expect(text.source() == repeat(item.at("expected")), item.at("name").get<std::string>().c_str());
    }
    expect(normalizedContextText(" e\xCC\x81 ", std::string("é")).empty(), "canonical adjacent duplicate matches Mac");
    expect(normalizedContextText("\xC2\xA0text\xC2\xA0") == "text", "Mac whitespace normalization");
    // Matching the Mac renderer: reading order, inline overlap, column jump,
    // headings, a focused multiline field and an ordinary field.
    VisibleContext context;
    context.append(ContextKind::heading, "  Conversation  ", ContextFrame{0, 0, 200, 20});
    context.append(ContextKind::text, "Alex", ContextFrame{0, 30, 40, 20});
    context.append(ContextKind::link, "10:30", ContextFrame{50, 30, 40, 20});
    context.append(ContextKind::row, "Project | Status", ContextFrame{0, 60, 200, 20});
    context.append(ContextKind::caret, "Reply ‸selected‸\nsecond line", ContextFrame{0, 90, 200, 40});
    context.append(ContextKind::field, "Reference\nmore", ContextFrame{300, 0, 200, 40});
    expect(context.render() == "## Conversation\nAlex [10:30]\n| Project | Status\n» Reply ‸selected‸\n» second line\n\n> Reference\n> more", "Mac-format reading order and markers");
    expect(context.hasCaret && context.count() == 6, "caret recorded once");
    context.append(ContextKind::text, "Reference\nmore");
    context.append(ContextKind::text, " \n\t ");
    expect(context.count() == 6, "adjacent duplicates and blank labels omitted");

    VisibleContext sliver;
    sliver.append(ContextKind::text, "First", ContextFrame{0, 0, 50, 20});
    sliver.append(ContextKind::text, "Second", ContextFrame{60, 19, 50, 20});
    expect(sliver.render() == "First\nSecond", "one-pixel overlap is not one line");
    sliver.append(ContextKind::text, "Unknown frame");
    expect(sliver.render().ends_with("\nUnknown frame"), "missing geometry starts a line");

    VisibleContext caretBoundary({"left", "chosen", "right"});
    caretBoundary.append(ContextKind::caret, "‸");
    caretBoundary.append(ContextKind::text, "‸");
    expect(caretBoundary.count() == 2, "a native caret placeholder cannot suppress real following text");

    VisibleContext bounded;
    bounded.append(ContextKind::text, std::string(VisibleContext::sourceLimit() - 2, 'x'));
    bounded.append(ContextKind::text, "🙂tail");
    expect(bounded.stopped == "text budget", "aggregate budget is enforced");
    expect(bounded.render() == std::string(VisibleContext::sourceLimit() - 2, 'x'), "no partial UTF-8 character crosses the wire");
    bounded.append(ContextKind::text, "done");
    expect(bounded.render() == std::string(VisibleContext::sourceLimit() - 2, 'x'), "a full source budget never admits later fragments");
    std::cout << "Windows screen context rendering checks passed\n";
}
