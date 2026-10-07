// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// The live tree's rich text (hypertext.h) through AT-SPI's own calls, wrapped at link time: a rich
// editor's caret, selection and length limit, links in the walk's text, GTK's self-linking labels,
// and an element too large to read.
#include "../src/screen.h"
#include <iostream>
#include <map>
namespace {
void expect(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
// The break the core puts between blocks (U+2029), told apart from the text's own.
const std::string added = "\xE2\x80\xA9";
struct Element {
    std::string text;
    int caret = -1;
    std::optional<std::array<int, 2>> selection;
    std::vector<std::pair<int, AtspiAccessible*>> links;
    // None ("") when the provider gives no `display` attribute.
    std::string display = "block";
    bool editable = true;
    AtspiRole role = ATSPI_ROLE_PARAGRAPH;
};
std::map<const void*, Element> elements;
std::map<const void*, std::pair<int, AtspiAccessible*>> hyperlinks;
// The most scalars any one text read asked for, and a change to make after this many reads.
int largestRead = 0, readsBeforeChange = -1, linkFetches = 0;
AtspiAccessible* changed = nullptr;
Element& at(const void* value) { return elements.at(value); }
AtspiAccessible* element(Element value) {
    auto node = static_cast<AtspiAccessible*>(g_object_new(ATSPI_TYPE_ACCESSIBLE, nullptr));
    elements[node] = std::move(value);
    return node;
}
const std::string object = "\xEF\xBF\xBC";
}
extern "C" void __wrap_atspi_accessible_clear_cache(AtspiAccessible*) {}
extern "C" AtspiText* __wrap_atspi_accessible_get_text_iface(AtspiAccessible* value) { return reinterpret_cast<AtspiText*>(g_object_ref(value)); }
extern "C" gint __wrap_atspi_text_get_character_count(AtspiText* text, GError**) { return g_utf8_strlen(at(text).text.c_str(), -1); }
extern "C" gchar* __wrap_atspi_text_get_text(AtspiText* text, gint from, gint to, GError**) {
    largestRead = std::max(largestRead, to - from);
    if (readsBeforeChange >= 0 && readsBeforeChange-- == 0) at(changed).caret += 1;
    return g_utf8_substring(at(text).text.c_str(), from, to);
}
extern "C" gint __wrap_atspi_text_get_caret_offset(AtspiText* text, GError**) { return at(text).caret; }
extern "C" gint __wrap_atspi_text_get_n_selections(AtspiText* text, GError**) { return at(text).selection ? 1 : 0; }
extern "C" AtspiRange* __wrap_atspi_text_get_selection(AtspiText* text, gint, GError**) {
    auto result = g_new0(AtspiRange, 1);
    result->start_offset = (*at(text).selection)[0]; result->end_offset = (*at(text).selection)[1];
    return result;
}
extern "C" AtspiHypertext* __wrap_atspi_accessible_get_hypertext_iface(AtspiAccessible* value) {
    return at(value).links.empty() ? nullptr : reinterpret_cast<AtspiHypertext*>(g_object_ref(value));
}
extern "C" gint __wrap_atspi_hypertext_get_n_links(AtspiHypertext* value, GError**) { return static_cast<gint>(at(value).links.size()); }
extern "C" AtspiHyperlink* __wrap_atspi_hypertext_get_link(AtspiHypertext* value, gint index, GError**) {
    ++linkFetches;
    auto link = static_cast<AtspiHyperlink*>(g_object_new(ATSPI_TYPE_HYPERLINK, nullptr));
    hyperlinks[link] = at(value).links.at(static_cast<size_t>(index));
    return link;
}
extern "C" gint __wrap_atspi_hyperlink_get_start_index(AtspiHyperlink* link, GError**) { return hyperlinks.at(link).first; }
extern "C" AtspiAccessible* __wrap_atspi_hyperlink_get_object(AtspiHyperlink* link, gint, GError**) {
    return static_cast<AtspiAccessible*>(g_object_ref(hyperlinks.at(link).second));
}
extern "C" GHashTable* __wrap_atspi_accessible_get_attributes(AtspiAccessible* value, GError**) {
    auto result = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
    if (!at(value).display.empty()) g_hash_table_insert(result, g_strdup("display"), g_strdup(at(value).display.c_str()));
    return result;
}
extern "C" AtspiRole __wrap_atspi_accessible_get_role(AtspiAccessible* value, GError**) { return at(value).role; }
extern "C" AtspiStateSet* __wrap_atspi_accessible_get_state_set(AtspiAccessible* value) {
    auto result = atspi_state_set_new(nullptr);
    atspi_state_set_add(result, ATSPI_STATE_SHOWING); atspi_state_set_add(result, ATSPI_STATE_FOCUSED);
    if (elements.count(value) && at(value).editable) atspi_state_set_add(result, ATSPI_STATE_EDITABLE);
    return result;
}
int main() {
    try {
        // A rich editor as Chrome on Ubuntu gives it: each paragraph an embedded object in the
        // editor's text, an empty line one whose text is the `<br>`'s "\n".
        const auto editor = [](int caretIn, int caret) {
            std::vector<AtspiAccessible*> lines;
            for (const auto* line : {"Hi All,", "\n", "Why does it move?"}) lines.push_back(element({line, -1, std::nullopt, {}, "block"}));
            Element root{object + object + object, caretIn, std::nullopt, {{0, lines[0]}, {1, lines[1]}, {2, lines[2]}}, "block"};
            at(lines[static_cast<size_t>(caretIn)]).caret = caret;
            return std::pair{voice::own(element(root)), lines};
        };
        {
            // The caret on the empty line after a paragraph follows that paragraph's break.
            auto [root, lines] = editor(1, 0);
            voice::LiveScreenTree tree(root);
            const auto caret = tree.caret(root);
            expect(caret && !caret->selectionUnavailable && caret->parts[0] == "Hi All," + added && caret->parts[2] == "\nWhy does it move?",
                "a caret on an empty line is placed after the paragraph before it");
            expect(tree.field(root, 100) == "Hi All," + added + "\nWhy does it move?", "a rich field is read whole");
            expect(!tree.field(root, 10), "a rich field longer than the limit is not read");
            voice::VisibleContext context;
            tree.appendFieldSource(root, voice::ContextFrame{0, 0, 90, 80}, context, voice::ContextFrame{10, 20, 100, 100});
            expect(context.render().find("Why does it move?") != std::string::npos, "a rich field in the window is read whole");
        }
        {
            // A selection across paragraphs is placed by each element's own part.
            auto [root, lines] = editor(2, 3);
            at(root.get()).selection = std::array{0, 3};
            at(lines[0]).selection = std::array{3, 7};
            at(lines[1]).selection = std::array{0, 1};
            at(lines[2]).selection = std::array{0, 3};
            voice::LiveScreenTree tree(root);
            const auto caret = tree.caret(root);
            expect(caret && caret->parts[1] == "All," + added + "\nWhy", "a selection across paragraphs is read as selected");
        }
        {
            // A rich editor whose caret moves while it is read: a caret selects nothing, so the
            // window is empty rather than a withheld selection, and agent mode writes at it.
            auto [root, lines] = editor(0, 2);
            voice::LiveScreenTree tree(root);
            changed = root.get(); readsBeforeChange = 0;
            const auto caret = tree.caret(root);
            readsBeforeChange = -1;
            expect(caret && !caret->selectionUnavailable && caret->parts == std::array<std::string, 3>{"", "", ""}, "a caret that moved while read is an empty window");
        }
        {
            // A selection that moves while it is read is withheld: Edit must not rewrite text it never saw.
            auto [root, lines] = editor(2, 3);
            at(root.get()).selection = std::array{0, 3};
            at(lines[0]).selection = std::array{3, 7};
            at(lines[1]).selection = std::array{0, 1};
            at(lines[2]).selection = std::array{0, 3};
            voice::LiveScreenTree tree(root);
            changed = root.get(); readsBeforeChange = 0;
            const auto caret = tree.caret(root);
            readsBeforeChange = -1;
            expect(caret && caret->selectionUnavailable && caret->parts[1] == "[redacted]", "a selection that moved while read is withheld");
        }
        {
            // A caret no element places (the line it is in reports one past its own text) is not
            // read, and selects nothing: an empty window.
            auto [root, lines] = editor(1, 5);
            voice::LiveScreenTree tree(root);
            const auto caret = tree.caret(root);
            expect(caret && !caret->selectionUnavailable && caret->parts == std::array<std::string, 3>{"", "", ""}, "a caret no element places is an empty window");
        }
        {
            // A selection no element places (each line reports its part outside its own text) is withheld.
            auto [root, lines] = editor(2, 3);
            at(root.get()).selection = std::array{0, 3};
            at(lines[0]).selection = std::array{10, 12};
            at(lines[1]).selection = std::array{5, 6};
            at(lines[2]).selection = std::array{30, 31};
            voice::LiveScreenTree tree(root);
            const auto caret = tree.caret(root);
            expect(caret && caret->selectionUnavailable && caret->parts[1] == "[redacted]", "a selection no element places is withheld");
        }
        {
            // A link in a paragraph joins its line; one whose text is inline is read as it is.
            auto docs = element({"docs", -1, std::nullopt, {}, "inline"});
            auto paragraph = voice::own(element({"See " + object + " now", -1, std::nullopt, {{4, docs}}, "block"}));
            voice::LiveScreenTree tree(paragraph);
            expect(tree.screenText(paragraph) == "See docs now", "a link's text is read in its paragraph");
            // GTK's labels (gtklabelaccessible.c): the link's text is inline, and its element is the label.
            const auto label = voice::own(element({"Visit example.com now", -1, std::nullopt, {}, "block"}));
            at(label.get()).links = {{6, label.get()}};
            largestRead = 0;
            expect(tree.screenText(label) == "Visit example.com now" && largestRead == 21, "a label linking to itself is read once, as it is");
            // A provider that gives no `display`: a link or image joins its line, any other element
            // starts a line of its own.
            auto link = element({"docs", -1, std::nullopt, {}, "", true, ATSPI_ROLE_LINK});
            auto image = element({"", -1, std::nullopt, {}, "", true, ATSPI_ROLE_IMAGE});
            auto next = element({"Next", -1, std::nullopt, {}, "", true, ATSPI_ROLE_PARAGRAPH});
            const auto bare = voice::own(element({"See " + object + " and" + object + " now" + object, -1, std::nullopt,
                                                  {{4, link}, {9, image}, {14, next}}, ""}));
            expect(tree.screenText(bare) == "See docs and now" + added + "Next", "without display, a link or image joins its line and another element starts one");
        }
        {
            // An element holding more than the read may take is not asked for its text: the walk
            // reads nothing of it, and a caret in it, selecting nothing, is an empty window.
            const auto bytes = voice::core::request({{"limits", true}}, voice_core_context_json).at("caretSourceBytes").get<size_t>();
            auto large = element({std::string(bytes + 1, 'x'), 5, std::nullopt, {}, "block"});
            auto root = voice::own(element({object, 0, std::nullopt, {{0, large}}, "block"}));
            voice::LiveScreenTree tree(root);
            largestRead = 0;
            expect(!tree.screenText(root) && largestRead <= 1, "a rich text too large is not read");
            expect(!tree.field(root, std::numeric_limits<int>::max()) && largestRead <= 1, "a rich field too large is not read by its value");
            const auto caret = tree.caret(root);
            expect(caret && !caret->selectionUnavailable && caret->parts == std::array<std::string, 3>{"", "", ""} && largestRead <= 1, "a caret in a rich text too large is an empty window");
            voice::VisibleContext context;
            tree.appendFieldSource(root, voice::ContextFrame{0, 0, 90, 80}, context, voice::ContextFrame{10, 20, 100, 100});
            expect(context.render().find("xxxx") == std::string::npos && largestRead <= 1, "a rich field too large is not read");
        }
        {
            // The same rich text too large to read, with text selected: the selection is withheld.
            const auto bytes = voice::core::request({{"limits", true}}, voice_core_context_json).at("caretSourceBytes").get<size_t>();
            auto large = element({std::string(bytes + 1, 'x'), -1, std::nullopt, {}, "block"});
            auto root = voice::own(element({object, 0, std::array{0, 1}, {{0, large}}, "block"}));
            voice::LiveScreenTree tree(root);
            largestRead = 0;
            const auto caret = tree.caret(root);
            expect(caret && caret->selectionUnavailable && caret->parts[1] == "[redacted]" && largestRead <= 1, "a selection in a rich text too large is withheld");
        }
        {
            // A rich field within the read's bytes but holding more than a field is read whole up
            // to: its text is read, but not shown, and the rest of the screen still is.
            const auto graphemes = voice::core::request({{"limits", true}}, voice_core_context_json).at("semanticGraphemes").get<size_t>();
            auto text = element({std::string(graphemes + 1, 'x'), -1, std::nullopt, {}, "block"});
            auto root = voice::own(element({object, 0, std::nullopt, {{0, text}}, "block"}));
            voice::LiveScreenTree tree(root);
            voice::VisibleContext context;
            context.append(voice::ContextKind::text, "Synthetic label", voice::ContextFrame{10, 0, 100, 10});
            largestRead = 0;
            tree.appendFieldSource(root, voice::ContextFrame{0, 0, 90, 80}, context, voice::ContextFrame{10, 20, 100, 100});
            const auto rendered = context.render();
            expect(largestRead == static_cast<int>(graphemes + 1) && rendered.find("xxxx") == std::string::npos &&
                   rendered.find("Synthetic label") != std::string::npos, "a rich field longer than a whole read is not shown, and the rest of the screen is");
        }
        {
            // A rich text holding more elements than the read may take is not read, and the
            // rest of the screen still is: nothing throws.
            const auto limit = voice::core::request({{"limits", true}}, voice_core_context_json).at("caretSourceElements").get<size_t>();
            Element many{"", 0, std::nullopt, {}, "block"};
            for (size_t index = 0; index < limit; ++index) {
                many.text += object;
                many.links.push_back({static_cast<int>(index), element({"a", -1, std::nullopt, {}, "inline"})});
            }
            auto root = voice::own(element(many));
            voice::LiveScreenTree tree(root);
            linkFetches = 0;
            expect(!tree.screenText(root) && !tree.field(root, std::numeric_limits<int>::max()), "a rich text with too many elements is not read");
            const auto caret = tree.caret(root);
            expect(caret && !caret->selectionUnavailable && caret->parts == std::array<std::string, 3>{"", "", ""}, "a caret in a rich text with too many elements is an empty window");
            expect(linkFetches == 0, "the links of a rich text with too many elements are never fetched");
        }
        {
            // A rich text the read can't make sense of (a link past its text) is not read either.
            auto child = element({"x", -1, std::nullopt, {}, "inline"});
            auto root = voice::own(element({"ab", 0, std::nullopt, {{5, child}}, "block"}));
            voice::LiveScreenTree tree(root);
            expect(!tree.screenText(root) && !tree.field(root, 100), "a malformed rich text is not read");
            const auto caret = tree.caret(root);
            expect(caret && !caret->selectionUnavailable && caret->parts == std::array<std::string, 3>{"", "", ""}, "a caret in a malformed rich text is an empty window");
        }
        {
            // A malformed rich text with text selected: the selection is withheld.
            auto child = element({"x", -1, std::nullopt, {}, "inline"});
            auto root = voice::own(element({"ab", 0, std::array{0, 1}, {{5, child}}, "block"}));
            voice::LiveScreenTree tree(root);
            const auto caret = tree.caret(root);
            expect(caret && caret->selectionUnavailable && caret->parts[1] == "[redacted]", "a selection in a malformed rich text is withheld");
        }
        {
            // A selection the elements' parts leave empty, while the editor reports one, is not
            // read as none: the caret is unavailable.
            auto empty = element({"", -1, std::nullopt, {}, "inline"});
            auto root = voice::own(element({"a" + object + "b", 1, std::array{1, 2}, {{1, empty}}, "block"}));
            voice::LiveScreenTree tree(root);
            const auto caret = tree.caret(root);
            expect(caret && caret->selectionUnavailable, "a selection the elements lost is unavailable");
        }
        {
            // A plain field (no elements) whose caret moves while it is read: an empty window, as a
            // rich editor's, so agent mode writes at it.
            auto root = voice::own(element({"Hello there", 5, std::nullopt, {}, "block"}));
            voice::LiveScreenTree tree(root);
            changed = root.get(); readsBeforeChange = 0;
            const auto caret = tree.caret(root);
            readsBeforeChange = -1;
            expect(caret && !caret->selectionUnavailable && caret->parts == std::array<std::string, 3>{"", "", ""}, "a plain caret that moved while read is an empty window");
        }
        {
            // A plain field whose selection moves while it is read: the selection is withheld.
            auto root = voice::own(element({"Hello there", 5, std::array{0, 5}, {}, "block"}));
            voice::LiveScreenTree tree(root);
            changed = root.get(); readsBeforeChange = 0;
            const auto caret = tree.caret(root);
            readsBeforeChange = -1;
            expect(caret && caret->selectionUnavailable && caret->parts[1] == "[redacted]", "a plain selection that moved while read is withheld");
        }
        {
            // A page in focus that is no editor is read by its own text, not element by element.
            auto [root, lines] = editor(0, 2);
            at(root.get()).editable = false;
            voice::LiveScreenTree tree(root);
            linkFetches = 0;
            const auto caret = tree.caret(root);
            expect(caret && caret->parts[0].find("Hi") == std::string::npos && linkFetches == 0, "a page in focus is not read through its elements");
        }
        std::cout << "rich text through AT-SPI passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
