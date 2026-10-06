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
    unsigned long long timeBudgetMilliseconds;
    size_t focusDepth;
};
// The walk's budgets. A constant request the core always answers.
inline const Limits& limits() {
    static const Limits value = [] {
        const auto reply = ask({{"limits", true}});
        return Limits{reply.at("nodeBudget").get<size_t>(), reply.at("timeBudgetMilliseconds").get<unsigned long long>(),
                      reply.at("focusDepth").get<size_t>()};
    }();
    return value;
}

using Frame = std::array<double, 4>;  // x, y, width, height
// What the OS says about one element. `role` is one of the shared roles (walk.rs); `focus` is
// "self", "path" or empty; `thin` is the thickest a box can be and still hide its text.
struct Facts {
    std::string role = "other";
    std::string focus;
    bool part = false, inPage = false, password = false, pageExcluded = false;
    bool focusedField = false, selection = false, hidden = false;
    std::optional<Frame> frame, window;
    double thin = 1;
};
struct Step {
    std::string action, kind;
    bool caretFirst = false, childrenInPage = false, host = false, shown = false;
};

inline Step node(const Facts& facts) {
    JSON request{{"role", facts.role}, {"part", facts.part}, {"inPage", facts.inPage}, {"password", facts.password},
                 {"pageExcluded", facts.pageExcluded}, {"focusedField", facts.focusedField}, {"selection", facts.selection},
                 {"hidden", facts.hidden}, {"thin", facts.thin}};
    if (!facts.focus.empty()) request["focus"] = facts.focus;
    if (facts.frame) request["frame"] = *facts.frame;
    if (facts.window) request["window"] = *facts.window;
    const auto reply = ask({{"node", request}});
    return Step{reply.at("action").get<std::string>(), reply.value("kind", std::string()), reply.value("caretFirst", false),
                reply.value("childrenInPage", false), reply.value("host", false), reply.value("shown", false)};
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

// Why the walk stops before its next element, or none to go on.
inline std::optional<std::string> stop(size_t nodes, unsigned long long elapsedMilliseconds, bool textFull) {
    const auto reply = ask({{"stop", {{"nodes", nodes}, {"elapsed", elapsedMilliseconds}, {"textFull", textFull}}}});
    return reply.at("stopped").is_null() ? std::nullopt : std::optional<std::string>(reply.at("stopped").get<std::string>());
}

// A metadata-only look inside `root` for a page of an excluded website, each step the core's
// census, deep first with the children last fetched first. The element itself is judged (a page,
// a password element) but not counted; a password element's children are never asked for. The tree gives `withinBudget()`, `isPassword(node)`,
// `page(node)` and `children(node, limit)`, which may stop early when out of time, so a look that
// ends out of time has not seen the element whole. Each caller decides what `notSeenWhole` means
// for it (ADR-DESK-054): a part read whole is withheld, while the checks before the walk and
// before a field read for corrections go on (ADR-DESK-047).
template<class Tree, class Exclusions>
PageLook lookForExcludedPage(Tree& tree, typename Tree::Node root, const Exclusions& exclusions, bool intoPages) {
    const auto step = [&](JSON census, const typename Tree::Node& node) -> JSON {
        census["late"] = !tree.withinBudget();
        census["intoPages"] = intoPages;
        census["password"] = tree.isPassword(node);
        // A password element is never asked what it is (no page check under it).
        if (!census["password"].get<bool>())
            if (const auto page = tree.page(node)) census["page"] = exclusions.excludes(*page) ? "excluded" : "allowed";
        return ask({{"census", census}});
    };
    std::vector<typename Tree::Node> stack;
    const auto descend = [&](const JSON& reply, const typename Tree::Node& node) {
        auto children = tree.children(node, reply.at("children").get<size_t>());
        for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back(std::move(*it));
    };
    const JSON first = step({{"start", true}}, root);
    const auto name = first.at("step").get<std::string>();
    if (name == "notSeenWhole") return PageLook::notSeenWhole;
    if (name == "excluded") return PageLook::excluded;
    if (name == "descend") descend(first, root);
    size_t visited = 0;
    while (!stack.empty()) {
        auto node = std::move(stack.back());
        stack.pop_back();
        const JSON reply = step({{"visited", visited}}, node);
        ++visited;
        const auto taken = reply.at("step").get<std::string>();
        if (taken == "notSeenWhole") return PageLook::notSeenWhole;
        if (taken == "excluded") return PageLook::excluded;
        if (taken == "descend") descend(reply, node);
    }
    return tree.withinBudget() ? PageLook::none : PageLook::notSeenWhole;
}
}
