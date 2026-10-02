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
};
struct Tree {
    using Node = Element*;
    unsigned counts = 0, selections = 0, values = 0, titles = 0;
    bool budget = true;
    Node expireAfterLabel = nullptr;
    bool withinBudget() { return budget; }
    bool same(Node first, Node second) { return first == second; }
    AtspiRole role(Node node) { if (!budget) throw voice::ScreenBudgetExceeded(); return node->role; }
    bool isPassword(Node node) { return node->role == ATSPI_ROLE_PASSWORD_TEXT; }
    std::optional<voice::PageHost> page(Node node) { return node->page; }
    std::vector<Node> children(Node node, size_t limit) {
        if (node->children.size() > limit) throw std::runtime_error("fixture child budget");
        return node->children;
    }
    bool editable(Node node) { return node->editable; }
    bool shown(Node) { return true; }
    std::optional<voice::ContextFrame> frame(Node node) { return node->bounds; }
    std::string label(Node node) { if (node == expireAfterLabel) budget = false; if (node->role == ATSPI_ROLE_FRAME) ++titles; else ++values; return node->label; }
    std::optional<std::string> field(Node node, int) { ++counts; ++values; return node->label; }
    std::optional<voice::CaretText> caret(Node node) { if (node->role != ATSPI_ROLE_ENTRY && !node->editable) return {}; ++counts; ++selections; ++values; return voice::CaretText{{"Reply ", "synthetic", " after"}}; }
};
struct CollectionTree : Tree {
    std::optional<std::vector<Node>> census;
    unsigned childQueries = 0;
    std::optional<std::vector<Node>> privacyNodes(Node) { return census; }
    std::vector<Node> children(Node node, size_t limit) { ++childQueries; return Tree::children(node, limit); }
};
static void expect(bool value, const char* description) { if (!value) throw std::runtime_error(description); }
int main() {
    const voice::AppIdentity app{"synthetic.desktop", "Synthetic"};
    const voice::ScreenExclusions policy(JSON{{"excludedAppIDs", JSON::array()}, {"excludedHosts", {"secret.example"}}});
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
    Element checkbox{ATSPI_ROLE_CHECK_BOX, "Include replies", {}, {}};
    page.page = voice::hostOfAddress("https://allowed.example/"); page.children = {&field, &checkbox}; window.children = {&page}; tree = Tree{};
    result = voice::gatherScreen(tree, &window, &field, {&page, &window}, app, policy);
    expect(result["renderedText"].get<std::string>().find("Include replies") != std::string::npos, "web checkbox text is content");
    window.children = {&heading, &field};
    tree = Tree{}; tree.expireAfterLabel = &heading;
    result = voice::gatherScreen(tree, &window, &field, {&window}, app, policy);
    expect(result.is_object() && result["renderedText"].get<std::string>().find("Conversation") != std::string::npos,
        "budget stop retains collected text without a final provider query");
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
    bulk.census = std::vector<Element*>{&page}; bulk.budget = false;
    expect(!voice::safeSubtree(bulk, &page, policy, true), "bulk query cannot bypass time budget");
    std::cout << "screen semantic layout and password/page access census passed\n";
}
