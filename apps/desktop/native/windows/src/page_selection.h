// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include "../../shared/context/CaretSource.h"
#include "../../shared/context/walk.h"

namespace voice {
// `document` encloses the actual TextPattern document range, not just the selected span.
// Recognition-only neighbors require the same metadata admission as any aggregate text read.
template<class Tree, class Exclusions, class Read>
CaretSource pageSelectionSource(Tree& tree, typename Tree::Node document, const Exclusions& exclusions, const Read& read) {
    if (walk::lookForExcludedPage(tree, document, exclusions, true) != walk::PageLook::none ||
        !walk::holdsNoPassword(tree, document)) return CaretSource{{}, true};
    return read();
}
}
