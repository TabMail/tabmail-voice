// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/screen.h"
#include "../src/screen.h"
#include <map>
#include <iostream>
#include <functional>
#include <set>
#include <thread>

struct Item {
    AtspiRole role = ATSPI_ROLE_PANEL;
    std::optional<voice::PageHost> page;
    std::vector<voice::Node> children;
    std::string text;
};
static std::map<AtspiAccessible*, Item> items;
static bool supported = true, queryFails = false;
static std::set<GArray*> liveArrays;
extern "C" void __real_g_array_unref(GArray*);
extern "C" void __wrap_g_array_unref(GArray* value) { liveArrays.erase(value); __real_g_array_unref(value); }
extern "C" void __wrap_atspi_accessible_clear_cache(AtspiAccessible*) {}
static unsigned queries = 0, contentReads = 0, childReads = 0;
static voice::Node make(AtspiRole role, std::string text = "", std::optional<voice::PageHost> page = {}) {
    auto node = voice::own(reinterpret_cast<AtspiAccessible*>(g_object_new(G_TYPE_OBJECT, nullptr)));
    items.emplace(node.get(), Item{role, page, {}, text});
    return node;
}
extern "C" AtspiCollection* __wrap_atspi_accessible_get_collection_iface(AtspiAccessible* node) {
    return supported ? reinterpret_cast<AtspiCollection*>(g_object_ref(node)) : nullptr;
}
extern "C" GArray* __wrap_atspi_collection_get_matches(AtspiCollection* collection, AtspiMatchRule* rule,
    AtspiCollectionSortOrder, gint count, gboolean traverse, GError** error) {
    ++queries;
    if (queryFails) {
        g_set_error_literal(error, g_quark_from_static_string("synthetic-query"), 1, "synthetic failure");
        return nullptr;
    }
    auto result = g_array_new(FALSE, FALSE, sizeof(AtspiAccessible*));
    liveArrays.insert(result);
    std::function<void(AtspiAccessible*)> visit = [&](AtspiAccessible* parent) {
        for (const auto& child : items.at(parent).children) {
            if (count && result->len >= static_cast<unsigned>(count)) return;
            unsigned role = items.at(child.get()).role;
            bool matches = (static_cast<unsigned>(rule->roles[role / 32]) & (1U << (role % 32))) != 0;
            if (rule->rolematchtype == ATSPI_Collection_MATCH_ALL) {
                unsigned selected=0;
                for (auto bits : rule->roles) selected += __builtin_popcount(static_cast<unsigned>(bits));
                matches = matches && selected == 1;
            }
            if (rule->invert) matches = !matches;
            if (matches) { auto value = reinterpret_cast<AtspiAccessible*>(g_object_ref(child.get())); g_array_append_val(result, value); }
            if (traverse) visit(child.get());
        }
    };
    visit(reinterpret_cast<AtspiAccessible*>(collection));
    return result;
}
struct AdapterTree : voice::LiveScreenTree {
    AdapterTree() : voice::LiveScreenTree({}) {}
    AtspiRole role(const Node& n) { return items.at(n.get()).role; }
    bool isPassword(const Node& n) { return role(n) == ATSPI_ROLE_PASSWORD_TEXT; }
    std::optional<voice::PageHost> page(const Node& n) { return items.at(n.get()).page; }
    std::vector<Node> children(const Node& n, size_t limit) {
        ++childReads;
        auto result = items.at(n.get()).children;
        if (result.size() > limit) throw std::runtime_error("child budget");
        return result;
    }
    bool editable(const Node&) { return false; }
    bool shown(const Node&) { return true; }
    std::optional<voice::ContextFrame> frame(const Node&) { return {}; }
    std::string label(const Node& n) { ++contentReads; return items.at(n.get()).text; }
    std::optional<std::string> field(const Node& n, int) { ++contentReads; return items.at(n.get()).text; }
    std::optional<voice::CaretText> caret(const Node& n) { ++contentReads; return voice::CaretText{{"", items.at(n.get()).text, ""}}; }
};
static void check(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
int main() {
    const voice::AppIdentity app{"synthetic.desktop", "Synthetic"};
    const voice::ScreenExclusions policy(nlohmann::json{{"excludedAppIDs", nlohmann::json::array()}, {"excludedHosts", {"secret.example"}}});
    auto window = make(ATSPI_ROLE_FRAME, "Synthetic window");
    auto field = make(ATSPI_ROLE_ENTRY, "Synthetic allowed content");
    auto group = make(ATSPI_ROLE_PANEL);
    auto password = make(ATSPI_ROLE_PASSWORD_TEXT, "synthetic private text");
    auto allowed = make(ATSPI_ROLE_DOCUMENT_WEB, "", voice::hostOfAddress("https://allowed.example"));
    auto web = make(ATSPI_ROLE_DOCUMENT_WEB, "", voice::hostOfAddress("https://secret.example"));
    auto frame = make(ATSPI_ROLE_DOCUMENT_FRAME, "", voice::hostOfAddress("https://secret.example"));
    items.at(window.get()).children = {field};
    auto read = [&] { contentReads = childReads = queries = 0; AdapterTree tree; return voice::gatherScreen(tree, window, field, {window}, app, policy); };
    // A large ordinary subtree must still yield its permitted focused content.
    for (int i=0; i<5001; ++i) items.at(field.get()).children.push_back(make(ATSPI_ROLE_STATIC));
    auto result = read();
    check(result.is_object() && result["selectedText"] == "Synthetic allowed content" && contentReads > 0 && queries > 0, "allowed content reaches output through production query");
    items.at(field.get()).children.clear();

    for (const auto& excluded : {web, frame}) {
        items.at(field.get()).children = {group}; items.at(group.get()).children = {excluded};
        result = read();
        check(result == voice::hiddenScreen() && contentReads == 0 && queries > 0, "nested excluded document refused before content");
    }
    items.at(group.get()).children = {password};
    result = read();
    check(result["selectedText"] == "" && result.dump().find("synthetic private text") == std::string::npos, "aggregating focus with nested password has no caret content");
    check(contentReads == 1, "nested password allows only safe window title access");

    // Root objects are excluded from GetMatches, but correction learning checks the root too.
    { AdapterTree tree; check(!voice::safeSubtree(tree, password, policy, true), "root password must not authorize focusedFieldValue"); }
    items.at(field.get()).children = {password, web};
    result = read();
    check(result == voice::hiddenScreen() && contentReads == 0, "password does not hide a later excluded document from census");

    items.at(field.get()).children = {allowed, web};
    result = read();
    check(result == voice::hiddenScreen() && contentReads == 0, "all matching pages, including a later excluded page, are checked");
    queryFails = true;
    result = read();
    check(result == voice::hiddenScreen() && contentReads == 0 && childReads > 0, "query errors retain bounded privacy refusal");
    queryFails = false; supported = false;
    result = read();
    check(result == voice::hiddenScreen() && contentReads == 0 && childReads > 0, "unsupported Collection retains bounded privacy refusal");
    supported = true;
    check(liveArrays.empty(), "every returned collection allocation is released");
    for (const auto& n : {window, field, group, password, allowed, web, frame})
        check(G_OBJECT(n.get())->ref_count == 1, "provider object references return to their starting lifetime");
    {
        // A field read for corrections ends at its limit; a screen read has none (it runs in the
        // screen reader's own process, which the app ends when the read is no longer wanted).
        using Tree = voice::LiveScreenTree;
        Tree screen({}), field({}, Tree::fieldReadMilliseconds);
        std::this_thread::sleep_for(std::chrono::milliseconds(Tree::fieldReadMilliseconds + 200));
        check(!field.withinBudget(), "a field read ends at its limit");
        check(screen.withinBudget(), "a screen read runs past a field read's time");
    }
    std::cout << "adapter invariants passed: positive content, both page roles, nested password, root password, ordering, complete census, failed/unsupported query, screen read without a deadline\n";
}
