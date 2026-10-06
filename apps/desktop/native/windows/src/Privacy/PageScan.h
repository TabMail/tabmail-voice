// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "ScreenExclusions.h"
#include <vector>

namespace voice::privacy {
// Text ranges can aggregate descendants, so checking only the range owner's
// password flag is insufficient. Incomplete inspection cannot authorize a read.
template<class Tree>
bool safeTextSubtree(Tree& tree, typename Tree::Node root) {
    std::vector<typename Tree::Node> stack{root};
    size_t visited = 0;
    while (!stack.empty()) {
        if (visited >= 5000 || !tree.withinBudget()) return false;
        auto node = std::move(stack.back());
        stack.pop_back();
        ++visited;
        if (tree.isPassword(node)) return false;
        auto children = tree.children(node, 5000 - visited - stack.size());
        for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back(std::move(*it));
        // At the exact limit we cannot establish there were no omitted children.
        if (visited + stack.size() >= 5000) return false;
    }
    return tree.withinBudget();
}

// What a look inside an element for a page of an excluded website found. `notSeenWhole`:
// a budget ran out first, so a page may be in what was not looked at.
enum class PageLook { none, excluded, notSeenWhole };

// A metadata-only walk. The live adapter exposes no text-reading operation;
// fake trees prove protected descendants and refused pages are never entered.
// Each caller decides what `notSeenWhole` means for it (ADR-DESK-054): a part
// read whole is withheld, while the checks before the walk and before a field
// read for corrections go on (ADR-DESK-047).
template<class Tree>
PageLook lookForExcludedPage(Tree& tree, typename Tree::Node root, const ScreenExclusions& exclusions, bool intoPages) {
    std::vector<typename Tree::Node> stack{root};
    size_t visited = 0;
    bool incomplete = false;
    while (!stack.empty()) {
        if (visited >= 5000 || !tree.withinBudget()) return PageLook::notSeenWhole;
        auto node = std::move(stack.back());
        stack.pop_back();
        ++visited;
        if (tree.isPassword(node)) continue;
        const auto page = tree.page(node);
        if (page) {
            if (exclusions.excludes(*page)) return PageLook::excluded;
            if (!intoPages) continue;
        }
        auto children = tree.children(node, 5000 - visited - stack.size());
        for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back(std::move(*it));
        // At the exact limit we cannot establish there were no omitted children; the ones listed are
        // still looked through, so an excluded page among them is found.
        if (visited + stack.size() >= 5000) incomplete = true;
    }
    return !incomplete && tree.withinBudget() ? PageLook::none : PageLook::notSeenWhole;
}
}
