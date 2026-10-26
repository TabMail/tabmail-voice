// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// voice-screen-reader: reads the screen of the window in front, and does nothing else. A read may
// take as long as the app in front takes to answer over AT-SPI; in a process of its own it holds up
// no paste or recording, and the app ends the process when it no longer wants the read
// (`ScreenReader` in the app, ADR-DESK-053). It keeps its own record of what has focus; EOF ends it.
// The read runs on the main loop, as AT-SPI must, so requests are read on a thread of their own:
// `readScreenStop {read}` is answered there and asks the read it names, and any numbered before
// it, to end at its next element with what it has read so far; every other line goes on to the loop.
#include <atspi/atspi.h>
#include <unistd.h>
#include <array>
#include <cerrno>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include "channel.h"
#include "focused_read.h"
#include "gnome_caret.h"

namespace {
// Answers a `readScreenStop` line, or says the line is something else.
bool answeredStop(const std::string& line, voice::Output& output) {
    const auto input = nlohmann::json::parse(line, nullptr, false);
    if (!input.is_object() || input.value("method", nlohmann::json{}) != "readScreenStop" ||
        !input.contains("id") || !input["id"].is_number_integer()) return false;
    try {
        voice::walk::readStops().ask(voice::walk::readNumber("readScreenStop", input.value("params", nlohmann::json::object())));
        output.send({{"id", input["id"]}, {"result", nullptr}});
    } catch (...) {
        output.send({{"id", input["id"]}, {"error", {{"message", "native request failed"}}}});
    }
    return true;
}

// Moves the app's input to a thread of its own, which answers stops and writes every other line to
// a pipe that takes stdin's place, so the main loop's `Channel` reads those as before.
void readRequestsAside(voice::Output& output) {
    const int input = dup(STDIN_FILENO);
    int ends[2];
    if (input < 0 || pipe(ends) != 0 || dup2(ends[0], STDIN_FILENO) < 0) std::_Exit(1);
    close(ends[0]);
    std::thread([&output, input, forward = ends[1]] {
        const auto send = [forward](const std::string& line) {
            for (size_t sent = 0; sent < line.size();) {
                const auto count = ::write(forward, line.data() + sent, line.size() - sent);
                if (count < 0 && errno == EINTR) continue;
                if (count <= 0) std::_Exit(1);
                sent += static_cast<size_t>(count);
            }
        };
        std::string line;
        std::array<char, 4096> bytes{};
        for (;;) {
            const auto count = ::read(input, bytes.data(), bytes.size());
            // A closed parent ends the process, even mid-read.
            if (count == 0) std::_Exit(0);
            if (count < 0) {
                if (errno == EINTR) continue;
                std::_Exit(1);
            }
            for (ssize_t i = 0; i < count; ++i) {
                if (bytes[i] != '\n') {
                    if (line.size() >= 1024 * 1024) std::_Exit(1);
                    line += bytes[i];
                    continue;
                }
                if (!answeredStop(line, output)) send(line + '\n');
                line.clear();
            }
        }
    }).detach();
}
}

int main() {
    if (!voice::enableAccessibilityBridge()) std::cerr << "debug accessibility: bridge activation unavailable\n";
    if (atspi_init() != 0) return 1;
    atspi_set_timeout(250, 1000);
    voice::Output output;
    readRequestsAside(output);
    // While the Shell holds the keyboard for the dictation key, the window in front keeps no focus
    // yet stays the target: the reader asks the extension, as the helper does (ADR-DESK-052).
    voice::GnomeCaret gnomeCaret;
    voice::Foreground foreground([&] { return gnomeCaret.holding(); }, [&] { return gnomeCaret.focus(); });
    // The window each read is bound to, by `Foreground`'s token for it (0 with none in front).
    voice::walk::LastReadWindow<uint64_t> lastRead;
    const auto serve = [&](const std::string& method, const nlohmann::json& params, voice::Channel::Reply reply, int64_t) {
        if (method != "readScreen") throw std::runtime_error("unknown method");
        const auto read = voice::walk::screenRead(params);
        // A read of the whole window bound to an earlier read's window (`sameWindowAs`) reads that
        // window only if it is still the one in front; otherwise there is no screen to give.
        // `focusedRead` gives null too if another window comes to the front while it reads.
        const auto target = foreground.target();
        if ((read.sameWindowAs != 0 && !target) || !lastRead.admits(read, target ? target->token : 0)) {
            reply(nullptr, true);
            return;
        }
        voice::walk::readStops().reading = read.number;
        voice::walk::readingWholeWindow() = read.wholeWindow;
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
