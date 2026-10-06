// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "../../../shared/context/walk.h"
#include <vector>

namespace voice::privacy {
// Text ranges can aggregate descendants, so checking only the range owner's
// password flag is insufficient. Incomplete inspection cannot authorize a read.
template<class Tree>
bool safeTextSubtree(Tree& tree, typename Tree::Node root) {
    const size_t budget = walk::limits().nodeBudget;
    std::vector<typename Tree::Node> stack{root};
    size_t visited = 0;
    while (!stack.empty()) {
        if (visited >= budget || !tree.withinBudget()) return false;
        auto node = std::move(stack.back());
        stack.pop_back();
        ++visited;
        if (tree.isPassword(node)) return false;
        auto children = tree.children(node, budget - visited - stack.size());
        for (auto it = children.rbegin(); it != children.rend(); ++it) stack.push_back(std::move(*it));
        // At the exact limit we cannot establish there were no omitted children.
        if (visited + stack.size() >= budget) return false;
    }
    return tree.withinBudget();
}
}
