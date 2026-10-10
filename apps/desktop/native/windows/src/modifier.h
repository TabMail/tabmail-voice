// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once

namespace voice {
// Windows AltGr arrives as Control + right Alt, including a synthesized Control
// event on some layouts. Track those events even when injected input is otherwise
// passed through. Inside the low-level callback GetAsyncKeyState gives the state
// from before that event, so it cannot track these; the hook reads it only to
// learn whether the system already holds the key (to let a key-up through, and to
// mask a leaked Right Alt).
class ModifierChoice {
public:
    static constexpr unsigned rightControl = 0xa3;
    static constexpr unsigned rightAlt = 0xa5;
    unsigned selected = rightControl;

    bool bypass(unsigned key, bool down, bool injected) {
        // Shift selects initial agent intent and never cancels an existing hold.
        // Track physical changes even while an AltGr chord bypasses the gesture.
        if (!injected && (key == 0xa0 || key == 0xa1 || key == 0x10)) {
            if (key == 0xa0) leftShiftDown = down;
            else if (key == 0xa1) rightShiftDown = down;
            else shiftDown = down;
            return true;
        }
        if (key == 0xa2) leftControlDown = down;
        if (key == rightControl) rightControlDown = down;
        if (injected) return true;
        if (key != rightAlt) return altGr;
        if (down && !altDown) {
            altDown = true;
            altGr = selected == rightAlt && (leftControlDown || rightControlDown);
        }
        const bool pass = altGr;
        if (!down) { altDown = false; altGr = false; }
        return pass;
    }
    bool agentIntent() const { return leftShiftDown || rightShiftDown || shiftDown; }
    void seedShifts(bool left, bool right) { leftShiftDown = left; rightShiftDown = right; shiftDown = false; }
    void seedControls(bool left, bool right) { leftControlDown = left; rightControlDown = right; }
private:
    bool leftShiftDown = false, rightShiftDown = false, shiftDown = false;
    bool leftControlDown = false;
    bool rightControlDown = false;
    bool altDown = false;
    bool altGr = false;
};
}
