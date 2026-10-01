// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include "screen_context.h"
#include <iostream>
#include <stdexcept>

using namespace voice;
static void expect(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}
int main() {
    // Matching the Mac renderer: reading order, inline overlap, column jump,
    // headings, a focused multiline field and an ordinary field.
    VisibleContext context;
    context.append(ContextKind::heading, "  Conversation  ", ContextFrame{0, 0, 200, 20});
    context.append(ContextKind::text, "Alex", ContextFrame{0, 30, 40, 20});
    context.append(ContextKind::link, "10:30", ContextFrame{50, 30, 40, 20});
    context.append(ContextKind::row, "Project | Status", ContextFrame{0, 60, 200, 20});
    context.append(ContextKind::caret, "Reply ‸selected‸\nsecond line", ContextFrame{0, 90, 200, 40});
    context.append(ContextKind::field, "Reference\nmore", ContextFrame{300, 0, 200, 40});
    expect(context.render() == "## Conversation\nAlex [10:30]\n| Project | Status\n» Reply ‸selected‸\n» second line\n\n> Reference\n> more", "Mac-format reading order and markers");
    expect(context.hasCaret && context.count() == 6, "caret recorded once");
    context.append(ContextKind::text, "Reference\nmore");
    context.append(ContextKind::text, " \n\t ");
    expect(context.count() == 6, "adjacent duplicates and blank labels omitted");

    VisibleContext sliver;
    sliver.append(ContextKind::text, "First", ContextFrame{0, 0, 50, 20});
    sliver.append(ContextKind::text, "Second", ContextFrame{60, 19, 50, 20});
    expect(sliver.render() == "First\nSecond", "one-pixel overlap is not one line");
    sliver.append(ContextKind::text, "Unknown frame");
    expect(sliver.render().ends_with("\nUnknown frame"), "missing geometry starts a line");

    VisibleContext bounded;
    bounded.append(ContextKind::text, std::string(VisibleContext::maxBytes - 2, 'x'));
    bounded.append(ContextKind::text, "🙂tail");
    expect(bounded.stopped == "text budget", "aggregate budget is enforced");
    expect(bounded.render() == std::string(VisibleContext::maxBytes - 2, 'x'), "no partial UTF-8 character crosses the wire");
    bounded.append(ContextKind::text, "done");
    expect(bounded.render().ends_with("\ndo"), "remaining bytes are bounded");
    std::cout << "Windows screen context rendering checks passed\n";
}
