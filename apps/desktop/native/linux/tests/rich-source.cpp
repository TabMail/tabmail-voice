// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// The live tree's rich text (shared/context/hypertext.h) through AT-SPI's own calls, wrapped at link time: a rich
// editor's caret, selection and length limit, links in the walk's text, GTK's self-linking labels,
// an element too large to read, and the caret anchor's rectangle in a rich editor (`caretInWindow`).
#include "../src/screen.h"
#include <iostream>
#include <map>
#include <set>
namespace {
void expect(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
// The line break the core puts between blocks.
const std::string blockBreak = "\n";
struct Element {
    std::string text;
    int caret = -1;
    std::optional<std::array<int, 2>> selection;
    std::vector<std::pair<int, AtspiAccessible*>> links;
    // None ("") when the provider gives no `display` attribute.
    std::string display = "block";
    bool editable = true;
    AtspiRole role = ATSPI_ROLE_PARAGRAPH;
    // Whether its state says it has the focus (a GTK 4 window gives its up while the Shell holds
    // the keyboard).
    bool focused = true;
    // Where its text is drawn in its window: a character is eight pixels wide, a line sixteen high. Past
    // the text, the rectangle is the next line's start, as Chromium gives it.
    int x = 0, y = 0;
    // Whether it has a text interface (an image has none).
    bool hasText = true;
};
std::map<const void*, Element> elements;
std::map<const void*, std::pair<int, AtspiAccessible*>> hyperlinks;
// The most scalars any one text read asked for, and a change to make after this many reads.
int largestRead = 0, readsBeforeChange = -1, linkFetches = 0;
// How many times each element's text was read.
std::map<const void*, int> textReads;
// Calls made to fail with an error: a character count, a character's rectangle, a link fetch, a
// link's object; and a character count that is negative with no error.
bool countFails = false, extentsFail = false, linkFails = false, objectFails = false, countNegative = false;
// A character rectangle's width and height to give in place of the element's (a malformed provider).
std::optional<int> rectWidth, rectHeight;
// The text reads not yet freed, and the links not yet released.
std::set<const void*> unfreed;
int linksAlive = 0;
void fail(GError** error) { g_set_error_literal(error, g_quark_from_static_string("synthetic"), 1, "synthetic failure"); }
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
extern "C" void __real_g_free(gpointer);
extern "C" void __wrap_g_free(gpointer value) { unfreed.erase(value); __real_g_free(value); }
extern "C" AtspiText* __wrap_atspi_accessible_get_text_iface(AtspiAccessible* value) {
    return elements.count(value) && !at(value).hasText ? nullptr : reinterpret_cast<AtspiText*>(g_object_ref(value));
}
extern "C" gint __wrap_atspi_text_get_character_count(AtspiText* text, GError** error) {
    // at-spi2-core answers a failed count with 0 and the error.
    if (countFails) { fail(error); return 0; }
    if (countNegative) return -1;
    return g_utf8_strlen(at(text).text.c_str(), -1);
}
extern "C" gchar* __wrap_atspi_text_get_text(AtspiText* text, gint from, gint to, GError**) {
    largestRead = std::max(largestRead, to - from);
    ++textReads[text];
    if (readsBeforeChange >= 0 && readsBeforeChange-- == 0) at(changed).caret += 1;
    auto result = g_utf8_substring(at(text).text.c_str(), from, to);
    unfreed.insert(result);
    return result;
}
extern "C" gint __wrap_atspi_text_get_caret_offset(AtspiText* text, GError**) { return at(text).caret; }
extern "C" gint __wrap_atspi_text_get_n_selections(AtspiText* text, GError**) { return at(text).selection ? 1 : 0; }
extern "C" AtspiRange* __wrap_atspi_text_get_selection(AtspiText* text, gint, GError**) {
    auto result = g_new0(AtspiRange, 1);
    result->start_offset = (*at(text).selection)[0]; result->end_offset = (*at(text).selection)[1];
    return result;
}
// Only the window's coordinates are given (Wayland has no screen coordinates for AT-SPI).
extern "C" AtspiRect* __wrap_atspi_text_get_character_extents(AtspiText* text, gint offset, AtspiCoordType type, GError** error) {
    if (type != ATSPI_COORD_TYPE_WINDOW) { fail(error); return nullptr; }
    auto result = g_new0(AtspiRect, 1);
    unfreed.insert(result);
    if (extentsFail) fail(error);
    const bool past = offset >= g_utf8_strlen(at(text).text.c_str(), -1);
    result->x = at(text).x + (past ? 0 : 8 * offset); result->y = at(text).y + (past ? 16 : 0); result->width = 8; result->height = 16;
    if (rectWidth) result->width = *rectWidth;
    if (rectHeight) result->height = *rectHeight;
    return result;
}
extern "C" gint __wrap_atspi_hypertext_get_link_index(AtspiHypertext* value, gint offset, GError**) {
    const auto& links = at(value).links;
    for (size_t i = 0; i < links.size(); ++i) if (links[i].first == offset) return static_cast<gint>(i);
    return -1;
}
extern "C" AtspiHypertext* __wrap_atspi_accessible_get_hypertext_iface(AtspiAccessible* value) {
    return at(value).links.empty() ? nullptr : reinterpret_cast<AtspiHypertext*>(g_object_ref(value));
}
extern "C" gint __wrap_atspi_hypertext_get_n_links(AtspiHypertext* value, GError**) { return static_cast<gint>(at(value).links.size()); }
extern "C" AtspiHyperlink* __wrap_atspi_hypertext_get_link(AtspiHypertext* value, gint index, GError** error) {
    ++linkFetches;
    if (linkFails) { fail(error); return nullptr; }
    auto link = static_cast<AtspiHyperlink*>(g_object_new(ATSPI_TYPE_HYPERLINK, nullptr));
    hyperlinks[link] = at(value).links.at(static_cast<size_t>(index));
    ++linksAlive;
    g_object_weak_ref(G_OBJECT(link), [](gpointer, GObject*) { --linksAlive; }, nullptr);
    return link;
}
extern "C" gint __wrap_atspi_hyperlink_get_start_index(AtspiHyperlink* link, GError**) { return hyperlinks.at(link).first; }
// A link here has one anchor, the first: any other is an error, as AT-SPI gives it.
extern "C" AtspiAccessible* __wrap_atspi_hyperlink_get_object(AtspiHyperlink* link, gint anchor, GError** error) {
    if (objectFails || anchor != 0) { fail(error); return nullptr; }
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
    atspi_state_set_add(result, ATSPI_STATE_SHOWING);
    atspi_state_set_add(result, ATSPI_STATE_VISIBLE);
    if (!elements.count(value) || at(value).focused) atspi_state_set_add(result, ATSPI_STATE_FOCUSED);
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
            // A rich editor's caret anchor (#371): the editor's caret is at the object standing for its
            // line, drawn where the line starts; the anchor is the caret in that line, mid-line and at
            // its end, on whichever line it is.
            using Rect = std::optional<std::array<int, 4>>;
            auto [root, lines] = editor(2, 5);
            for (size_t i = 0; i < lines.size(); ++i) { at(lines[i]).x = 10; at(lines[i]).y = 30 + 20 * static_cast<int>(i); }
            // Every reference the anchor takes (an interface, a followed element) is released.
            const auto references = [editorRoot = root.get(), editorLines = lines] {
                auto total = static_cast<unsigned>(G_OBJECT(editorRoot)->ref_count);
                for (auto* line : editorLines) total += G_OBJECT(line)->ref_count;
                return total;
            };
            const auto referencesBefore = references();
            expect(voice::caretInWindow(root) == Rect(std::array<int, 4>{10 + 8 * 5, 70, 8, 16}), "a rich editor's caret is the caret in its line");
            at(lines[2]).caret = 17;
            expect(voice::caretInWindow(root) == Rect(std::array<int, 4>{10 + 8 * 17, 70, 1, 16}), "a caret at a line's end is where its last character ends");
            at(lines[2]).caret = -1; at(lines[0]).caret = 3; at(root.get()).caret = 0;
            expect(voice::caretInWindow(root) == Rect(std::array<int, 4>{10 + 8 * 3, 30, 8, 16}), "a caret on the first line is in that line");
            // A line that says the caret is not in it has none to give.
            at(lines[0]).caret = -1;
            expect(!voice::caretInWindow(root), "a line without the caret gives no anchor");
            // A field with no objects is read where its caret is, as before, its end too: after a final
            // newline (GTK's text view) the provider's rectangle is the empty last line, never the
            // newline's own on the line above.
            const auto plain = voice::own(element({"Synthetic text\n", 4, std::nullopt, {}, "block"}));
            at(plain.get()).x = 6; at(plain.get()).y = 9;
            expect(voice::caretInWindow(plain) == Rect(std::array<int, 4>{6 + 8 * 4, 9, 8, 16}), "a caret in plain text is read there");
            at(plain.get()).caret = 15;
            expect(voice::caretInWindow(plain) == Rect(std::array<int, 4>{6, 25, 8, 16}), "a caret after plain text's final newline is on the empty last line");
            // A password field's text is never read for its anchor, focused or reached through an
            // object; it is read where its caret is.
            Element secret{"Synthetic " + object + " text", 10, std::nullopt, {}, "block"};
            secret.role = ATSPI_ROLE_PASSWORD_TEXT; secret.x = 6; secret.y = 9;
            const auto password = voice::own(element(secret));
            expect(voice::caretInWindow(password) == Rect(std::array<int, 4>{6 + 8 * 10, 9, 8, 16}), "a focused password field's anchor is its caret's");
            expect(textReads[password.get()] == 0, "a focused password field's text is not read");
            const auto reached = element(secret);
            const auto holder = voice::own(element({object, 0, std::nullopt, {{0, reached}}, "block"}));
            expect(voice::caretInWindow(holder) == Rect(std::array<int, 4>{6 + 8 * 10, 9, 8, 16}), "a password field reached through an object is read at its caret");
            expect(textReads[reached] == 0, "a password field reached through an object is not read");
            // An empty field's caret has no character before it: its own rectangle is read.
            const auto empty = voice::own(element({"", 0, std::nullopt, {}, "block"}));
            at(empty.get()).x = 6; at(empty.get()).y = 9;
            expect(voice::caretInWindow(empty) == Rect(std::array<int, 4>{6, 25, 8, 16}), "an empty field's caret is its own rectangle");
            // An empty line followed into has no character before its caret either: its own rectangle.
            const auto emptyLine = element({"", 0, std::nullopt, {}, "block"});
            at(emptyLine).x = 50; at(emptyLine).y = 60;
            const auto emptyHolder = voice::own(element({object, 0, std::nullopt, {{0, emptyLine}}, "block"}));
            expect(voice::caretInWindow(emptyHolder) == Rect(std::array<int, 4>{50, 76, 8, 16}), "an empty line's caret is its own rectangle");
            // An object whose element can't be had is no anchor: never the object's own place, the line's start.
            const auto orphan = voice::own(element({"Synthetic " + object + " text", 10, std::nullopt, {}, "block"}));
            expect(!voice::caretInWindow(orphan), "a caret on an object with no element gives no anchor");
            const auto unlinked = voice::own(element({object + object, 1, std::nullopt, {{0, lines[0]}}, "block"}));
            expect(!voice::caretInWindow(unlinked), "a caret on an object the provider has no link for gives no anchor");
            at(lines[2]).caret = 5; at(root.get()).caret = 2;
            expect(voice::caretInWindow(root).has_value(), "the editor's caret is read before each failure");
            for (auto* failing : {&linkFails, &objectFails}) {
                *failing = true;
                const auto anchor = voice::caretInWindow(root);
                *failing = false;
                expect(!anchor, "a link or object the provider fails to give is no anchor");
            }
            // A provider failing to count a followed line's characters (or giving a negative count), or to
            // place its caret, gives none.
            for (auto* failing : {&countFails, &countNegative, &extentsFail}) {
                *failing = true;
                const auto anchor = voice::caretInWindow(root);
                *failing = false;
                expect(!anchor, "a count or rectangle the provider fails to give is no anchor");
            }
            // A rectangle of negative width, or of no height, is no anchor.
            for (auto [width, height] : {std::pair{-1, 16}, std::pair{8, 0}}) {
                rectWidth = width; rectHeight = height;
                const auto anchor = voice::caretInWindow(root);
                rectWidth.reset(); rectHeight.reset();
                expect(!anchor, "a malformed rectangle is no anchor");
            }
            // An object after ordinary text is followed by its link's index, not its offset in the text.
            at(lines[1]).caret = 0;
            const auto afterText = voice::own(element({"Synthetic " + object, 10, std::nullopt, {{10, lines[1]}}, "block"}));
            expect(voice::caretInWindow(afterText).has_value(), "an object after text is followed by its link");
            at(lines[1]).caret = -1;
            // An object with no text (an image) has no caret to give.
            const auto image = element({"", 0, std::nullopt, {}, "block"});
            at(image).hasText = false;
            const auto pictured = voice::own(element({object, 0, std::nullopt, {{0, image}}, "block"}));
            expect(!voice::caretInWindow(pictured), "a caret on an object with no text gives no anchor");
            // A caret in a link inside a line is three elements deep (editor, line, link): read in the
            // link, mid-link and at its end.
            const auto linked = element({"docs", 2, std::nullopt, {}, "inline"});
            at(linked).x = 100; at(linked).y = 200;
            const auto withLink = element({"See " + object + " now", 4, std::nullopt, {{4, linked}}, "block"});
            const auto linkEditor = voice::own(element({object, 0, std::nullopt, {{0, withLink}}, "block"}));
            expect(voice::caretInWindow(linkEditor) == Rect(std::array<int, 4>{100 + 8 * 2, 200, 8, 16}), "a caret in a link in a line is read in the link");
            at(linked).caret = 4;
            expect(voice::caretInWindow(linkEditor) == Rect(std::array<int, 4>{100 + 8 * 4, 200, 1, 16}), "a caret at a link's end is where its last character ends");
            // Every character read is freed, every link released, every reference given back.
            expect(unfreed.empty() && linksAlive == 0, "the anchor's reads are released");
            expect(references() == referencesBefore, "the anchor's references are released");
            // Elements in elements are followed as deep as `caretObjectDepth`, and no deeper.
            const auto nested = [](unsigned depth) {
                auto inner = element({"Synthetic", 2, std::nullopt, {}, "block"});
                at(inner).x = 50; at(inner).y = 60;
                for (unsigned i = 1; i < depth; ++i) inner = element({object, 0, std::nullopt, {{0, inner}}, "block"});
                return voice::own(inner);
            };
            expect(voice::caretInWindow(nested(voice::HelperConfig::caretObjectDepth)) == Rect(std::array<int, 4>{50 + 8 * 2, 60, 8, 16}), "a caret as deep as the limit is read");
            expect(!voice::caretInWindow(nested(voice::HelperConfig::caretObjectDepth + 1)), "a caret deeper than the limit gives no anchor");
        }
        {
            // The caret on the empty line after a paragraph follows that paragraph's break.
            auto [root, lines] = editor(1, 0);
            voice::LiveScreenTree tree(root);
            const auto caret = tree.caret(root);
            expect(caret && !caret->selectionUnavailable && caret->parts[0] == "Hi All," + blockBreak && caret->parts[2] == "\nWhy does it move?",
                "a caret on an empty line is placed after the paragraph before it");
            expect(tree.field(root, 100) == "Hi All," + blockBreak + "\nWhy does it move?", "a rich field is read whole");
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
            expect(caret && caret->parts[1] == "All," + blockBreak + "\nWhy", "a selection across paragraphs is read as selected");
        }
        {
            // While the Shell holds the keyboard for the dictation key, the field's window gives up
            // its focus: a selection in the field it kept (`focusKept`) is read whole, and one in a
            // field it doesn't keep, or with no hold, is withheld.
            auto [root, lines] = editor(2, 3);
            at(root.get()).selection = std::array{0, 3};
            at(lines[0]).selection = std::array{3, 7};
            at(lines[1]).selection = std::array{0, 1};
            at(lines[2]).selection = std::array{0, 3};
            at(root.get()).focused = false;
            voice::LiveScreenTree tree(root);
            const auto unheld = tree.caret(root);
            expect(unheld && unheld->selectionUnavailable, "a selection in a field without the focus is withheld");
            const auto field = root.get();
            tree.focusKept = [field](const voice::Node& node) { return node.get() == field; };
            const auto held = tree.caret(root);
            expect(held && !held->selectionUnavailable && held->parts[1] == "All," + blockBreak + "\nWhy",
                "a selection in the field the Shell's hold keeps is read");
            tree.focusKept = [](const voice::Node&) { return false; };
            const auto other = tree.caret(root);
            expect(other && other->selectionUnavailable, "a selection in a field the Shell's hold doesn't keep is withheld");
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
            expect(tree.screenText(bare) == "See docs and now" + blockBreak + "Next", "without display, a link or image joins its line and another element starts one");
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
            // A rich field holding more than a field is read whole up to (the read's bytes): its
            // text is read, but not shown, and the rest of the screen still is.
            const auto screenBytes = voice::core::request({{"limits", true}}, voice_core_context_json).at("screenBytes").get<size_t>();
            auto text = element({std::string(screenBytes + 1, 'x'), -1, std::nullopt, {}, "block"});
            auto root = voice::own(element({object, 0, std::nullopt, {{0, text}}, "block"}));
            voice::LiveScreenTree tree(root);
            voice::VisibleContext context;
            context.append(voice::ContextKind::text, "Synthetic label", voice::ContextFrame{10, 0, 100, 10});
            largestRead = 0;
            tree.appendFieldSource(root, voice::ContextFrame{0, 0, 90, 80}, context, voice::ContextFrame{10, 20, 100, 100});
            const auto rendered = context.render();
            expect(largestRead == static_cast<int>(screenBytes + 1) && rendered.find("xxxx") == std::string::npos &&
                   rendered.find("Synthetic label") != std::string::npos, "a rich field longer than a whole read is not shown, and the rest of the screen is");
        }
        {
            // A rich editor is read however many elements it holds, while their text fits the read's
            // bytes (#361): 500 paragraphs, past the 300 elements the read once stopped at (a long
            // Overleaf document or mail thread), the caret at the last one's start.
            const int paragraphs = 500;
            // The editor's caret is on the last paragraph's embedded object, as a browser puts it.
            Element editor{"", paragraphs - 1, std::nullopt, {}, "block"};
            std::string whole;
            for (int index = 1; index <= paragraphs; ++index) {
                editor.text += object;
                editor.links.push_back({index - 1, element({"p" + std::to_string(index), index == paragraphs ? 0 : -1, std::nullopt, {}, "block"})});
                whole += (index > 1 ? blockBreak : "") + "p" + std::to_string(index);
            }
            auto root = voice::own(element(editor));
            voice::LiveScreenTree tree(root);
            expect(tree.screenText(root) == whole && tree.field(root, std::numeric_limits<int>::max()) == whole, "a rich editor of 500 paragraphs is read whole");
            const auto caret = tree.caret(root);
            expect(caret && !caret->selectionUnavailable && caret->parts[0].ends_with("p499" + blockBreak) && caret->parts[2] == "p500",
                   "the caret in a rich editor of 500 paragraphs has the text around it");
        }
        {
            // An element claiming more links than it has characters is malformed: none of its links
            // is fetched, it is not read, and nothing throws (a provider's count never drives fetches).
            const auto first = element({"a", -1, std::nullopt, {}, "inline"});
            const auto second = element({"b", -1, std::nullopt, {}, "inline"});
            auto root = voice::own(element({object, 0, std::nullopt, {{0, first}, {0, second}}, "block"}));
            voice::LiveScreenTree tree(root);
            linkFetches = 0;
            expect(!tree.screenText(root) && !tree.field(root, std::numeric_limits<int>::max()), "an element with more links than characters is not read");
            const auto caret = tree.caret(root);
            expect(caret && !caret->selectionUnavailable && caret->parts == std::array<std::string, 3>{"", "", ""}, "its caret is an empty window");
            expect(linkFetches == 0, "the links of an element with more links than characters are never fetched");
        }
        {
            // A rich editor nested as deep as the core's depth is read; one level deeper is not, and the
            // rest of the screen still is.
            const auto depth = static_cast<int>(voice::core::request({{"limits", true}}, voice_core_context_json).at("hypertextDepth").get<size_t>());
            const auto chain = [](int levels) {
                auto inner = element({"Synthetic", -1, std::nullopt, {}, "block"});
                for (int i = 0; i < levels; ++i) inner = element({object, -1, std::nullopt, {{0, inner}}, "block"});
                return voice::own(inner);
            };
            const auto within = chain(depth);
            expect(voice::LiveScreenTree(within).screenText(within) == "Synthetic", "a rich editor nested as deep as the limit is read");
            const auto past = chain(depth + 1);
            expect(!voice::LiveScreenTree(past).screenText(past), "a rich editor nested past the limit is not read");
            // The walk itself stops at the limit: of an editor two levels deeper, only the links of the
            // elements down to the limit are fetched, one each, and none below it.
            const auto deeper = chain(depth + 2);
            linkFetches = 0;
            expect(!voice::LiveScreenTree(deeper).screenText(deeper), "a rich editor nested two past the limit is not read");
            expect(linkFetches == depth + 1, "the walk fetches no link below the depth limit");
        }
        {
            // A screen read the app stopped gives up a rich editor at its next element, unread.
            const auto line = element({"Synthetic", -1, std::nullopt, {}, "block"});
            auto root = voice::own(element({object, -1, std::nullopt, {{0, line}}, "block"}));
            voice::LiveScreenTree tree(root);
            expect(tree.screenText(root) == "Synthetic", "a rich editor is read while its read is not stopped");
            voice::walk::readStops().reading = 41;
            voice::walk::readStops().ask(41);
            const auto stopped = tree.screenText(root);
            voice::walk::readStops().reading = 0;
            expect(!stopped, "a stopped read gives up a rich editor unread");
            expect(tree.screenText(root) == "Synthetic", "a read with no number is never stopped");
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
