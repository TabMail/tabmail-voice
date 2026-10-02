// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once
#include <optional>

namespace voice {
enum class Action { start, startHandsFree, listenHandsFree, finish, cancel, toggleMode, closeChat, showHistory };
inline const char* actionName(Action action) {
    switch (action) {
    case Action::start: return "start";
    case Action::startHandsFree: return "startHandsFree";
    case Action::listenHandsFree: return "listenHandsFree";
    case Action::finish: return "finish";
    case Action::cancel: return "cancel";
    case Action::toggleMode: return "toggleMode";
    case Action::closeChat: return "closeChat";
    case Action::showHistory: return "showHistory";
    }
    return "cancel";
}

// The existing macOS gesture contract, on a monotonic clock in seconds. The monitor owns
// key-up suppression separately, so reconfiguration cannot leak an owned key-up.
class Gesture {
public:
    double tapMaxDuration = 0;
    double doubleTapWindow = 0;
    bool chatOpen = false;
    bool holding = false;
    bool handsFree = false;

    bool active() const { return holding || handsFree; }
    bool owns(unsigned key) const {
        if (chatOpen && key == 27) return true;
        if (handsFree) return key == 32 || key == 27;
        return holding && !holdOver && key == 32;
    }
    std::optional<Action> modifier(bool down, double time) {
        if (down) {
            if (holding) return {};
            holding = true;
            holdOver = false;
            pressedAt = time;
            if (handsFree) {
                handsFree = false;
                holdOver = true;
                if (handsFreeReleasedAt && time - *handsFreeReleasedAt <= doubleTapWindow) {
                    handsFreeReleasedAt.reset();
                    return Action::showHistory;
                }
                return Action::finish;
            }
            if (lastTapReleasedAt && time - *lastTapReleasedAt <= doubleTapWindow) {
                lastTapReleasedAt.reset();
                doubleTap = true;
                return Action::startHandsFree;
            }
            doubleTap = false;
            return Action::start;
        }
        if (!holding) return {};
        holding = false;
        const bool wasDouble = doubleTap;
        doubleTap = false;
        if (holdOver) {
            holdOver = false;
            return {};
        }
        const bool tap = time - pressedAt < tapMaxDuration;
        if (wasDouble) {
            if (!tap) return Action::finish;
            handsFree = true;
            handsFreeReleasedAt = time;
            return Action::listenHandsFree;
        }
        lastTapReleasedAt = tap ? std::optional<double>(time) : std::nullopt;
        return Action::finish;
    }
    std::optional<Action> keyPressed(unsigned key, bool repeat) {
        lastTapReleasedAt.reset();
        handsFreeReleasedAt.reset();
        if (chatOpen && key == 27) {
            handsFree = false;
            if (holding) holdOver = true;
            return repeat ? std::nullopt : std::optional<Action>(Action::closeChat);
        }
        if (handsFree) {
            if (key == 32) return repeat ? std::nullopt : std::optional<Action>(Action::toggleMode);
            if (key == 27) {
                handsFree = false;
                return Action::cancel;
            }
            return {};
        }
        if (!holding || holdOver) return {};
        if (key == 32) return repeat ? std::nullopt : std::optional<Action>(Action::toggleMode);
        holdOver = true;
        return Action::cancel;
    }
    void dictationEnded() { handsFree = false; }
private:
    bool holdOver = false;
    bool doubleTap = false;
    double pressedAt = 0;
    std::optional<double> lastTapReleasedAt;
    std::optional<double> handsFreeReleasedAt;
};
}
