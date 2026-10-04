// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <optional>
#include "../rust/include/voice_core.h"

namespace voice {
enum class Action {
    start = VoiceGestureStart, startHandsFree = VoiceGestureStartHandsFree,
    startAgent = VoiceGestureStartAgent, startAgentHandsFree = VoiceGestureStartAgentHandsFree,
    listenHandsFree = VoiceGestureListenHandsFree, finish = VoiceGestureFinish,
    cancel = VoiceGestureCancel, toggleMode = VoiceGestureToggleMode,
    closeChat = VoiceGestureCloseChat, showHistory = VoiceGestureShowHistory
};
inline const char* actionName(Action action) {
    switch (action) {
    case Action::start: return "start";
    case Action::startHandsFree: return "startHandsFree";
    case Action::startAgent: return "startAgent";
    case Action::startAgentHandsFree: return "startAgentHandsFree";
    case Action::listenHandsFree: return "listenHandsFree";
    case Action::finish: return "finish";
    case Action::cancel: return "cancel";
    case Action::toggleMode: return "toggleMode";
    case Action::closeChat: return "closeChat";
    case Action::showHistory: return "showHistory";
    }
    return "cancel";
}

// Native key normalization and the public value-state API; all transitions are Rust.
class Gesture : public VoiceGestureState {
public:
    Gesture() : VoiceGestureState{} {}
    bool active() const { return holding || handsFree; }
    bool owns(unsigned key) const { return voice_core_gesture_owns(this, normalized(key)) != 0; }
    std::optional<Action> modifier(bool down, double time, bool agent = false) {
        return action(voice_core_gesture_modifier(this, down, time, agent));
    }
    std::optional<Action> keyPressed(unsigned key, bool repeat) {
        return action(voice_core_gesture_key(this, normalized(key), repeat));
    }
    void dictationEnded() { voice_core_gesture_ended(this); }
private:
    static uint32_t normalized(unsigned key) { return key == 32 ? 1u : key == 27 ? 2u : 0u; }
    static std::optional<Action> action(uint32_t value) {
        return value == 0 ? std::nullopt : std::optional<Action>(static_cast<Action>(value));
    }
};
}
