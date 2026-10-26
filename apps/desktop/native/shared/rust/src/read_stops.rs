// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::sync::atomic::{AtomicI64, Ordering};

/// The screen reads the app has asked to stop (`readScreenStop`, ADR-DESK-053), on every platform.
/// The app numbers its reads from 1 and, when it stops waiting for one, asks the reader to stop it:
/// that read, and every read numbered before it, ends at its next element with what it has read so
/// far. A read numbered after the highest stop is never asked, so a stop that arrives late never cuts
/// short the next read; nor is a read with no number (0). A lower stop after a higher one changes
/// nothing.
///
/// Value state shared with the native helpers: zero-initialized, never touched by them directly, no
/// allocation, callbacks or retained pointers. Stops arrive on the reader's input thread while the
/// walk asks on its own, so both calls may run at once.
#[repr(C)]
#[derive(Default)]
pub struct ScreenReadStops {
    /// The highest read asked to stop, 0 for none.
    stopped: AtomicI64,
}

impl ScreenReadStops {
    fn ask(&self, read: i64) {
        if read > 0 {
            self.stopped.fetch_max(read, Ordering::SeqCst);
        }
    }

    fn asked(&self, read: i64) -> bool {
        read > 0 && read <= self.stopped.load(Ordering::SeqCst)
    }
}

/// Asks read `read`, and every read numbered before it, to stop. Any number below 1 changes nothing.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_screen_read_stop(state: *const ScreenReadStops, read: i64) {
    if let Some(state) = unsafe { state.as_ref() } {
        state.ask(read);
    }
}

/// Whether read `read` is asked to stop: 1 when it is, else 0 (always for 0, a read with no number).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn voice_core_screen_read_asked(
    state: *const ScreenReadStops,
    read: i64,
) -> u32 {
    unsafe { state.as_ref() }.is_some_and(|state| state.asked(read)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asked(state: &ScreenReadStops, read: i64) -> bool {
        unsafe { voice_core_screen_read_asked(state, read) == 1 }
    }

    #[test]
    fn a_stop_asks_the_reads_numbered_up_to_it_and_no_later_one() {
        let state = ScreenReadStops::default();
        assert!(!asked(&state, 1), "nothing is asked before a stop");
        unsafe { voice_core_screen_read_stop(&state, 2) };
        assert!(asked(&state, 1) && asked(&state, 2));
        assert!(!asked(&state, 3), "a later read is not cut short");
        assert!(!asked(&state, 0), "a read with no number is never asked");
        unsafe { voice_core_screen_read_stop(&state, 1) };
        assert!(
            asked(&state, 2) && !asked(&state, 3),
            "a lower stop changes nothing"
        );
        for read in [0, -4, i64::MIN] {
            unsafe { voice_core_screen_read_stop(&state, read) };
        }
        assert!(
            asked(&state, 2) && !asked(&state, 3),
            "a number below 1 changes nothing"
        );
        unsafe { voice_core_screen_read_stop(&state, 5) };
        assert!(asked(&state, 3) && !asked(&state, 6));
    }

    #[test]
    fn a_missing_state_asks_nothing() {
        unsafe { voice_core_screen_read_stop(std::ptr::null(), 3) };
        assert!(unsafe { voice_core_screen_read_asked(std::ptr::null(), 1) } == 0);
    }

    #[test]
    fn stops_from_another_thread_reach_the_walk() {
        let state = std::sync::Arc::new(ScreenReadStops::default());
        let threads: Vec<_> = (1..=8)
            .map(|read| {
                let state = state.clone();
                std::thread::spawn(move || unsafe { voice_core_screen_read_stop(&*state, read) })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert!(
            asked(&state, 8) && !asked(&state, 9),
            "the highest stop wins whatever the order"
        );
    }

    #[test]
    fn the_state_is_laid_out_as_the_header_declares() {
        assert_eq!(
            std::mem::size_of::<ScreenReadStops>(),
            std::mem::size_of::<i64>()
        );
        assert_eq!(
            std::mem::align_of::<ScreenReadStops>(),
            std::mem::align_of::<i64>()
        );
    }
}
