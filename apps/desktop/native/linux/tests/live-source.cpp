// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/screen.h"
#include <iostream>
namespace {
std::string content;
std::vector<std::array<int, 2>> visible;
int selectedStart = 0, selectedEnd = 0, reads = 0, visibilityReads = 0;
int caretScalar = 0;
bool viewportOnly = false;
bool selectionOnly = false, mutate = false, shortRead = false, focused = true;
void expect(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void reset(std::string value) {
    content = std::move(value); visible.clear(); selectedStart = selectedEnd = reads = visibilityReads = 0;
    caretScalar = 0; viewportOnly = false;
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
    for (auto span : visible) {
        // Real API owns nested strings; adapter must release them even on error.
        AtspiTextRange range{span[0], span[1], g_strdup("discarded provider snapshot")};
        g_array_append_val(result, range);
    }
    return result;
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
    const auto viewport=[&] {
        voice::LiveScreenTree tree(node);
        return tree.viewportSurface(node,1,{10,20,80,60},true,262144);
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
    reset("HIDDEN!shownHIDDEN!");viewportOnly=true;visible={{7,12}};caretScalar=9;mutate=true;refused=false;
    try{(void)viewport();}catch(const std::exception&){refused=true;}
    expect(refused,"changed terminal source/selection refuses atomically");
    std::cout << "Live AT-SPI field and selection source tests passed\n";
}
