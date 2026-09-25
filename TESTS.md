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
| `TranscriptionClientTests` | request URL/headers/body; backend error → user error mapping; missing text; one forced-refresh retry on 401 only; signed-out never calls backend |
| `CompletionsClientTests` | request URL/headers; variables flattened beside role and content; reply from `final` after primer and keepalives; `error` event, `final` carrying an error, no `final` and HTTP errors all fail; SSE events end at blank lines, the next event or the end, comments skipped, data lines joined, CRLF |
| `DictationCleanupTests` | the cleanup prompt gets the dictation, app, host, terminal program, window title and the rendered screen text with the caret; without context every field is sent empty |
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

## Next

- `DictationController` state machine with injected capture fakes (start while transcribing,
  cancel during upload, failure reset timing).
