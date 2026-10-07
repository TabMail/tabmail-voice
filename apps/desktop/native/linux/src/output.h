// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
#pragma once
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <mutex>
#include <thread>
#include <variant>
#include <nlohmann/json.hpp>
#include "../../shared/hotkey/gesture.h"

namespace voice {
// Keyboard callbacks enqueue actions; JSON encoding and pipe writes belong to this thread.
// A stalled parent cannot retain an unbounded queue or leave us owning desktop shortcuts.
class Output {
    // Ends the process with its code once everything enqueued before it has been written.
    struct End { int code; };
    using Item = std::variant<Action, nlohmann::json, End>;
    std::mutex mutex;
    std::condition_variable ready;
    std::deque<Item> queue;
    bool stopped = false;
    std::thread writer;
    void enqueue(Item value) {
        std::lock_guard lock(mutex);
        if (queue.size() >= 256) std::_Exit(1);
        queue.push_back(std::move(value));
        ready.notify_one();
    }
public:
    Output() {
        writer = std::thread([this] {
            for (;;) {
                Item item;
                {
                    std::unique_lock lock(mutex);
                    ready.wait(lock, [this] { return stopped || !queue.empty(); });
                    if (queue.empty()) return;
                    item = std::move(queue.front());
                    queue.pop_front();
                }
                if (const auto end = std::get_if<End>(&item)) std::_Exit(end->code);
                try {
                    auto value = std::holds_alternative<Action>(item)
                        ? nlohmann::json{{"event", "action"}, {"action", actionName(std::get<Action>(item))}}
                        : std::move(std::get<nlohmann::json>(item));
                    std::cout << value.dump() << '\n' << std::flush;
                    if (!std::cout) std::_Exit(1);
                } catch (...) { std::_Exit(1); }
            }
        });
    }
    ~Output() {
        { std::lock_guard lock(mutex); stopped = true; ready.notify_one(); }
        writer.join();
    }
    Output(const Output&) = delete;
    Output& operator=(const Output&) = delete;
    void action(Action value) { enqueue(value); }
    void send(nlohmann::json value) { enqueue(std::move(value)); }
    void end(int code) { enqueue(End{code}); }
};
}
