// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// voice-field-reader: reads the focused field that correction learning watches after a paste, and
// does nothing else. A read may take as long as the app in front takes to answer over AT-SPI; in a
// process of its own it holds up no caret lookup, paste or recording, and the app ends the process
// when it no longer wants the read (`FieldReader` in the app, ADR-DESK-053). It keeps its own record
// of what has focus; EOF ends it.
//
// - `focusedFieldValue {pid, maxLength, excludedAppIDs, excludedHosts}` → `{value}`: the focused field
//   of the window in front, read only while that window is the process `pid`'s, the app the dictation
//   was pasted into as voice-linux named it at key-down (window tokens are each process's own, so the
//   two programs share the process), or null.
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
        if (method == "focusedFieldValue") reply(voice::focusedRead(method, params, foreground), true);
        else throw std::runtime_error("unknown method");
    };
    // Requests are served only after Foreground's start-up idle has looked for what has focus, as in
    // voice-screen-reader: the app restarts this program when a new watch's read supersedes one still
    // going and asks it at once for the field; served from the start, that would find nothing.
    std::optional<voice::Channel> channel;
    auto open = [&] { channel.emplace(output, serve); };
    g_idle_add([](gpointer data) -> gboolean { (*static_cast<decltype(open)*>(data))(); return G_SOURCE_REMOVE; }, &open);
    atspi_event_main();
    return 0;
}
