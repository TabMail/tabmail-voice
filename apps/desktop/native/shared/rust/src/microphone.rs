// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Which of the app's numbered sessions `voice-microphone` runs, and when its process ends, on every
/// platform (ADR-DESK-032). The process runs one capture, so the first start that runs is the only
/// one, and the process ends once that session stops or its start fails. The app stops each session
/// before it starts the next, but a helper may handle requests in any order: a stop stops its own
/// session or an older one, never a newer; a start the app has already stopped, or older than the
/// one running, does not start; and a newer start that comes before the running session's stop ends
/// the process, so the app's retry starts it in a fresh one.
///
/// Value state shared with the native helpers: no allocation, callbacks or retained pointers.
/// Sessions are positive; any other number changes nothing.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct MicrophoneSessions {
    /// The session the microphone runs for, 0 for none.
    running: i64,
    last_stopped: i64,
    /// Whether this process's capture has started, run or failed.
    started: u32,
}

/// The capture starts for the session.
const RUNS: u32 = 1;
/// Already stopped or superseded: nothing happens.
const SKIPPED: u32 = 2;
/// The process's capture has started: any running session stops, and the process ends.
const ENDS_PROCESS: u32 = 3;

impl MicrophoneSessions {
    fn start(&mut self, session: i64) -> u32 {
        if session <= 0 || session <= self.last_stopped || session <= self.running {
            return SKIPPED;
        }
        if self.started != 0 {
            self.last_stopped = session;
            self.running = 0;
            return ENDS_PROCESS;
        }
        self.started = 1;
        self.running = session;
        RUNS
    }

    /// Whether the running session stops, `session` itself or an older one, which ends the process.
    fn stop(&mut self, session: i64) -> bool {
        if session <= 0 {
            return false;
        }
        self.last_stopped = self.last_stopped.max(session);
        if self.running == 0 || self.running > session {
            return false;
        }
        self.running = 0;
        true
    }

    /// `session`'s start failed: nothing runs, no older session starts, and the process ends.
    fn failed(&mut self, session: i64) {
        if session <= 0 {
            return;
        }
        self.last_stopped = self.last_stopped.max(session);
        if self.running == session {
            self.running = 0;
        }
    }

    /// Whether the capture may be prepared: it has not started.
    fn may_prepare(&self) -> bool {
        self.started == 0
    }
}

// Scalar operations with no panicking or allocating path. Native callers own initialized state
// exclusively during mutation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_microphone_start(
    state: *mut MicrophoneSessions,
    session: i64,
) -> u32 {
    if state.is_null() {
        return SKIPPED;
    }
    unsafe { (&mut *state).start(session) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_microphone_stop(
    state: *mut MicrophoneSessions,
    session: i64,
) -> u32 {
    if state.is_null() {
        return 0;
    }
    unsafe { u32::from((&mut *state).stop(session)) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_microphone_failed(
    state: *mut MicrophoneSessions,
    session: i64,
) {
    if !state.is_null() {
        unsafe { (&mut *state).failed(session) }
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_microphone_may_prepare(
    state: *const MicrophoneSessions,
) -> u32 {
    if state.is_null() {
        return 0;
    }
    unsafe { u32::from((&*state).may_prepare()) }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_microphone_running(state: *const MicrophoneSessions) -> i64 {
    if state.is_null() {
        return 0;
    }
    unsafe { (*state).running }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_session_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../microphone/session-cases.json")).unwrap();
        assert_eq!(cases.as_array().unwrap().len(), 10);
        for case in cases.as_array().unwrap() {
            let mut state = MicrophoneSessions::default();
            let name = case["name"].as_str().unwrap();
            for step in case["steps"].as_array().unwrap() {
                let session = step["session"].as_i64().unwrap();
                match step["event"].as_str().unwrap() {
                    "start" => {
                        let decision = unsafe { voice_core_microphone_start(&mut state, session) };
                        let expected = match step["decision"].as_str().unwrap() {
                            "runs" => RUNS,
                            "skipped" => SKIPPED,
                            "endsProcess" => ENDS_PROCESS,
                            _ => panic!("unknown decision"),
                        };
                        assert_eq!(decision, expected, "{name}");
                    }
                    "stop" => {
                        let stopped = unsafe { voice_core_microphone_stop(&mut state, session) };
                        assert_eq!(stopped != 0, step["stopped"].as_bool().unwrap(), "{name}");
                    }
                    "failed" => unsafe { voice_core_microphone_failed(&mut state, session) },
                    _ => panic!("unknown event"),
                }
                let running = unsafe { voice_core_microphone_running(&state) };
                assert_eq!(
                    if running == 0 { None } else { Some(running) },
                    step["running"].as_i64(),
                    "{name}"
                );
                assert_eq!(
                    unsafe { voice_core_microphone_may_prepare(&state) } != 0,
                    step["mayPrepare"].as_bool().unwrap(),
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn a_null_state_changes_nothing() {
        unsafe {
            assert_eq!(
                voice_core_microphone_start(std::ptr::null_mut(), 1),
                SKIPPED
            );
            assert_eq!(voice_core_microphone_stop(std::ptr::null_mut(), 1), 0);
            voice_core_microphone_failed(std::ptr::null_mut(), 1);
            assert_eq!(voice_core_microphone_may_prepare(std::ptr::null()), 0);
            assert_eq!(voice_core_microphone_running(std::ptr::null()), 0);
        }
    }
}
