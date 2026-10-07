// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <array>
#include <optional>
#include <string>
#include <vector>
#include "../rust/VoiceCore.h"

// The screen walk's rules, decided by the shared core (`voice_core_walk_json`, ADR-DESK-054): a
// helper walks the accessibility tree and says what the OS tells it about each element; the core
// says what to do with it. Windows and Linux share this wrapper; the Mac's is `SharedWalk`.
namespace voice::walk {
using JSON = nlohmann::json;

inline JSON ask(const JSON& request) { return core::request(request, voice_core_walk_json); }

struct Limits {
    size_t nodeBudget;
    size_t focusDepth;
};
// The walk's budgets. A constant request the core always answers.
inline const Limits& limits() {
    static const Limits value = [] {
        const auto reply = ask({{"limits", true}});
        return Limits{reply.at("nodeBudget").get<size_t>(), reply.at("focusDepth").get<size_t>()};
    }();
    return value;
}

using Frame = std::array<double, 4>;  // x, y, width, height
// What the OS says about one element. `role` is one of the shared roles (walk.rs); `focus` is
// "self", "path" or empty; `scale` is how many of the frames' units make a point.
struct Facts {
    std::string role = "other";
    std::string focus;
    bool part = false, inPage = false, password = false, pageExcluded = false;
    bool focusedField = false, selection = false, hidden = false;
    std::optional<Frame> frame, window;
    double scale = 1;
};
// `look` (with `skip`): an element that shows nothing, looked inside first as for that read; an
// excluded page under it refuses the window.
struct Step {
    std::string action, kind;
    bool caretFirst = false, childrenInPage = false, host = false, shown = false;
    std::string look;
};

inline Step node(const Facts& facts) {
    JSON request{{"role", facts.role}, {"part", facts.part}, {"inPage", facts.inPage}, {"password", facts.password},
                 {"pageExcluded", facts.pageExcluded}, {"focusedField", facts.focusedField}, {"selection", facts.selection},
                 {"hidden", facts.hidden}, {"scale", facts.scale}};
    if (!facts.focus.empty()) request["focus"] = facts.focus;
    if (facts.frame) request["frame"] = *facts.frame;
    if (facts.window) request["window"] = *facts.window;
    const auto reply = ask({{"node", request}});
    return Step{reply.at("action").get<std::string>(), reply.value("kind", std::string()), reply.value("caretFirst", false),
                reply.value("childrenInPage", false), reply.value("host", false), reply.value("shown", false),
                reply.value("look", std::string())};
}

// Whether an element read outside the walk (a terminal's surface) shows anything, by the walk's
// rule: not `hidden`, not wholly outside `window`, no thinner than a point (`scale` units).
inline bool shown(const std::optional<Frame>& frame, const Frame& window, double scale, bool hidden) {
    JSON facts{{"window", window}, {"scale", scale}, {"hidden", hidden}};
    if (frame) facts["frame"] = *frame;
    return ask({{"shown", facts}}).at("shown").get<bool>();
}

// What a look inside an element for a page of an excluded website found. `notSeenWhole`: a
// budget ran out first, so a page may be in what was not looked at.
enum class PageLook { none, excluded, notSeenWhole };

// What a look inside a part read whole (`read`: "text", "field", "semantic" or "caption") decides:
// "read", "refuse" (the window) or "marker".
inline std::string look(const std::string& read, PageLook found) {
    const char* names[] = {"none", "excluded", "notSeenWhole"};
    return ask({{"look", {{"read", read}, {"found", names[static_cast<int>(found)]}}}}).at("outcome").get<std::string>();
}

// Why the walk stops before its next element, or none to go on. A walk has no time limit: it runs
// while the user speaks, and the app takes a read only if it is done in time.
inline std::optional<std::string> stop(size_t nodes, bool textFull) {
    const auto reply = ask({{"stop", {{"nodes", nodes}, {"textFull", textFull}}}});
    return reply.at("stopped").is_null() ? std::nullopt : std::optional<std::string>(reply.at("stopped").get<std::string>());
}

namespace detail {
// A metadata-only look inside `root`, each step the core's census, deep first, each element's
// children in order. The element itself is judged (a page, a password element) but not counted;
// a password element's children are never asked for. `page(node)` gives "excluded", "allowed" or
// nothing. The census's last step: "none", "excluded", "protected" or "notSeenWhole".
template<class Tree, class Page>
std::string censusLook(Tree& tree, typename Tree::Node root, bool intoPages, bool protect, const Page& page) {
    const auto step = [&](JSON census, const typename Tree::Node& node) -> JSON {
        census["late"] = !tree.withinBudget();
        census["intoPages"] = intoPages;
        census["protect"] = protect;
        census["password"] = tree.isPassword(node);
        // A password element is never asked what it is (no page check under it).
        if (!census["password"].get<bool>())
            if (const auto found = page(node)) census["page"] = *found;
        return ask({{"census", census}});
    };
    std::vector<typename Tree::Node> stack;
    // The look's end, or none to go on.
    const auto go = [&](const JSON& reply, const typename Tree::Node& node) -> std::optional<std::string> {
        const auto taken = reply.at("step").get<std::string>();
        if (taken != "descend" && taken != "skip") return taken;
        if (taken == "skip") return std::nullopt;
        auto children = tree.children(node, reply.at("children").get<size_t>());
        for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back(std::move(*it));
        return std::nullopt;
    };
    if (auto end = go(step({{"start", true}}, root), root)) return *end;
    size_t visited = 0;
    while (!stack.empty()) {
        auto node = std::move(stack.back());
        stack.pop_back();
        const JSON reply = step({{"visited", visited}}, node);
        ++visited;
        if (auto end = go(reply, node)) return *end;
    }
    return tree.withinBudget() ? "none" : "notSeenWhole";
}
}

// A metadata-only look inside `root` for a page of an excluded website (`detail::censusLook`).
// The tree gives `withinBudget()`, `isPassword(node)`, `page(node)` and `children(node, limit)`,
// which may stop early when out of time, so a look that ends out of time has not seen the element
// whole. Each caller decides what `notSeenWhole` means for it (ADR-DESK-054): a part read whole is
// withheld, while the checks before the walk and before a field read for corrections go on
// (ADR-DESK-047).
template<class Tree, class Exclusions>
PageLook lookForExcludedPage(Tree& tree, typename Tree::Node root, const Exclusions& exclusions, bool intoPages) {
    const auto found = detail::censusLook(tree, root, intoPages, false, [&](const typename Tree::Node& node) -> std::optional<std::string> {
        const auto page = tree.page(node);
        if (!page) return std::nullopt;
        return exclusions.excludes(*page) ? "excluded" : "allowed";
    });
    return found == "excluded" ? PageLook::excluded : found == "none" ? PageLook::none : PageLook::notSeenWhole;
}

// Whether a range or surface whose text takes in everything under `root` may be read: the core's
// census with `protect`, so a password element anywhere in it, `root` included, or a look not
// seen whole refuses it. Pages are not asked about (the window's own look does that).
template<class Tree>
bool holdsNoPassword(Tree& tree, typename Tree::Node root) {
    return detail::censusLook(tree, root, true, true, [](const typename Tree::Node&) { return std::optional<std::string>(); }) == "none";
}
}
