// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <cstdint>
#include <optional>
#include "helper_config.h"

namespace voice {
// One foreground visit owns its attempts. A late completion cannot revive an old visit.
class ActivationRetry {
public:
    void enter(uintptr_t window, uint64_t now) {
        ++generation;
        target = window;
        attempts = 0;
        due = window ? std::optional<uint64_t>(now) : std::nullopt;
    }
    struct Attempt { uint64_t generation; uintptr_t target; };
    std::optional<Attempt> take(uint64_t now) {
        if (!due || now < *due) return std::nullopt;
        due.reset();
        ++attempts;
        return Attempt{generation, target};
    }
    void complete(Attempt attempt, bool success, uint64_t now) {
        if (attempt.generation != generation || attempt.target != target) return;
        if (!success && attempts < HelperConfig::accessibilityMaxAttempts)
            due = now + HelperConfig::accessibilityRetryIntervalMs;
    }
    std::optional<uint64_t> next() const { return due; }
private:
    uint64_t generation = 0;
    uintptr_t target = 0;
    unsigned attempts = 0;
    std::optional<uint64_t> due;
};
}
