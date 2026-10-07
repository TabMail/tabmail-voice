// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <cstdint>
#include <optional>
#include "../rust/include/voice_core.h"

namespace voice {
// Which of the app's numbered sessions voice-microphone runs, and when its process ends: the shared
// core's decision (`../rust/src/microphone.rs`, its cases in `session-cases.json`).
class MicrophoneSessions : VoiceMicrophoneSessions {
public:
    enum class Start { runs = VoiceMicrophoneRuns, skipped = VoiceMicrophoneSkipped, endsProcess = VoiceMicrophoneEndsProcess };
    MicrophoneSessions() : VoiceMicrophoneSessions{} {}
    Start start(int64_t session) {
        const auto decision = voice_core_microphone_start(this, session);
        return decision == VoiceMicrophoneRuns ? Start::runs : decision == VoiceMicrophoneEndsProcess ? Start::endsProcess : Start::skipped;
    }
    // Whether the running session stopped (`session` or an older one), which ends the process.
    bool stop(int64_t session) { return voice_core_microphone_stop(this, session) != 0; }
    // A failed start ends the process too.
    void failed(int64_t session) { voice_core_microphone_failed(this, session); }
    bool mayPrepare() const { return voice_core_microphone_may_prepare(this) != 0; }
    std::optional<int64_t> running() const {
        const auto session = voice_core_microphone_running(this);
        return session ? std::optional<int64_t>(session) : std::nullopt;
    }
};
}
