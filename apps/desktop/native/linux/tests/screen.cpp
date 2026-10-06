// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/screen.h"
#include <iostream>
using JSON = nlohmann::json;
struct Element {
    AtspiRole role;
    std::string label;
    std::optional<voice::PageHost> page;
    std::vector<Element*> children;
    bool editable = false;
    std::optional<voice::ContextFrame> bounds = {};
    std::string selected = {};
    bool visible = true, fieldAvailable = true;
};
struct Tree {
    using Node = Element*;
    unsigned counts = 0, selections = 0, values = 0, titles = 0;
    unsigned terminalSelections = 0;
    std::optional<voice::CaretText> caretOverride;
    bool budget = true;
    Node expireAfterLabel = nullptr, expireAfterPage = nullptr;
    bool withinBudget() { return budget; }
    bool same(Node first, Node second) { return first == second; }
    AtspiRole role(Node node) { if (!budget) throw voice::ScreenBudgetExceeded(); return node->role; }
    bool isPassword(Node node) { return node->role == ATSPI_ROLE_PASSWORD_TEXT; }
    std::optional<voice::PageHost> page(Node node) { if (node == expireAfterPage) budget = false; return node->page; }
    std::vector<Node> children(Node node, size_t limit) {
        if (node->children.size() > limit) throw std::runtime_error("fixture child budget");
        return node->children;
    }
    bool editable(Node node) { return node->editable; }
    bool shown(Node node) { return node->visible; }
    std::optional<voice::ContextFrame> frame(Node node) { return node->bounds; }
    std::string label(Node node) { if (node == expireAfterLabel) budget = false; if (node->role == ATSPI_ROLE_FRAME) ++titles; else ++values; return node->label; }
    std::optional<std::string> field(Node node, int) { ++counts; if (!node->fieldAvailable) return {}; ++values; return node->label; }
    JSON viewportSurface(Node node,size_t id,voice::ContextFrame frame,bool focused,size_t budget) {
        ++counts;
        if(!node->fieldAvailable || node->label.size()>budget) throw std::runtime_error("synthetic viewport unavailable");
        ++values;
        JSON ranges=JSON::array();
        if(!node->selected.empty()) {
            const auto at=node->label.find(node->selected);
            if(at==std::string::npos) throw std::runtime_error("fixture selection outside source");
            ranges.push_back({{"run",0},{"start",g_utf8_strlen(node->label.substr(0,at).c_str(),-1)},
                {"end",g_utf8_strlen(node->label.substr(0,at+node->selected.size()).c_str(),-1)}});
        }
        JSON caret={{"status","unavailable"}};
        if(focused && node->label.starts_with("first line\n> hello")) caret={{"status","exact"},{"surface",id},{"run",0},{"offset",18}};
        return {{"surface",{{"id",id},{"frame",{frame.x,frame.y,frame.width,frame.height}},
            {"runs",JSON::array({{{"id",0},{"text",node->label},{"connected",false},{"startKnown",false},{"endKnown",false}}})},
            {"selection",{{"complete",!caretOverride || !caretOverride->selectionUnavailable},{"ranges",ranges}}}}},{"caret",caret},{"offsetUnit","scalar"}};
    }
    std::optional<voice::CaretText> selection(Node node) { ++terminalSelections; if (caretOverride) return caretOverride; return voice::CaretText{{"", node->selected, ""}}; }
    std::optional<voice::CaretText> caret(Node node) { if (node->role != ATSPI_ROLE_ENTRY && !node->editable) return {}; ++counts; ++selections; ++values; if (caretOverride) return caretOverride; return voice::CaretText{{"Reply ", "synthetic", " after"}}; }
};
struct ProjectedTree : Tree {
    void appendFieldSource(Node node, const std::optional<voice::ContextFrame>&, voice::VisibleContext& context,
                           const std::optional<voice::ContextFrame>& frame) {
        ++values;
        context.appendField({"password: ", node->label, ""}, frame);
    }
};
struct CollectionTree : Tree {
    std::optional<std::vector<Node>> census;
    unsigned childQueries = 0;
    std::optional<std::vector<Node>> privacyNodes(Node) { return census; }
    std::vector<Node> children(Node node, size_t limit) { ++childQueries; return Tree::children(node, limit); }
};
static void expect(bool value, const char* description) { if (!value) throw std::runtime_error(description); }
int main() {
    expect(voice::completeProviderRange("é😀", 7, 9), "AT-SPI spans count Unicode scalars, not UTF-8 bytes");
    expect(voice::completeProviderRange("", 7, 7), "complete empty range is valid");
    expect(!voice::completeProviderRange("prefix", 0, 10), "short provider response cannot become a complete selection");
    expect(!voice::completeProviderRange("extra", 0, 4), "overlong provider response is refused");
    expect(!voice::completeProviderRange(nullptr, 0, 0), "missing response is not an empty range");
    expect(!voice::completeProviderRange("\xff", 0, 1), "invalid UTF-8 cannot satisfy a native character span");
    expect(!voice::completeProviderRange("", -1, -1), "negative native offsets are invalid");
    expect(!voice::completeProviderRange("", 2, 1), "reversed native offsets are invalid");

    {
        Element first{ATSPI_ROLE_TEXT, " same ", {}, {}};
        Element second{ATSPI_ROLE_TEXT, " same ", {}, {}};
        Element last{ATSPI_ROLE_TEXT, "must not be read after refusal", {}, {}};
        Element row{ATSPI_ROLE_TABLE_ROW, "", {}, {&first, &second, &last}};
        Tree tree;
        size_t visited = 0;
        const voice::ScreenExclusions none(JSON{{"excludedAppIDs", JSON::array()}, {"excludedHosts", JSON::array()}});
        auto rowText = [&](std::optional<voice::ContextFrame> window = {}) {
            visited = 0;
            return voice::semanticLabel(tree, &row, voice::SemanticText::Kind::row, visited, none, window);
        };
        expect(rowText() == "same | must not be read after refusal", "shared row normalization and canonical adjacent deduplication");
        last.visible = false; tree = Tree{};
        expect(rowText() == "same" && tree.counts == 2, "hidden semantic descendants are not read");
        last.visible = true; last.bounds = voice::ContextFrame{200, 200, 20, 20}; tree = Tree{};
        expect(rowText(voice::ContextFrame{0, 0, 100, 100}) == "same" && tree.counts == 2, "off-window semantic descendants are not read");
        last.bounds = voice::ContextFrame{0, 0, 20, 1}; tree = Tree{};
        expect(rowText() == "same" && tree.counts == 2, "clipped semantic descendants are not read");
        last.bounds = voice::ContextFrame{0, 0, 0, 0}; tree = Tree{};
        expect(rowText() == "same | must not be read after refusal", "a 0x0 cell in a row counts as shown");
        last.bounds = voice::ContextFrame{0, 0, 20, 1};
        row.label = "Root label"; tree = Tree{};
        expect(rowText() == "same" && tree.counts == 2 && tree.values == 2, "rows prefer approved cells without reading their generic root label");
        tree = Tree{}; visited = 0;
        expect(voice::semanticLabel(tree, &row, voice::SemanticText::Kind::heading, visited, none) == "Root label" && tree.counts == 0,
            "heading root prevents all descendant value reads");
        row.label.clear(); first.label = std::string(10000, 'a'); second.label = std::string(10000, 'b'); tree = Tree{};
        last.bounds.reset();
        expect(rowText() == first.label + " | " + second.label && tree.counts == 2,
            "budget stop keeps the final complete source fragment and prevents later value reads");
    }
    const voice::AppIdentity app{"synthetic.desktop", "Synthetic"};
    const voice::ScreenExclusions policy(JSON{{"excludedAppIDs", JSON::array()}, {"excludedHosts", {"secret.example"}}});
    {
        Element field{ATSPI_ROLE_ENTRY, "syntheticSecret123", {}, {}};
        Element row{ATSPI_ROLE_TABLE_ROW, "", {}, {&field}};
        Element window{ATSPI_ROLE_FRAME, "Synthetic", {}, {&row}};
        Element focus{ATSPI_ROLE_PUSH_BUTTON, "", {}, {}};
        ProjectedTree tree;
        const auto screen = voice::gatherScreen(tree, &window, &focus, {&window}, app, policy);
        expect(screen["renderedText"] == "| [redacted]", "production semantic walk preserves projected field recognition source");
    }
    {
        Element entry{ATSPI_ROLE_ENTRY, "", {}, {}, true};
        Element window{ATSPI_ROLE_FRAME, "Synthetic", {}, {&entry}};
        Tree tree;
        tree.caretOverride = voice::CaretText{{"before", "", "after"}, true};
        auto screen = voice::gatherScreen(tree, &window, &entry, {&window}, app, policy);
        expect(screen["selectionRedacted"] == true && screen["selectedText"] == "",
            "unavailable selection disables Edit even when final redaction changes no bytes");
        tree.caretOverride = voice::CaretText{{"before ", std::string(20001, 'x'), " after"}, false};
        screen = voice::gatherScreen(tree, &window, &entry, {&window}, app, policy);
        expect(screen["selectedText"] == std::string(20001, 'x') && screen["selectionRedacted"] == false,
            "full selection crosses the old native 20000-character limit intact");
    }
    {
        Element terminal{ATSPI_ROLE_TERMINAL, "first line\n> hello world\nstatus bar", {}, {}, true};
        Element terminalWindow{ATSPI_ROLE_FRAME, "Synthetic terminal", {}, {&terminal}};
        terminal.bounds=voice::ContextFrame{0,0,400,200};terminalWindow.bounds=terminal.bounds;
        Tree terminalTree;
        auto screen=voice::gatherScreen(terminalTree,&terminalWindow,&terminal,{&terminalWindow},app,policy);
        expect(screen["terminalViewport"]["caret"]["status"]=="exact" && screen["terminalViewport"]["caret"]["offset"]==18,
            "live terminal dispatch preserves reference typed caret");
        expect(screen["renderedText"]=="[Terminal surface 0]\nfirst line\n> hello world\nstatus bar" && terminalTree.selections==0 && terminalTree.terminalSelections==0,
            "terminal never enters generic caret/selection or field path");
        terminal.selected="hello";terminalTree=Tree{};
        screen=voice::gatherScreen(terminalTree,&terminalWindow,&terminal,{&terminalWindow},app,policy);
        expect(screen["selectedText"]=="hello" && screen["textBeforeCaret"]=="" && screen["textAfterCaret"]=="", "selection remains independent on wire");
        terminalTree=Tree{};terminalTree.caretOverride=voice::CaretText::unavailable();
        screen=voice::gatherScreen(terminalTree,&terminalWindow,&terminal,{&terminalWindow},app,policy);
        expect(screen["selectedText"]=="[redacted]" && screen["selectionRedacted"]==true,"incomplete terminal selection disables edit");
        terminal.selected.clear();terminal.label="build passed\ntoken=syntheticSecret123";terminalTree=Tree{};
        screen=voice::gatherScreen(terminalTree,&terminalWindow,&terminal,{&terminalWindow},app,policy);
        expect(screen.dump().find("syntheticSecret123")==std::string::npos && screen["terminalViewport"]["caret"]["status"]=="unavailable","source is redacted before any wire/log fields");
        Element other{ATSPI_ROLE_TERMINAL,terminal.label,{}, {}};other.bounds=terminal.bounds;
        other.visible=false;terminalWindow.children.push_back(&other);terminalTree=Tree{};
        screen=voice::gatherScreen(terminalTree,&terminalWindow,&terminal,{&terminalWindow},app,policy);
        expect(screen["terminalViewport"]["surfaces"].size()==1 && terminalTree.counts==1,"hidden terminal is never acquired; visible one is read once");
        other.visible=true;terminalTree=Tree{};
        screen=voice::gatherScreen(terminalTree,&terminalWindow,&terminal,{&terminalWindow},app,policy);
        expect(screen["terminalViewport"]["surfaces"].size()==2,"identical visible terminal surfaces are not text-deduplicated");
        terminalWindow.children.pop_back();terminal.fieldAvailable=false;terminalTree=Tree{};
        screen=voice::gatherScreen(terminalTree,&terminalWindow,&terminal,{&terminalWindow},app,policy);
        expect(screen["renderedText"]=="" && screen["terminalViewport"]["complete"]==false,"unavailable terminal source has no legacy fallback");
        terminal.fieldAvailable=true;
        Element child{ATSPI_ROLE_TEXT,"child is not independently read",{}, {},true};terminal.children={&child};terminalTree=Tree{};
        screen=voice::gatherScreen(terminalTree,&terminalWindow,&child,{&terminal,&terminalWindow},app,policy);
        expect(screen["terminalViewport"]["surfaces"].size()==1 && screen.dump().find(child.label)==std::string::npos,"child focus binds its containing terminal");
        child.role=ATSPI_ROLE_PASSWORD_TEXT;terminalTree=Tree{};
        screen=voice::gatherScreen(terminalTree,&terminalWindow,&terminal,{&terminalWindow},app,policy);
        expect(terminalTree.counts==0 && screen.dump().find("build passed")==std::string::npos,"nested password prevents aggregate terminal acquisition");
        child.role=ATSPI_ROLE_DOCUMENT_WEB;child.page=voice::hostOfAddress("https://secret.example/");terminalTree=Tree{};
        screen=voice::gatherScreen(terminalTree,&terminalWindow,&terminal,{&terminalWindow},app,policy);
        expect(screen==voice::hiddenScreen() && terminalTree.counts==0 && terminalTree.titles==0,"excluded terminal page refuses before content");
    }
    Element field{ATSPI_ROLE_ENTRY, "Synthetic field", {}, {}};
    Element password{ATSPI_ROLE_PASSWORD_TEXT, "must never be read", {}, {}};
    Element heading{ATSPI_ROLE_HEADING, "Conversation", {}, {}};
    Element window{ATSPI_ROLE_FRAME, "password: syntheticvalue123", {}, {&heading, &field, &password}};
    Tree tree;
    auto result = voice::gatherScreen(tree, &window, &field, {&window}, app, policy);
    expect(!(result == voice::hiddenScreen()) && result["renderedText"] == "## Conversation\n» Reply ‸synthetic‸ after", "semantic heading and shared caret formatting");
    expect(tree.counts == 1 && tree.selections == 1 && tree.values == 2 && tree.titles == 1, "password sibling performs no text/count/selection access");
    expect(result["windowTitle"] == "password: [redacted]" && result.dump().find("syntheticvalue123") == std::string::npos,
        "window title redacts secrets while preserving normal screen context");
    tree = Tree{};
    result = voice::gatherScreen(tree, &window, &password, {&window}, app, policy);
    expect(result["selectedText"] == "" && tree.counts == 1 && tree.selections == 0, "focused password refused before count or selection");
    field.children.push_back(&password);
    tree = Tree{};
    result = voice::gatherScreen(tree, &window, &field, {&window}, app, policy);
    expect(tree.counts == 0 && tree.selections == 0, "aggregating field with nested password never read");
    field.children.clear();
    Element page{ATSPI_ROLE_DOCUMENT_WEB, "not read", voice::hostOfAddress("https://secret.example/synthetic"), {&field}};
    window.children = {&page};
    tree = Tree{};
    result = voice::gatherScreen(tree, &window, &field, {&page, &window}, app, policy);
    expect((result == voice::hiddenScreen()) && tree.counts == 0 && tree.selections == 0 && tree.values == 0 && tree.titles == 0, "excluded focused page refused before all content");
    window.children = {&field, &page};
    tree = Tree{};
    result = voice::gatherScreen(tree, &window, &field, {&window}, app, policy);
    expect(result == voice::hiddenScreen(), "excluded sibling page drops all gathered content");
    page.page = voice::PageHost{};
    tree = Tree{};
    result = voice::gatherScreen(tree, &window, &field, {&window}, app, policy);
    expect(result == voice::hiddenScreen(), "unknown page fails closed");
    tree = Tree{}; tree.budget = false;
    expect(voice::gatherScreen(tree, &window, &field, {&window}, app, policy).is_null() && tree.values == 0, "expired metadata scan authorizes no text");
    page.page = voice::hostOfAddress("https://allowed.example/");
    page.children = {&heading, &field}; window.children = {&page};
    tree = Tree{};
    result = voice::gatherScreen(tree, &window, &page, {&window}, app, policy);
    expect(result["renderedText"] == "## Conversation\n> Synthetic field" && tree.selections == 0,
        "focused web document walks visible children without reading an aggregated caret range");
    Element list{ATSPI_ROLE_LIST, "", {}, {&heading, &field}};
    window.children = {&list}; tree = Tree{};
    result = voice::gatherScreen(tree, &window, &list, {&window}, app, policy);
    expect(result["renderedText"] == "## Conversation\n> Synthetic field" && result["textBeforeCaret"] == "",
        "focused list is walked rather than replaced by a caret");
    page.editable = true; window.children = {&page}; tree = Tree{};
    result = voice::gatherScreen(tree, &window, &page, {&window}, app, policy);
    expect(result["renderedText"] == "» Reply ‸synthetic‸ after", "editable focused web document is a caret field");
    page.editable = false;
    Element first{ATSPI_ROLE_TEXT, "First cell", {}, {}};
    Element second{ATSPI_ROLE_TEXT, "Second cell", {}, {}};
    Element row{ATSPI_ROLE_TABLE_ROW, "", {}, {&first, &second}};
    page.children = {&row, &field}; tree = Tree{};
    result = voice::gatherScreen(tree, &window, &field, {&page, &window}, app, policy);
    expect(result["renderedText"].get<std::string>().find("First cell") != std::string::npos &&
        result["renderedText"].get<std::string>().find("Second cell") != std::string::npos,
        "row gathers descendant text areas in document order");
    // A field containing a refused page is marked locally, rather than hiding its siblings.
    page.page = voice::hostOfAddress("https://secret.example/"); page.children.clear();
    Element framedField{ATSPI_ROLE_ENTRY, "must not be read", {}, {&page}};
    window.children = {&field, &framedField, &heading}; tree = Tree{};
    result = voice::gatherScreen(tree, &window, &field, {&window}, app, policy);
    expect(result.is_object() && result["renderedText"].get<std::string>().find("[hidden for privacy]") != std::string::npos &&
        result["renderedText"].get<std::string>().find("Conversation") != std::string::npos &&
        result.dump().find("must not be read") == std::string::npos, "framed excluded page marks its field and preserves other content");
    Element outside{ATSPI_ROLE_STATIC, "outside window", {}, {}};
    outside.bounds = voice::ContextFrame{200, 200, 20, 20}; window.bounds = voice::ContextFrame{0, 0, 100, 100};
    window.children = {&field, &outside}; tree = Tree{};
    result = voice::gatherScreen(tree, &window, &field, {&window}, app, policy);
    expect(result.dump().find("outside window") == std::string::npos, "off-window text is skipped");
    window.bounds.reset();
    // The hidden-box rule every platform shares (ADR-DESK-054): a box at most a pixel thin
    // either way shows nothing, a 0×0 frame says nothing and counts as shown, and a hidden
    // box is still walked into (Slack keeps its message list in a 1×2 one).
    {
        Element unsized{ATSPI_ROLE_STATIC, "Unsized words", {}, {}};
        unsized.bounds = voice::ContextFrame{10, 10, 0, 0};
        Element thin{ATSPI_ROLE_STATIC, "Thin words", {}, {}};
        thin.bounds = voice::ContextFrame{10, 30, 1, 20};
        Element message{ATSPI_ROLE_STATIC, "Listed message", {}, {}};
        message.bounds = voice::ContextFrame{10, 50, 80, 20};
        Element messages{ATSPI_ROLE_LIST, "", {}, {&message}};
        messages.bounds = voice::ContextFrame{10, 50, 1, 2};
        window.children = {&field, &unsized, &thin, &messages}; tree = Tree{};
        result = voice::gatherScreen(tree, &window, &field, {&window}, app, policy);
        const auto text = result["renderedText"].get<std::string>();
        expect(text.find("Unsized words") != std::string::npos, "a 0x0 box counts as shown");
        expect(text.find("Thin words") == std::string::npos, "a box a pixel thin shows nothing");
        expect(text.find("Listed message") != std::string::npos, "a hidden box is walked into");
        // A row's cells count toward the walk's 5000 nodes: one that uses them up stops the walk.
        std::vector<Element> cells(4997, Element{ATSPI_ROLE_PANEL, "", {}, {}});
        Element wide{ATSPI_ROLE_TABLE_ROW, "", {}, {}};
        for (auto& cell : cells) wide.children.push_back(&cell);
        Element after{ATSPI_ROLE_STATIC, "Unreached words", {}, {}};
        window.children = {&field, &wide, &after}; tree = Tree{};
        result = voice::gatherScreen(tree, &window, &field, {&window}, app, policy);
        expect(result["summary"].get<std::string>().find("stopped: node budget") != std::string::npos &&
            result["renderedText"].get<std::string>().find("Unreached words") == std::string::npos,
            "a walk out of nodes says so in the words every platform uses");
    }
    Element checkbox{ATSPI_ROLE_CHECK_BOX, "Include replies", {}, {}};
    page.page = voice::hostOfAddress("https://allowed.example/"); page.children = {&field, &checkbox}; window.children = {&page}; tree = Tree{};
    result = voice::gatherScreen(tree, &window, &field, {&page, &window}, app, policy);
    expect(result["renderedText"].get<std::string>().find("Include replies") != std::string::npos, "web checkbox text is content");
    window.children = {&heading, &field};
    tree = Tree{}; tree.expireAfterLabel = &heading;
    result = voice::gatherScreen(tree, &window, &field, {&window}, app, policy);
    expect(result.is_object() && result["renderedText"].get<std::string>().find("Conversation") != std::string::npos,
        "budget stop retains collected text without a final provider query");
    expect(result["summary"].get<std::string>().find("stopped: time budget") != std::string::npos,
        "a read out of time says so in the words every platform uses");
    {
        // A provider call that runs out of time inside an element stops the read the same way.
        struct Expiring : Tree {
            Node expireAt = nullptr;
            AtspiRole role(Node node) { if (node == expireAt) throw voice::ScreenBudgetExceeded(); return Tree::role(node); }
        };
        Expiring expiring; expiring.expireAt = &checkbox;
        window.children = {&heading, &checkbox, &field};
        result = voice::gatherScreen(expiring, &window, &field, {&window}, app, policy);
        expect(result.is_object() && result["renderedText"].get<std::string>().find("Conversation") != std::string::npos &&
            result["summary"].get<std::string>().find("stopped: time budget") != std::string::npos,
            "a provider call out of time says so too, keeping what was read");
    }
    // Provider-side metadata search must enforce the same policy without
    // visiting every ordinary descendant (large focused browser documents).
    CollectionTree bulk;
    page.page = voice::hostOfAddress("https://allowed.example/");
    bulk.census = std::vector<Element*>{&page};
    expect(voice::safeSubtree(bulk, &page, policy, true) && bulk.childQueries == 0,
        "bulk privacy census avoids per-descendant queries");
    bulk.census->push_back(&password);
    expect(!voice::safeSubtree(bulk, &page, policy, true) &&
        voice::safeSubtree(bulk, &page, policy, false), "bulk census protects nested passwords");
    page.page = voice::PageHost{};
    bool refused = false;
    try { voice::safeSubtree(bulk, &page, policy, false); } catch (const voice::PrivacyHidden&) { refused = true; }
    expect(refused && bulk.values == 0 && bulk.counts == 0, "bulk unknown page refuses before content");
    page.page = voice::hostOfAddress("https://secret.example/"); refused = false;
    try { voice::safeSubtree(bulk, &page, policy, false); } catch (const voice::PrivacyHidden&) { refused = true; }
    expect(refused, "bulk excluded page refuses");
    bulk.census = std::vector<Element*>(5001, &heading);
    expect(!voice::safeSubtree(bulk, &page, policy, false), "truncated bulk result never authorizes content");
    bulk.census.reset(); page.page = voice::hostOfAddress("https://allowed.example/"); page.children = {&heading};
    expect(voice::safeSubtree(bulk, &page, policy, true) && bulk.childQueries > 0,
        "unsupported or failed bulk request falls back to ordinary census");
    bulk.census = std::vector<Element*>{&page}; bulk.expireAfterPage = &page;
    expect(!voice::safeSubtree(bulk, &page, policy, true), "metadata response past deadline cannot authorize content");
    bulk.census = std::vector<Element*>{&page}; bulk.budget = false;
    expect(!voice::safeSubtree(bulk, &page, policy, true), "bulk query cannot bypass time budget");
    {
        // Without a provider collection the census walks the tree, fetching at most what the
        // node budget still allows, as the live tree does. The element looked inside is not
        // counted: as many elements inside it as the budget are seen whole, one more is not, and
        // what lies under the elements fetched at the budget's edge is still looked at.
        struct Truncating : Tree {
            std::vector<Node> children(Node node, size_t limit) {
                auto result = node->children;
                if (result.size() > limit) result.resize(limit);
                return result;
            }
        };
        const auto budget = voice::walk::limits().nodeBudget;
        Element hidden{ATSPI_ROLE_PASSWORD_TEXT, "", {}, {}};
        Element holder{ATSPI_ROLE_PANEL, "", {}, {&hidden}};
        std::vector<Element> fillers(budget, Element{ATSPI_ROLE_PANEL, "", {}, {}});
        Element wide{ATSPI_ROLE_PANEL, "", {}, {}};
        for (auto& filler : fillers) wide.children.push_back(&filler);
        Truncating census;
        expect(voice::safeSubtree(census, &wide, policy, true), "the budget's worth of elements inside is seen whole");
        Element extra{ATSPI_ROLE_PANEL, "", {}, {}};
        wide.children.push_back(&extra);
        expect(!voice::safeSubtree(census, &wide, policy, true), "one element more than the budget is not seen whole");
        wide.children.resize(budget - 2);
        wide.children.insert(wide.children.begin(), &holder);
        expect(!voice::safeSubtree(census, &wide, policy, true), "a password element under the budget's edge is still found");
        // Only visits count: an element fetched while others wait gets the visits left, so an
        // excluded page among its last children, visited first, is found.
        Element excluded{ATSPI_ROLE_DOCUMENT_WEB, "", voice::hostOfAddress("https://secret.example/"), {}};
        Element deep{ATSPI_ROLE_PANEL, "", {}, {}};
        for (size_t at = 0; at + 1 < budget; ++at) deep.children.push_back(&fillers[at]);
        deep.children.push_back(&excluded);
        Element side{ATSPI_ROLE_PANEL, "", {}, {}};
        Element top{ATSPI_ROLE_PANEL, "", {}, {&side, &deep}};
        bool found = false;
        try { voice::safeSubtree(census, &top, policy, true); } catch (const voice::PrivacyHidden&) { found = true; }
        expect(found, "what waits does not shrink a later element's fetch");
    }
    {
        // The shared walk's rules, as this helper applies them (ADR-DESK-054).
        Element focus{ATSPI_ROLE_ENTRY, "", {}, {}};
        Element frame{ATSPI_ROLE_FRAME, "Synthetic", {}, {}};
        const auto read = [&](std::vector<Element*> children, std::vector<Element*> path = {}) {
            frame.children = std::move(children);
            if (path.empty()) path = {&frame};
            Tree walked;
            return voice::gatherScreen(walked, &frame, &focus, path, app, policy);
        };
        const auto shows = [](const JSON& screen, const std::string& words) {
            return screen.is_object() && screen["renderedText"].get<std::string>().find(words) != std::string::npos;
        };
        // A list's item outside a page is a row, read as one line.
        Element sender{ATSPI_ROLE_STATIC, "Sender One", {}, {}};
        Element subject{ATSPI_ROLE_STATIC, "Quarterly plan", {}, {}};
        Element item{ATSPI_ROLE_LIST_ITEM, "", {}, {&sender, &subject}};
        expect(shows(read({&focus, &item}), "Sender One | Quarterly plan"), "a list item outside a page is a row");
        // A password element on the focus's path is walked into, its own text never read.
        Element beside{ATSPI_ROLE_STATIC, "Beside words", {}, {}};
        Element guard{ATSPI_ROLE_PASSWORD_TEXT, "must never be read", {}, {&focus, &beside}};
        auto screen = read({&guard}, {&guard, &frame});
        expect(shows(screen, "Beside words") && screen.dump().find("must never be read") == std::string::npos,
            "a password element on the focus's path is walked into");
        // Hidden text is not read, nor what it holds.
        Element under{ATSPI_ROLE_STATIC, "Under hidden words", {}, {}};
        Element hiddenText{ATSPI_ROLE_STATIC, "Hidden words", {}, {&under}};
        hiddenText.visible = false;
        screen = read({&focus, &hiddenText});
        expect(screen.is_object() && !shows(screen, "Hidden words") && !shows(screen, "Under hidden words"),
            "hidden text is not walked into");
        // A page's hidden control with a caption is looked through: an excluded page in it refuses.
        Element framed{ATSPI_ROLE_DOCUMENT_WEB, "", voice::hostOfAddress("https://secret.example/"), {}};
        Element button{ATSPI_ROLE_PUSH_BUTTON, "Pay", {}, {&framed}};
        button.bounds = voice::ContextFrame{10, 10, 1, 20};
        Element allowed{ATSPI_ROLE_DOCUMENT_WEB, "", voice::hostOfAddress("https://allowed.example/"), {&focus, &button}};
        expect(read({&allowed}, {&allowed, &frame}) == voice::hiddenScreen(), "a page's hidden control is looked through");
        // A row's parts are judged one by one: a button is chrome outside a page, content in one.
        Element archive{ATSPI_ROLE_PUSH_BUTTON, "Archive", {}, {}};
        Element row{ATSPI_ROLE_TABLE_ROW, "", {}, {&subject, &archive}};
        screen = read({&focus, &row});
        expect(shows(screen, "Quarterly plan") && !shows(screen, "Archive"), "a row's button outside a page is chrome");
        allowed.children = {&focus, &row};
        expect(shows(read({&allowed}, {&allowed, &frame}), "Quarterly plan | Archive"), "a row's button in a page is its caption");
    }
    std::cout << "screen semantic layout and password/page access census passed\n";
}
