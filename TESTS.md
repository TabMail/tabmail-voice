# TabMail Desktop — Tests

Run: `xcodebuild -project TabMailDesktop.xcodeproj -scheme TabMailDesktop -derivedDataPath DerivedData test`
(Swift Testing, hosted in the app; needs `Secrets.xcconfig` from the template; add `CODE_SIGN_IDENTITY=-` if its team is unset).
No test touches the network, the user's clipboard, or the real Keychain item.

| Suite | Covers |
|-------|--------|
| `PushToTalkGestureTests` | press/release, other modifiers ignored, chord cancels and swallows release, Fn key |
| `TextInserterTests` | text pasted with transient/concealed markers; multi-item/multi-type clipboard restored; empty stays empty; a clipboard changed mid-insert is not clobbered |
| `AudioRecorderTests` | 48 kHz float → 16 kHz mono Int16; stereo downmix; peak level for silence skip; max-duration cap; empty |
| `WAVEncoderTests` | every header field; AVAudioFile reads the output (independent oracle) |
| `TranscriptionClientTests` | request URL/headers/body; backend error → user error mapping; missing text; one forced-refresh retry on 401 only; signed-out never calls backend |
| `AccountTests` | OTP send/verify request shape + errors; refresh user mismatch; session persisted; fresh token reused; expiring token refreshed; **concurrent callers share one refresh** (red-verified); rejected refresh signs out; sign-out during refresh doesn't resurrect |

## Not covered by unit tests (manual checklist)

- Sign in with an email code in Settings; relaunch — still signed in.
- Hold Right Option in: TextEdit, Mail, Thunderbird compose, Safari/Chrome text areas, Slack,
  VS Code, Terminal. The text appears and the clipboard is unchanged afterwards.
- ⌥-letter while holding Right Option types the special character and inserts nothing.
- A tap shorter than `minimumHoldDuration`, or holding without speaking, uploads nothing.
- Mic indicator in the menu bar clears as soon as the key is released.
- Signed out / no subscription / network off: the overlay shows a clear message.
- Granting Accessibility in System Settings makes the hotkey work without relaunching.

## Next

- `DictationController` state machine with injected capture fakes (start while transcribing,
  cancel during upload, failure reset timing).
