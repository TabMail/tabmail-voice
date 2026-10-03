// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "accessibility.h"
#include "privacy.h"
#include "identity.h"
#include "../../shared/privacy/ScreenPrivacy.h"
#include <array>
#include <optional>

namespace voice {
struct ScreenBudgetExceeded : std::runtime_error { ScreenBudgetExceeded() : std::runtime_error("screen time budget") {} };
struct CaretText { std::array<std::string, 3> parts; };
class LiveScreenTree {
public:
    using Node = voice::Node;
    static constexpr size_t nodeBudget = 5000;
    explicit LiveScreenTree(const Node& root) {
        // A browser can publish its tree after our client first sees the window.
        // Refresh cached descendants for each read, including correction learning.
        atspi_accessible_clear_cache(root.get());
    }
    bool same(const Node& first, const Node& second) { return voice::same(first, second); }
    bool withinBudget() const { return std::chrono::steady_clock::now() < deadline; }
    AtspiRole role(const Node& node) { check(); return voice::role(node); }
    bool isPassword(const Node& node) { return role(node) == ATSPI_ROLE_PASSWORD_TEXT; }
    std::vector<Node> children(const Node& node, size_t limit) { check(); return voice::children(node, limit); }
    bool editable(const Node& node) { check(); return state(node, ATSPI_STATE_EDITABLE); }
    bool shown(const Node& node) { check(); return state(node, ATSPI_STATE_SHOWING); }
    std::optional<PageHost> page(const Node& node) {
        if (role(node) != ATSPI_ROLE_DOCUMENT_WEB && role(node) != ATSPI_ROLE_DOCUMENT_FRAME) return {};
        check();
        auto document = own(atspi_accessible_get_document_iface(node.get()));
        if (!document) return PageHost{};
        Error error;
        auto attributes = atspi_document_get_document_attributes(document.get(), &error.value);
        std::unique_ptr<GHashTable, decltype(&g_hash_table_unref)> owned(attributes, &g_hash_table_unref);
        if (error.value || !attributes) return PageHost{};
        // An answered attribute list establishes absence; an unavailable list does not.
        auto value = static_cast<const char*>(g_hash_table_lookup(attributes, "DocURL"));
        if (!value) value = static_cast<const char*>(g_hash_table_lookup(attributes, "URI"));
        return hostOfAddress(value ? std::string(value) : std::string{});
    }
    // Collection performs the role census in the provider, avoiding one D-Bus
    // round trip per descendant. Keep the ordinary walk for other providers.
    std::optional<std::vector<Node>> privacyNodes(const Node& node) {
        check();
        auto collection = own(atspi_accessible_get_collection_iface(node.get()));
        if (!collection) return {};
        auto roles = g_array_new(FALSE, FALSE, sizeof(AtspiRole));
        std::unique_ptr<GArray, decltype(&g_array_unref)> ownedRoles(roles, &g_array_unref);
        const AtspiRole wanted[] = {ATSPI_ROLE_DOCUMENT_WEB, ATSPI_ROLE_DOCUMENT_FRAME, ATSPI_ROLE_PASSWORD_TEXT};
        g_array_append_vals(roles, wanted, 3);
        auto rule = own(atspi_match_rule_new(nullptr, ATSPI_Collection_MATCH_ALL,
            nullptr, ATSPI_Collection_MATCH_ALL, roles, ATSPI_Collection_MATCH_ANY,
            nullptr, ATSPI_Collection_MATCH_ALL, FALSE));
        Error error;
        auto matches = atspi_collection_get_matches(collection.get(), rule.get(),
            ATSPI_Collection_SORT_ORDER_CANONICAL, nodeBudget + 1, TRUE, &error.value);
        std::unique_ptr<GArray, decltype(&g_array_unref)> ownedMatches(matches, &g_array_unref);
        std::vector<Node> result{node}; // Collection returns descendants, not its root.
        if (matches) for (guint i = 0; i < matches->len; ++i)
            result.push_back(own(g_array_index(matches, AtspiAccessible*, i)));
        if (error.value || !matches) return {};
        check();
        return result;
    }
    std::optional<ContextFrame> frame(const Node& node) {
        check();
        auto component = own(atspi_accessible_get_component_iface(node.get()));
        if (!component) return {};
        Error error;
        auto rectangle = atspi_component_get_extents(component.get(), ATSPI_COORD_TYPE_WINDOW, &error.value);
        std::unique_ptr<AtspiRect, decltype(&g_free)> owned(rectangle, &g_free);
        if (error.value || !rectangle) return {};
        return ContextFrame{static_cast<double>(rectangle->x), static_cast<double>(rectangle->y),
            static_cast<double>(rectangle->width), static_cast<double>(rectangle->height)};
    }
    std::string label(const Node& node) {
        check(); Error error;
        auto name = atspi_accessible_get_name(node.get(), &error.value);
        std::unique_ptr<gchar, decltype(&g_free)> owned(name, &g_free);
        error.check();
        if (!name) return {};
        if (!g_utf8_validate(name, -1, nullptr)) throw std::runtime_error("invalid provider label");
        // Bound UTF-8 without splitting a code point. Labels are semantic block text.
        const auto count = g_utf8_strlen(name, -1);
        const auto end = g_utf8_offset_to_pointer(name, std::min<glong>(count, 1000));
        return std::string(name, end);
    }
    std::optional<std::string> field(const Node& node, int maxLength) {
        check();
        auto text = own(atspi_accessible_get_text_iface(node.get()));
        if (!text) return {};
        Error error;
        const auto count = atspi_text_get_character_count(text.get(), &error.value);
        error.check();
        if (count < 0 || count > maxLength) return {};
        return range(text, 0, count);
    }
    std::optional<CaretText> caret(const Node& node) {
        check();
        auto text = own(atspi_accessible_get_text_iface(node.get()));
        if (!text) return {};
        Error error;
        const auto count = atspi_text_get_character_count(text.get(), &error.value); error.check();
        const auto offset = atspi_text_get_caret_offset(text.get(), &error.value); error.check();
        if (count < 0 || offset < 0 || offset > count) return {};
        int from = offset, to = offset;
        const auto selections = atspi_text_get_n_selections(text.get(), &error.value); error.check();
        if (selections < 0 || selections > 1) return {};
        if (selections) {
            auto selection = atspi_text_get_selection(text.get(), 0, &error.value);
            std::unique_ptr<AtspiRange, decltype(&g_free)> owned(selection, &g_free);
            error.check();
            if (!selection) return {};
            from = selection->start_offset; to = selection->end_offset;
            if (from < 0 || to < from || to > count || to - from > 20000) return {};
        }
        return CaretText{{range(text, std::max(0, from - 2000), from), range(text, from, to), range(text, to, to + std::min(2000, count - to))}};
    }
private:
    const std::chrono::steady_clock::time_point deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
    void check() const { if (!withinBudget()) throw ScreenBudgetExceeded(); }
    std::string range(const Object<AtspiText>& text, int from, int to) {
        check(); Error error;
        auto value = atspi_text_get_text(text.get(), from, to, &error.value);
        std::unique_ptr<gchar, decltype(&g_free)> owned(value, &g_free);
        error.check();
        if (!value || !g_utf8_validate(value, -1, nullptr) || g_utf8_strlen(value, -1) > to - from)
            throw std::runtime_error("invalid provider text");
        return value;
    }
};

// This metadata-only preflight precedes titles, values, counts and selections.
// Aggregated ranges may include descendants, so they need a password census too.
template<class Tree>
bool safeSubtree(Tree& tree, typename Tree::Node root, const ScreenExclusions& exclusions, bool prohibitPasswords) {
    if constexpr (requires { tree.privacyNodes(root); }) {
        if (auto nodes = tree.privacyNodes(root)) {
            if (nodes->size() > 5000) return false;
            for (const auto& node : *nodes) {
                if (!tree.withinBudget()) return false;
                if (tree.isPassword(node)) { if (prohibitPasswords) return false; else continue; }
                if (const auto page = tree.page(node); page && exclusions.excludes(*page)) throw PrivacyHidden{};
            }
            return tree.withinBudget();
        }
    }
    std::vector<typename Tree::Node> stack{root};
    size_t visited = 0;
    while (!stack.empty()) {
        if (++visited > 5000 || !tree.withinBudget()) return false;
        auto node = std::move(stack.back()); stack.pop_back();
        if (tree.isPassword(node)) { if (prohibitPasswords) return false; else continue; }
        if (const auto page = tree.page(node); page && exclusions.excludes(*page)) throw PrivacyHidden{};
        auto children = tree.children(node, 5000 - visited - stack.size());
        for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back(*it);
    }
    return tree.withinBudget();
}
inline bool skippedRole(AtspiRole role, bool web) {
    switch (role) {
        case ATSPI_ROLE_PUSH_BUTTON: case ATSPI_ROLE_TOGGLE_BUTTON: case ATSPI_ROLE_CHECK_BOX:
        case ATSPI_ROLE_RADIO_BUTTON: case ATSPI_ROLE_COMBO_BOX: case ATSPI_ROLE_TOOL_BAR: return !web;
        case ATSPI_ROLE_MENU_BAR: case ATSPI_ROLE_MENU: case ATSPI_ROLE_MENU_ITEM: case ATSPI_ROLE_IMAGE:
        case ATSPI_ROLE_SCROLL_BAR: case ATSPI_ROLE_SLIDER: case ATSPI_ROLE_SPIN_BUTTON: return true;
        default: return false;
    }
}
// Some providers put semantic row/link text in descendant text areas rather
// than the container name. Read these only after the caller's privacy census.
template<class Tree>
std::string semanticLabel(Tree& tree, typename Tree::Node root) {
    auto label = tree.label(root);
    if (!label.empty()) return label;
    auto initial = tree.children(root, 5000);
    std::vector<typename Tree::Node> stack(initial.rbegin(), initial.rend());
    size_t visited = 0;
    while (!stack.empty()) {
        if (++visited > 5000 || !tree.withinBudget()) throw std::runtime_error("semantic text budget");
        auto node = std::move(stack.back()); stack.pop_back();
        if (tree.isPassword(node)) continue;
        const auto role = tree.role(node);
        if (role == ATSPI_ROLE_TEXT || role == ATSPI_ROLE_ENTRY || role == ATSPI_ROLE_STATIC ||
            role == ATSPI_ROLE_PARAGRAPH || role == ATSPI_ROLE_LABEL) {
            const auto field = tree.field(node, 20000);
            const auto text = field ? *field : tree.label(node);
            if (!text.empty()) { if (!label.empty()) label += "\n"; label += text; }
            if (label.size() > 20000) throw std::runtime_error("semantic text budget");
            continue;
        }
        auto children = tree.children(node, 5000 - visited - stack.size());
        // Reverse the stack so document ordering is preserved.
        for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back(*it);
    }
    return label;
}
template<class Tree>
nlohmann::json gatherScreenUnchecked(Tree& tree, typename Tree::Node window, typename Tree::Node focus,
    const std::vector<typename Tree::Node>& path, const AppIdentity& app, const ScreenExclusions& exclusions) {
    using JSON = nlohmann::json;
    if (!tree.withinBudget()) return nullptr;
    std::optional<std::string> host;
    bool protectedFocus = false;
    for (const auto& node : path) {
        protectedFocus |= tree.isPassword(node);
        if (auto page = tree.page(node)) { if (exclusions.excludes(*page)) throw PrivacyHidden{}; if (!host && !page->name.empty()) host = page->name; }
    }
    if (auto page = tree.page(focus)) { if (exclusions.excludes(*page)) throw PrivacyHidden{}; if (!page->name.empty()) host = page->name; }
    // Match the reference: check the focus and its pages before asking for text.
    // Other pages are checked as the bounded walk reaches them; a refusal drops
    // everything gathered. A whole-window preflight exhausts the read budget in
    // browsers before even the focused field can be collected.
    if (!safeSubtree(tree, focus, exclusions, false)) return nullptr;
    std::array<std::string, 3> around{};
    const auto focusRole = tree.role(focus);
    const bool fieldInFocus = focusRole == ATSPI_ROLE_ENTRY || focusRole == ATSPI_ROLE_TEXT ||
        focusRole == ATSPI_ROLE_PASSWORD_TEXT || focusRole == ATSPI_ROLE_COMBO_BOX || tree.editable(focus);
    const bool readableFocus = !protectedFocus && safeSubtree(tree, focus, exclusions, true);
    if (readableFocus) if (auto caret = tree.caret(focus)) around = caret->parts;
    if (!fieldInFocus) { around[0].clear(); around[2].clear(); }
    // The focused page checks precede the title, as on macOS.
    const auto title = privacy::ScreenPrivacy::redact(tree.label(window));
    const auto windowFrame = tree.frame(window);
    VisibleContext context;
    std::vector<std::pair<typename Tree::Node, bool>> stack{{window, false}};
    while (!stack.empty()) {
        if (context.nodes >= 5000 || !tree.withinBudget()) { context.stopped = "lookup budget"; break; }
        try {
            auto [node, web] = std::move(stack.back()); stack.pop_back(); ++context.nodes;
            const auto role = tree.role(node);
            if (tree.isPassword(node) && !tree.same(node, focus)) continue;
            if (auto page = tree.page(node)) { if (exclusions.excludes(*page)) throw PrivacyHidden{}; web = true; if (!host && !page->name.empty()) host = page->name; }
            const auto frame = tree.frame(node);
            const bool shown = tree.shown(node) && (!frame || (frame->width > 1 && frame->height > 1));
            if (tree.same(node, focus)) {
                if (fieldInFocus) {
                    context.append(ContextKind::caret, "‸", frame);
                    continue;
                }
                if (!around[1].empty()) context.append(ContextKind::caret, "‸", frame);
            }
            const bool ancestor = !tree.same(node, focus) && std::any_of(path.begin(), path.end(), [&](const auto& parent) { return tree.same(parent, node); });
            if (!ancestor && windowFrame && frame && frame->width > 0 && frame->height > 0 &&
                (frame->x + frame->width <= windowFrame->x || frame->y + frame->height <= windowFrame->y ||
                 frame->x >= windowFrame->x + windowFrame->width || frame->y >= windowFrame->y + windowFrame->height)) continue;
            if (!ancestor && skippedRole(role, web)) continue;
            // A non-focused field is atomic, so a refused descendant replaces
            // that field only. A refused page reached elsewhere hides the window.
            if (!ancestor && (role == ATSPI_ROLE_TEXT || role == ATSPI_ROLE_ENTRY)) {
                if (shown) {
                    bool safe = false;
                    try { safe = safeSubtree(tree, node, exclusions, true); }
                    catch (const PrivacyHidden&) { /* The field carries the privacy marker. */ }
                    if (!safe) context.append(ContextKind::field, "[hidden for privacy]", frame);
                    else if (const auto value = tree.field(node, 20000)) context.append(ContextKind::field, *value, frame);
                }
                continue;
            }
            const bool webControl = web && (role == ATSPI_ROLE_PUSH_BUTTON || role == ATSPI_ROLE_TOGGLE_BUTTON ||
                role == ATSPI_ROLE_CHECK_BOX || role == ATSPI_ROLE_RADIO_BUTTON || role == ATSPI_ROLE_COMBO_BOX);
            const bool textRole = role == ATSPI_ROLE_TEXT || role == ATSPI_ROLE_ENTRY || role == ATSPI_ROLE_PARAGRAPH || role == ATSPI_ROLE_STATIC || role == ATSPI_ROLE_LABEL ||
                role == ATSPI_ROLE_HEADING || role == ATSPI_ROLE_LINK || role == ATSPI_ROLE_TABLE_ROW || webControl;
            if (!ancestor && shown && textRole) {
                if (!safeSubtree(tree, node, exclusions, true)) {
                    context.append(ContextKind::text, "[hidden for privacy]", frame);
                    continue;
                }
                if (role == ATSPI_ROLE_TEXT || role == ATSPI_ROLE_ENTRY || role == ATSPI_ROLE_PARAGRAPH || role == ATSPI_ROLE_STATIC || role == ATSPI_ROLE_LABEL) {
                    const auto field = tree.field(node, 20000);
                    const auto label = field ? *field : tree.label(node);
                    context.append(role == ATSPI_ROLE_ENTRY || role == ATSPI_ROLE_TEXT ? ContextKind::field : ContextKind::text, label, frame);
                    continue;
                }
                if (role == ATSPI_ROLE_HEADING || role == ATSPI_ROLE_LINK || role == ATSPI_ROLE_TABLE_ROW) {
                    const auto label = semanticLabel(tree, node);
                    if (!label.empty()) {
                        context.append(role == ATSPI_ROLE_HEADING ? ContextKind::heading : role == ATSPI_ROLE_LINK ? ContextKind::link : ContextKind::row, label, frame);
                        continue;
                    }
                }
                if (webControl) {
                    const auto label = tree.label(node);
                    if (!label.empty()) { context.append(ContextKind::text, label, frame); continue; }
                }
            }
            auto children = tree.children(node, 5000 - context.nodes - stack.size());
            for (auto it = children.rbegin(); it != children.rend(); ++it) stack.emplace_back(*it, web);
        } catch (const ScreenBudgetExceeded&) { context.stopped = "lookup budget"; break; }
    }
    const bool selectionRedacted = privacy::ScreenPrivacy::apply(context, around);
    const auto rendered = context.render();
    const auto summary = "nodes=" + std::to_string(context.nodes) + " blocks=" + std::to_string(context.count()) +
        " bytes=" + std::to_string(rendered.size()) + (context.stopped.empty() ? "" : " stopped=" + context.stopped);
    return JSON{{"appName", app.name}, {"bundleID", app.id}, {"windowTitle", title},
        {"host", host ? JSON(*host) : JSON(nullptr)}, {"terminalProgram", nullptr}, {"focusedRole", std::to_string(focusRole)},
        {"textBeforeCaret", around[0]}, {"selectedText", around[1]}, {"textAfterCaret", around[2]},
        {"selectionRedacted", selectionRedacted}, {"renderedText", rendered}, {"summary", summary}, {"logDescription", rendered}};
}
template<class Tree>
nlohmann::json gatherScreen(Tree& tree, typename Tree::Node window, typename Tree::Node focus,
    const std::vector<typename Tree::Node>& path, const AppIdentity& app, const ScreenExclusions& exclusions) {
    try { return gatherScreenUnchecked(tree, window, focus, path, app, exclusions); }
    catch (const PrivacyHidden&) { return hiddenScreen(); }
    catch (const ScreenBudgetExceeded&) { return nullptr; }
}
}
