// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once

namespace voice {
// Windows AltGr arrives as Control + right Alt, including a synthesized Control
// event on some layouts. Track those events even when injected input is otherwise
// passed through. Do not use GetAsyncKeyState inside the low-level callback: its
// state has not yet been updated for that event.
class ModifierChoice {
public:
    static constexpr unsigned rightControl = 0xa3;
    static constexpr unsigned rightAlt = 0xa5;
    unsigned selected = rightControl;

    bool bypass(unsigned key, bool down, bool injected) {
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
    void seedControls(bool left, bool right) { leftControlDown = left; rightControlDown = right; }
private:
    bool leftControlDown = false;
    bool rightControlDown = false;
    bool altDown = false;
    bool altGr = false;
};
}
