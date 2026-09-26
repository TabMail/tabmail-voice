# TabMail Desktop — Tests

Run: `xcodebuild -project TabMailDesktop.xcodeproj -scheme TabMailDesktop -derivedDataPath DerivedData test`
(Swift Testing, hosted in the app; needs `Secrets.xcconfig` from the template; add `CODE_SIGN_IDENTITY=-` if its team is unset).
No test touches the network, the user's clipboard, or the real Keychain item.

| Suite | Covers |
|-------|--------|
| `PushToTalkGestureTests` | press/release, other modifiers ignored, chord cancels and swallows release, Fn key |
| `TextInserterTests` | text pasted with transient/concealed markers; multi-item/multi-type clipboard restored; empty stays empty; a clipboard changed mid-insert is not clobbered |
| `AudioRecorderTests` | 48 kHz float → 16 kHz mono Int16; stereo downmix; first-audio time; max-duration cap; empty |
| `LevelEnvelopeTests` | EMA envelopes: quiet-mic speech 2.5 dB over the room moves the waveform (> 0.4); adapts to the incoming range (louder syllables read higher, no pinning); settles within the first second despite a start-up blip; a steady hum settles low |
| `OverlayGeometryTests` | Accessibility → screen coordinate flip; the pill's top edge exactly the gap below the caret line (not the canvas's), above the caret near the screen bottom, always on screen; placeholder/off-screen caret rects rejected; a line-sized "caret" box anchors at its leading edge |
| `AccessibilityActivatorTests` | Gecko apps recognised by `Contents/MacOS/XUL`, Electron apps by `Electron Framework.framework`; every other app (and a missing bundle) is left alone |
| `ScreenContextTests` | Caret text: split around the selection, nearest characters kept, out-of-range clamped, no split emoji; visible text: blanks and repeats dropped, structure marked, the caret block keeps its place in the reading order (empty field, selection); log summary carries sizes, never text; terminal: first visible line by binary search, tmux active pane = most recent client, pane split at the cursor cell (padded past a trimmed line end), foreground program = process-group leader; the pane counts only when its lines are on the front terminal (side-by-side panes match, another tab's tmux and a blank pane don't) |
| `WAVEncoderTests` | every header field; AVAudioFile reads the output (independent oracle) |
| `TranscriptionClientTests` | request URL/headers/body; backend error → user error mapping; missing text; one forced-refresh retry on 401 only; signed-out never calls backend; sign-out or account switch during a refused request reports `unauthorized` without sending a retry |
| `CompletionsClientTests` | request URL/headers, JSON content type, configured timeout, current timestamp in milliseconds and app version; variables flattened beside role and content; last `final` selected even with trailing keepalives; `error` event, refused or malformed `final`, missing `final` and HTTP errors fail, with status preserved for a missing or non-JSON error body; SSE blank lines end events before unlabelled data, comments within events are ignored, padded names are trimmed, consecutive events and EOF flush both name and data, data lines join at LF/CRLF/CR; U+0085/U+2028/U+2029 remain text |
| `DictationCleanupTests` | the cleanup prompt (the backend's name, spelled out) gets the dictation, app, host, terminal program, window title and the rendered screen text with the caret; without context every field is sent empty |
| `DictationCleanupFallbackTests` | the cleaned text is pasted (trimmed), including a single character; every cleanup failure (HTTP error, stream error, refusal in `final`, empty reply, no `final`, unreachable backend, signed out) pastes the transcript as heard; 401 → one refresh → retry with the new token; a second 401 or a rejected refresh pastes the transcript; another account signed in (before, or during the first request) gets no cleanup request; a cleanup still running at its timeout pastes the transcript without waiting for the reply and cancels the request, and a reply within it is used |
| `DictationControllerTests` | a finished recording through the controller with a silent capture: the cleaned text is pasted; a failed cleanup pastes the transcript; an empty or failed transcription sends no cleanup and pastes nothing, and failures show the shared backend message; a cleanup that never answers pastes the transcript at the app's own cleanup timeout, and one slower than the screen-read wait but within that timeout is pasted (the controller gives the cleanup the full timeout); cancelled during the cleanup cancels the request at once (not at the cleanup timeout) and pastes nothing; an account switch during the transcription skips the cleanup. Key-down to paste with a tone capture and fixed grants: the screen is read once, at key-down, before the overlay shows and before anything is transcribed; a screen read done within the wait is sent with the transcript, one done shortly after the transcript on the default wait is still sent, and one not done within the app's own wait is left out (the cleanup runs without it); cancelled while the screen is read sends no cleanup and pastes nothing, and the next dictation uses its own screen |
| `ScreenContextCommandTests` | a helper command's output is returned, including all 200,000 bytes of mixed UTF-8 across multiple reads; EOF before exit still waits for success within the original command deadline, without restarting the timeout; new blocking cases have independent watchdogs; a command that doesn't finish, or whose output never ends (a background child holding it, as a stopped tmux server does), is given up at the deadline; output still flowing at the deadline is not read on (40 short reads, since whether a read is mid-stream then depends on scheduling); a command still running at the deadline (with or without its output closed) is gone within a second (retried with a doubling deadline, 0.2 s up to 3.2 s, until a run got far enough to write its pid, since on a loaded runner starting the shell can outlast a short deadline) |
| `ScreenContextProbeTests` | no read without the Accessibility grant or a frontmost app; the app name, bundle and process ID read are those in front at key-down, not at read time; a capture overtaken by a newer one still yields its own screen, and the debug window keeps the newest |
| `AsyncTimeoutTests` | original operation errors propagate; a deadline returns `TimeoutError` with its duration and description without waiting for an operation that ignores cancellation; independent watchdogs bound lost continuations |
| `PermissionsModelTests` | supplied microphone states (undecided, restricted, denied and authorized) and both Accessibility states are preserved without consulting the OS |
| `AccountTests` | OTP send/verify request shape + errors; refresh user mismatch; session persisted; fresh token reused; expiring token refreshed; **concurrent callers share one refresh** (red-verified); rejected refresh signs out; sign-out during refresh doesn't resurrect |

## Not covered by unit tests (manual checklist)

- Sign in with an email code in Settings; relaunch — still signed in.
- Hold Right Option in: TextEdit, Mail, Thunderbird compose, Safari/Chrome text areas, Slack,
  VS Code, Terminal. The text appears and the clipboard is unchanged afterwards.
- ⌥-letter while holding Right Option types the special character and inserts nothing.
- A tap shorter than `minimumHoldDuration` uploads nothing; holding without speaking shows
  "Didn't catch that. Try again." on one line and types nothing.
- The last word survives releasing the key mid-word (`releaseTailDuration`). Debug builds:
  menu › Play Last Recording plays exactly what was uploaded.
- Mic indicator in the menu bar clears `releaseTailDuration` after the key is released.
- Signed out / no subscription / network off: the overlay shows a clear message.
- Granting Accessibility in System Settings makes the hotkey work without relaunching.
- Overlay appears just below the text cursor (TextEdit, Mail, Safari); below the focused field
  where the app exposes no caret; at the mouse pointer only when neither is available. It never
  appears at the pointer first and then jumps. A quick tap shows nothing. Swirl while the mic
  warms up, then the pill. A long message (e.g. signed out) wraps and the pill grows to fit it.
- Switching the default input in System Settings › Sound is picked up on the next dictation.
- Release build: dictate a name that is on screen with an unusual spelling (e.g. a colleague in a
  mail thread); it is pasted spelled as on screen. This is the only check that the app wires the
  screen read into every dictation (tests replace it).

## Next

- `DictationController` state machine before the upload (start while transcribing, cancel during
  the recording, failure reset timing); `DictationControllerTests` covers from the upload on, and
  one hold-and-release path with the screen read.
