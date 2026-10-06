// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/screen.h"
#include <iostream>
#include <map>
namespace {
std::string content;
std::vector<std::array<int, 2>> visible;
int selectedStart = 0, selectedEnd = 0, reads = 0, visibilityReads = 0;
int caretScalar = 0;
bool viewportOnly = false;
// A GTK4 terminal answers no bounded ranges; the offsets under the viewport's top and bottom points.
bool noBoundedRanges = false; int pointTop = 0, pointBottom = 0;
// The offsets at the rows above the bottom point (window y, rows 16 high), -1 where none is given.
std::map<int, int> pointRows;
bool selectionOnly = false, mutate = false, shortRead = false, focused = true;
void expect(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void reset(std::string value) {
    content = std::move(value); visible.clear(); selectedStart = selectedEnd = reads = visibilityReads = 0;
    caretScalar = 0; viewportOnly = noBoundedRanges = false; pointTop = pointBottom = 0; pointRows.clear();
    selectionOnly = mutate = shortRead = false; focused = true;
}
}
extern "C" void __wrap_atspi_accessible_clear_cache(AtspiAccessible*) {}
extern "C" AtspiText* __wrap_atspi_accessible_get_text_iface(AtspiAccessible* value) { return reinterpret_cast<AtspiText*>(g_object_ref(value)); }
extern "C" gchar* __wrap_atspi_accessible_get_name(AtspiAccessible*, GError**) { return g_strdup(content.c_str()); }
extern "C" gint __wrap_atspi_text_get_character_count(AtspiText*, GError**) { return g_utf8_strlen(content.c_str(), -1); }
extern "C" gint __wrap_atspi_text_get_n_selections(AtspiText*, GError**) { return 1; }
extern "C" AtspiRange* __wrap_atspi_text_get_selection(AtspiText*, gint, GError**) {
    auto result = g_new0(AtspiRange, 1); result->start_offset = selectedStart; result->end_offset = selectedEnd; return result;
}
extern "C" gint __wrap_atspi_text_get_caret_offset(AtspiText*,GError**) { return caretScalar; }
extern "C" AtspiRect* __wrap_atspi_text_get_character_extents(AtspiText*,gint,AtspiCoordType,GError**) {
    auto value=g_new0(AtspiRect,1);value->x=20;value->y=30;value->width=8;value->height=16;return value;
}
extern "C" AtspiStateSet* __wrap_atspi_accessible_get_state_set(AtspiAccessible*) {
    auto result = atspi_state_set_new(nullptr); atspi_state_set_add(result, ATSPI_STATE_SHOWING);
    if (focused) atspi_state_set_add(result, ATSPI_STATE_FOCUSED);
    return result;
}
extern "C" gchar* __wrap_atspi_text_get_text(AtspiText*, gint from, gint to, GError**) {
    expect(from >= 0 && to >= from && to - from <= 4096, "all source calls are bounded exact chunks");
    if (selectionOnly) expect(from >= selectedStart && to <= selectedEnd, "selection must never acquire adjacent source");
    if (viewportOnly) expect(std::any_of(visible.begin(),visible.end(),[&](auto span){return from>=span[0] && to<=span[1];}), "terminal read never reaches hidden source");
    ++reads;
    auto value = g_utf8_substring(content.c_str(), from, shortRead && to > from ? to - 1 : to);
    if (mutate) { ++selectedStart; content += "!"; mutate = false; }
    return value;
}
extern "C" GArray* __wrap_atspi_text_get_bounded_ranges(AtspiText*, gint x, gint y, gint width, gint height,
    AtspiCoordType coords, AtspiTextClipType clipX, AtspiTextClipType clipY, GError**) {
    expect(!selectionOnly, "selection must not query text-bearing visibility");
    expect(x == 10 && y == 20 && width == 80 && height == 60 && coords == ATSPI_COORD_TYPE_WINDOW,
        "bounded range uses intersected window coordinates and width/height");
    expect(clipX == ATSPI_TEXT_CLIP_NONE && clipY == ATSPI_TEXT_CLIP_NONE, "partially clipped glyphs remain visible");
    ++visibilityReads;
    auto result = g_array_new(FALSE, FALSE, sizeof(AtspiTextRange));
    if (noBoundedRanges) return result; // A GTK4 terminal (Ptyxis) answers none.
    for (auto span : visible) {
        // Real API owns nested strings; adapter must release them even on error.
        AtspiTextRange range{span[0], span[1], g_strdup("discarded provider snapshot")};
        g_array_append_val(result, range);
    }
    return result;
}
// The offset under a window point: the first visible line's at the top, the last one's below.
extern "C" gint __wrap_atspi_text_get_offset_at_point(AtspiText*, gint x, gint y, AtspiCoordType coords, GError**) {
    expect(x == 11 && coords == ATSPI_COORD_TYPE_WINDOW && (y == 21 || y == 79 || y == 63 || y == 47 || y == 31),
        "the viewport's top point, then its bottom one and a row higher at a time, never below the viewport");
    if (y == 21) return pointTop;
    if (y == 79) return pointBottom;
    const auto row = pointRows.find(y); return row == pointRows.end() ? -1 : row->second;
}
extern "C" AtspiTextRange* __wrap_atspi_text_get_string_at_offset(AtspiText*, gint offset, AtspiTextGranularity granularity, GError**) {
    expect(granularity == ATSPI_TEXT_GRANULARITY_LINE, "whole lines");
    const auto start = content.rfind('\n', offset == 0 ? std::string::npos : static_cast<size_t>(offset) - 1);
    const auto from = static_cast<int>(start == std::string::npos || offset == 0 ? 0 : start + 1);
    const auto next = content.find('\n', static_cast<size_t>(offset));
    const auto to = static_cast<int>(next == std::string::npos ? content.size() : next + 1);
    auto value = g_new0(AtspiTextRange, 1);
    value->start_offset = from; value->end_offset = to; value->content = g_strdup("discarded line");
    return value;
}
int main() {
    auto node = voice::own(static_cast<AtspiAccessible*>(g_object_new(ATSPI_TYPE_ACCESSIBLE, nullptr)));
    const auto field = [&] {
        voice::LiveScreenTree tree(node); voice::VisibleContext context;
        tree.appendFieldSource(node, voice::ContextFrame{0, 0, 90, 80}, context, voice::ContextFrame{10, 20, 100, 100});
        return context.render();
    };
    {
        reset(std::string(20001, 'a'));
        voice::LiveScreenTree tree(node);
        expect(tree.screenText(node) == content, "static screen text crosses historical 20000-unit limit intact");
    }
    {
        reset("Visible. password: " + std::string(600000, 'x'));
        voice::LiveScreenTree tree(node);
        expect(tree.screenText(node) == "Visible. ", "static source withholds incomplete credential suffix");
        expect(tree.label(node) == "Visible. ", "native name snapshot follows the same source bound");
    }
    {
        reset("changed static"); mutate = true;
        voice::LiveScreenTree tree(node); bool refused = false;
        try { (void)tree.screenText(node); } catch (const std::exception&) { refused = true; }
        expect(refused, "static range count change refuses");
    }
    reset("Short field"); expect(field() == "> Short field" && visibilityReads == 0, "short fields retain whole-value capability");
    std::string emoji; for (int i = 0; i < 15000; ++i) emoji += "😀";
    reset(emoji); expect(!field().empty() && visibilityReads == 0, "whole eligibility uses graphemes, not UTF8 length");
    reset(std::string(300000, 'x') + ". password: syntheticSecret123. End. ");
    const auto start = static_cast<int>(content.find("syntheticSecret123"));
    visible = {{start, start + 18}};
    const auto redacted = field();
    expect(redacted.find("syntheticSecret") == std::string::npos && redacted.find("[redacted]") != std::string::npos,
        "offscreen credential label participates in visible redaction");
    expect(redacted.find("password:") == std::string::npos && visibilityReads == 2, "private source never renders and visibility rechecks");
    reset(std::string(300000, 'x') + ". First. HIDDEN GAP. Second. End. ");
    const auto first = static_cast<int>(content.find("First")), second = static_cast<int>(content.find("Second"));
    visible = {{second, second + 7}, {first, first + 6}};
    const auto separate = field();
    expect(separate.find("First.") != std::string::npos && separate.find("HIDDEN GAP") == std::string::npos,
        "visible targets cannot include hidden gaps");
    reset(std::string(300000, 'x')); visible = {{-1, 5}};
    bool refused = false; try { (void)field(); } catch (const std::exception&) { refused = true; }
    expect(refused && reads == 0, "invalid visible offsets refuse before GetText");
    reset("short"); shortRead = true; refused = false;
    try { (void)field(); } catch (const std::exception&) { refused = true; }
    expect(refused, "short exact response never becomes a whole field");
    reset("short"); mutate = true; refused = false;
    try { (void)field(); } catch (const std::exception&) { refused = true; }
    expect(refused, "changed count cannot commit a field");
    for (const auto& selected : {std::string(20001, 's'), emoji, std::string(262139, 's')}) {
        reset("private prefix " + selected + " private suffix"); selectionOnly = true;
        selectedStart = 15; selectedEnd = selectedStart + g_utf8_strlen(selected.c_str(), -1);
        voice::LiveScreenTree tree(node); const auto result = tree.selection(node);
        expect(result.has_value(), "selection result exists");
        if (selected.size() > 262138) expect(result->selectionUnavailable, "oversize selection refuses");
        else expect(!result->selectionUnavailable && result->parts[1] == selected && result->parts[0].empty() && result->parts[2].empty(),
            "entire selected interval preserved without adjacent content");
    }
    reset("private selected suffix"); selectionOnly = mutate = true; selectedStart = 8; selectedEnd = 16;
    voice::LiveScreenTree tree(node);
    expect(tree.selection(node)->selectionUnavailable, "changed selection refuses");
    const auto viewport=[&](size_t budget = 262144) {
        voice::LiveScreenTree tree(node);
        return tree.viewportSurface(node,1,{10,20,80,60},true,budget);
    };
    reset("HIDDEN!first line\n> hello world\nstatus bar\n  HIDDEN!");
    viewportOnly=true;visible={{7,static_cast<int>(content.size())-7}};caretScalar=7+18;
    auto projected=viewport();
    expect(projected["surface"]["runs"][0]["text"]=="first line\n> hello world\nstatus bar\n  " && projected["caret"]["offset"]==18,
        "terminal preserves full visible text and Mac reference caret");
    reset("HIDDEN!界😀é chosen tailHIDDEN!");viewportOnly=true;
    visible={{7,static_cast<int>(g_utf8_strlen(content.c_str(),-1))-7}};caretScalar=9;selectedStart=12;selectedEnd=18;
    projected=viewport();
    expect(projected["caret"]["offset"]==2 && projected["surface"]["selection"]["ranges"][0]["start"]==5,
        "AT-SPI independent scalar cursor and selection stay separate before Rust conversion");
    reset("leftHIDDENright");viewportOnly=true;visible={{0,4},{10,15}};selectedStart=0;selectedEnd=15;caretScalar=2;
    projected=viewport();
    expect(projected["surface"]["selection"]["complete"]==false && projected["surface"]["runs"][1]["connected"]==false,
        "selection spanning hidden gap is incomplete without acquiring hidden source");
    reset("displayed text");viewportOnly=true;visible={{0,14}};caretScalar=14;
    expect(viewport()["caret"]["status"]=="unavailable", "VTE offscreen end-offset cannot become exact cursor");
    caretScalar=0;expect(viewport()["caret"]["status"]=="unavailable", "ambiguous start-offset cannot become exact cursor");
    // Output arriving during the read keeps the text read at key-down (owner, 2026-10-05).
    reset("HIDDEN!shownHIDDEN!");viewportOnly=true;visible={{7,12}};caretScalar=9;mutate=true;
    expect(viewport()["surface"]["runs"][0]["text"]=="shown","changed terminal source keeps the text read at key-down");
    // A GTK4 terminal answers no bounded ranges: the whole lines between the viewport's corners.
    reset("hidden history\nfirst line\n> hello\nstatus\nhidden below");viewportOnly=true;noBoundedRanges=true;
    visible={{15,41}};pointTop=17;pointBottom=36;caretScalar=0;selectedStart=selectedEnd=0;
    expect(viewport()["surface"]["runs"][0]["text"]=="first line\n> hello\nstatus\n","GTK4 terminal reads the lines at the viewport's corners");
    // Output that ends above the viewport's bottom: the rows below it have no text, and the read ends
    // at the last row that has.
    reset("hidden history\nfirst line\n> hello\n");viewportOnly=true;noBoundedRanges=true;
    visible={{15,34}};pointTop=17;pointBottom=-1;pointRows={{31,28}};caretScalar=0;selectedStart=selectedEnd=0;
    expect(viewport()["surface"]["runs"][0]["text"]=="first line\n> hello\n","below the last output line the read ends at the last row with text");
    // Scrolled back, the bottom point can miss (padding, a partial row) with newer output below the
    // viewport, which was never on the screen: the read ends at the last row inside the viewport.
    reset("hidden history\nfirst line\n> hello\nstatus\nnewer output below");viewportOnly=true;noBoundedRanges=true;
    visible={{15,41}};pointTop=17;pointBottom=-1;pointRows={{63,36}};caretScalar=0;selectedStart=selectedEnd=0;
    expect(viewport()["surface"]["runs"][0]["text"]=="first line\n> hello\nstatus\n","text below a scrolled-back viewport is never read as the screen");
    // The budget is in UTF-8 bytes and at most that many scalars are read: ASCII text exactly at the
    // budget is read, and text whose scalars fit but whose bytes don't is refused by the core.
    reset("HIDDEN!first line\n> hello world\nstatus bar\n  HIDDEN!");viewportOnly=true;
    visible={{7,static_cast<int>(content.size())-7}};caretScalar=7+18;selectedStart=selectedEnd=0;
    expect(viewport(38)["surface"]["runs"][0]["text"]=="first line\n> hello world\nstatus bar\n  ","ASCII text at the byte budget is read whole");
    reset("HIDDEN!界界界界界HIDDEN!");viewportOnly=true;visible={{7,12}};caretScalar=9;selectedStart=selectedEnd=0;
    bool refused=false;
    try { viewport(10); } catch (const std::exception&) { refused=true; }
    expect(refused,"text whose scalars fit the budget but whose bytes don't is refused");
    // A malformed selection is withheld, and the surface kept.
    for (const auto& [start, end] : std::vector<std::pair<int,int>>{{6,3},{2,50}}) {
        reset("left right");viewportOnly=true;visible={{0,10}};caretScalar=2;selectedStart=start;selectedEnd=end;
        projected=viewport();
        expect(projected["surface"]["runs"][0]["text"]=="left right" && projected["surface"]["selection"]==nlohmann::json{{"complete",false},{"ranges",nlohmann::json::array()}},
            "a malformed selection is withheld and the surface kept");
    }
    std::cout << "Live AT-SPI field and selection source tests passed\n";
}
