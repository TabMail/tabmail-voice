// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// voice-screen-reader: reads the screen of the window in front, and does nothing else. A read may
// take as long as the app in front takes to answer over AT-SPI; in a process of its own it holds up
// no paste or recording, and the app ends the process when it no longer wants the read
// (`ScreenReader` in the app, ADR-DESK-053). It keeps its own record of what has focus; EOF ends it.
#include <atspi/atspi.h>
#include <iostream>
#include <optional>
#include <stdexcept>
#include "channel.h"
#include "focused_read.h"
#include "gnome_caret.h"

int main() {
    if (!voice::enableAccessibilityBridge()) std::cerr << "debug accessibility: bridge activation unavailable\n";
    if (atspi_init() != 0) return 1;
    atspi_set_timeout(250, 1000);
    voice::Output output;
    // While the Shell holds the keyboard for the dictation key, the window in front keeps no focus
    // yet stays the target: the reader asks the extension, as the helper does (ADR-DESK-052).
    voice::GnomeCaret gnomeCaret;
    voice::Foreground foreground([&] { return gnomeCaret.holding(); }, [&] { return gnomeCaret.focus(); });
    const auto serve = [&](const std::string& method, const nlohmann::json& params, voice::Channel::Reply reply, int64_t) {
        if (method != "readScreen") throw std::runtime_error("unknown method");
        reply(voice::focusedRead(method, params, foreground), true);
    };
    // Requests are served only after Foreground's start-up idle has looked for what has focus (if
    // it found nothing, a read answers null; the caller bounds its own wait). The app
    // restarts this program for every read that supersedes another and writes that read at once;
    // stdin outranks an idle, so served from the start the read would find no target and come back
    // empty. Idles of one priority run in the order they were added.
    std::optional<voice::Channel> channel;
    auto open = [&] { channel.emplace(output, serve); };
    g_idle_add([](gpointer data) -> gboolean { (*static_cast<decltype(open)*>(data))(); return G_SOURCE_REMOVE; }, &open);
    atspi_event_main();
    return 0;
}
