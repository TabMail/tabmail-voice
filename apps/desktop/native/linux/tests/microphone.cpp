// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#include "../src/microphone.h"
#include <chrono>
#include <future>
#include <iostream>
#include <thread>
using namespace std::chrono_literals;
int main() {
    voice::Output output;
    voice::Microphone microphone(output);
    auto wait = [](auto operation, bool expected = true) {
        std::promise<bool> done;
        auto ready = done.get_future();
        operation([&done](bool success) { done.set_value(success); });
        if (ready.wait_for(5s) != std::future_status::ready || ready.get() != expected) std::_Exit(1);
    };
    wait([&](auto done) { microphone.prepare(done); });
    wait([&](auto done) { microphone.start(1, 16000, done); });
    // Simulate an accessibility provider blocking the main helper thread. Capture
    // must continue on its own event loop and emit usable shared-protocol chunks.
    std::this_thread::sleep_for(1500ms);
    wait([&](auto done) { microphone.start(1, 16000, done); }, false);
    wait([&](auto done) { microphone.stop(999, done); });
    std::this_thread::sleep_for(1000ms);
    wait([&](auto done) { microphone.stop(1, done); });
    wait([&](auto done) { microphone.start(1, 16000, done); }, false);
    wait([&](auto done) { microphone.start(2, 16000, done); });
    std::this_thread::sleep_for(200ms);
    wait([&](auto done) { microphone.stop(1, done); });
    output.send({{"event", "after-old-stop"}});
    std::this_thread::sleep_for(3500ms);
    output.send({{"event", "end-observation"}});
    wait([&](auto done) { microphone.stop(2, done); });
    // Normal destruction stops the capture worker and drains the output queue.
    return 0;
}
