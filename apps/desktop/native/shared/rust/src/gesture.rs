// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Value state shared with the native event monitors. No allocation, retained
/// pointers, timers or OS key codes; time is monotonic seconds supplied by callers.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Gesture {
    tap_max_duration: f64,
    double_tap_window: f64,
    pressed_at: f64,
    last_tap_released_at: f64,
    hands_free_released_at: f64,
    holding: u32,
    hands_free: u32,
    chat_open: u32,
    hold_over: u32,
    double_tap: u32,
    has_last_tap: u32,
    has_hands_free_tap: u32,
}

const NONE: u32 = 0;
const START: u32 = 1;
const START_HANDS_FREE: u32 = 2;
const START_AGENT: u32 = 3;
const START_AGENT_HANDS_FREE: u32 = 4;
const LISTEN_HANDS_FREE: u32 = 5;
const FINISH: u32 = 6;
const CANCEL: u32 = 7;
const TOGGLE_MODE: u32 = 8;
const CLOSE_CHAT: u32 = 9;
const SHOW_HISTORY: u32 = 10;
const SPACE: u32 = 1;
const ESCAPE: u32 = 2;

impl Gesture {
    fn modifier(&mut self, down: bool, time: f64, agent: bool) -> u32 {
        if down {
            if self.holding != 0 {
                return NONE;
            }
            self.holding = 1;
            self.hold_over = 0;
            self.pressed_at = time;
            if self.hands_free != 0 {
                self.hands_free = 0;
                self.hold_over = 1;
                if self.has_hands_free_tap != 0
                    && time - self.hands_free_released_at <= self.double_tap_window
                {
                    self.has_hands_free_tap = 0;
                    return SHOW_HISTORY;
                }
                return FINISH;
            }
            if self.has_last_tap != 0 && time - self.last_tap_released_at <= self.double_tap_window
            {
                self.has_last_tap = 0;
                self.double_tap = 1;
                return if agent {
                    START_AGENT_HANDS_FREE
                } else {
                    START_HANDS_FREE
                };
            }
            self.double_tap = 0;
            return if agent { START_AGENT } else { START };
        }
        if self.holding == 0 {
            return NONE;
        }
        self.holding = 0;
        let was_double = self.double_tap != 0;
        self.double_tap = 0;
        if self.hold_over != 0 {
            self.hold_over = 0;
            return NONE;
        }
        let tap = time - self.pressed_at < self.tap_max_duration;
        if was_double {
            if !tap {
                return FINISH;
            }
            self.hands_free = 1;
            self.hands_free_released_at = time;
            self.has_hands_free_tap = 1;
            return LISTEN_HANDS_FREE;
        }
        self.has_last_tap = u32::from(tap);
        self.last_tap_released_at = time;
        FINISH
    }

    fn owns(&self, key: u32) -> bool {
        if self.chat_open != 0 && key == ESCAPE {
            return true;
        }
        if self.hands_free != 0 {
            return key == SPACE || key == ESCAPE;
        }
        self.holding != 0 && self.hold_over == 0 && key == SPACE
    }

    fn key(&mut self, key: u32, repeat: bool) -> u32 {
        self.has_last_tap = 0;
        self.has_hands_free_tap = 0;
        if self.chat_open != 0 && key == ESCAPE {
            self.hands_free = 0;
            if self.holding != 0 {
                self.hold_over = 1;
            }
            return if repeat { NONE } else { CLOSE_CHAT };
        }
        if self.hands_free != 0 {
            if key == SPACE {
                return if repeat { NONE } else { TOGGLE_MODE };
            }
            if key == ESCAPE {
                self.hands_free = 0;
                return CANCEL;
            }
            return NONE;
        }
        if self.holding == 0 || self.hold_over != 0 {
            return NONE;
        }
        if key == SPACE {
            return if repeat { NONE } else { TOGGLE_MODE };
        }
        self.hold_over = 1;
        CANCEL
    }
}

// These scalar operations have no panicking/allocating path. Native callers own
// initialized state exclusively during mutation; an invalid event leaves it intact.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_gesture_modifier(
    state: *mut Gesture,
    down: u32,
    time: f64,
    agent: u32,
) -> u32 {
    if state.is_null() || down > 1 || agent > 1 || !time.is_finite() {
        return NONE;
    }
    unsafe { (&mut *state).modifier(down != 0, time, agent != 0) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_gesture_key(state: *mut Gesture, key: u32, repeat: u32) -> u32 {
    if state.is_null() || key > ESCAPE || repeat > 1 {
        return NONE;
    }
    unsafe { (&mut *state).key(key, repeat != 0) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_gesture_owns(state: *const Gesture, key: u32) -> u32 {
    if state.is_null() || key > ESCAPE {
        return 0;
    }
    unsafe { u32::from((&*state).owns(key)) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_gesture_ended(state: *mut Gesture) {
    if !state.is_null() {
        unsafe {
            (*state).hands_free = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_characterization_traces() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../hotkey/gesture-cases.json")).unwrap();
        let names = [
            "",
            "start",
            "startHandsFree",
            "startAgent",
            "startAgentHandsFree",
            "listenHandsFree",
            "finish",
            "cancel",
            "toggleMode",
            "closeChat",
            "showHistory",
        ];
        assert_eq!(cases.as_array().unwrap().len(), 7);
        for trace in cases.as_array().unwrap() {
            let mut state = Gesture {
                tap_max_duration: trace["tapMaxDuration"].as_f64().unwrap(),
                double_tap_window: trace["doubleTapWindow"].as_f64().unwrap(),
                ..Default::default()
            };
            for step in trace["steps"].as_array().unwrap() {
                let action = match step["event"].as_str().unwrap() {
                    "down" | "up" => state.modifier(
                        step["event"] == "down",
                        step["time"].as_f64().unwrap(),
                        step["agent"].as_bool().unwrap_or(false),
                    ),
                    "key" => state.key(
                        match step["key"].as_u64().unwrap() {
                            32 => SPACE,
                            27 => ESCAPE,
                            _ => 0,
                        },
                        step["repeat"].as_bool().unwrap_or(false),
                    ),
                    "chat" => {
                        state.chat_open = u32::from(step["chat"].as_bool().unwrap());
                        NONE
                    }
                    "ended" => {
                        unsafe {
                            voice_core_gesture_ended(&mut state);
                        }
                        NONE
                    }
                    _ => panic!("unknown fixture event"),
                };
                assert_eq!(
                    if action == NONE {
                        None
                    } else {
                        Some(names[action as usize])
                    },
                    step["action"].as_str(),
                    "{}",
                    trace["name"]
                );
                assert_eq!(state.holding != 0, step["holding"].as_bool().unwrap());
                assert_eq!(state.hands_free != 0, step["handsFree"].as_bool().unwrap());
                assert_eq!(state.owns(SPACE), step["space"].as_bool().unwrap());
                assert_eq!(state.owns(ESCAPE), step["escape"].as_bool().unwrap());
            }
        }
    }
}
