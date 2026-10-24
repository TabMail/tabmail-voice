## ADR-DESK-031: While fn is the hotkey, the Globe key's own action is off

**Context:** Owner, 2026-09-27: with fn as the hotkey, a press or a double tap also switched the
input source, macOS's "Press 🌐 key to" action. The event tap cannot stop it: WindowServer runs the
Globe action ahead of every event tap (reported by OpenWhispr, TTP and input0, all of which tried
to swallow the event), so returning nil from `HotkeyMonitor`'s tap changes nothing. Most dictation
apps that default to fn ask the user to pick "Do Nothing"; Settings asked the same. Offered that or
switching the setting for the user, the owner chose the second ("option 2").

**Decision:**
- While fn is the hotkey, `GlobeKeyAction` sets the Globe action to Do Nothing, and puts the user's
  choice back when another key becomes the hotkey or the app quits (`NSApplication.willTerminateNotification`,
  observed in `AppDelegate.connectHotkey`, which also points the hotkey monitor at each change). It
  calls HIToolbox's private `TISGetFnUsageType`/`TISUpdateFnUsageType`, looked up with `dlsym` in
  Carbon: what System Settings calls, which applies at once; writing `AppleFnUsageType` itself takes
  effect only at the next login. OpenWhispr (MIT) and Inputalk ship the same approach.
- The user's choice is saved in the app's defaults (`globeKeyActionBeforeFnHotkey`) before the
  setting changes, so a run that crashed is put right at the next launch: restored if fn is no
  longer the hotkey, still held if it is.
- The user's own later choice wins: the setting is put back only while it is still Do Nothing, and a
  choice made while the app was not running is the one saved. A user who chose Do Nothing already
  is never touched. A later choice of Do Nothing itself cannot be told from the app's own, so after
  a crash it is replaced by the saved choice.
- Settings says so under the hotkey picker, in place of asking the user to change the setting.

**Consequences:**
- A private API: if a macOS drops the calls, `System.live` is nil, the setting is left alone and fn
  still triggers the Globe action (logged). `theSystemCallsExist` fails first on such a macOS.
- The app changes a system-wide setting: while it runs with fn as the hotkey, the Globe key does
  nothing anywhere, including its double press for macOS dictation. An app deleted without quitting
  normally, or never launched again after a crash, leaves Do Nothing in place.
- Put back through `TISUpdateFnUsageType`, a choice that was macOS's computed default is now stored
  explicitly; it reads the same.
- The unit-test host never creates `GlobeKeyAction` (it is made after the XCTest guard), so a test
  run can never restore a setting the running app holds. (No test pins that placement: the SwiftUI
  delegate adaptor keeps the `AppDelegate` out of the test's reach, and so is the launch call to
  `connectHotkey`, like all wiring after the guard; the owner's use of fn exercises it.) Tests use a stand-in for the setting and only read the real one.
- Numbered 031: ADR-DESK-022 to 030 are taken by agent-tool branches not yet merged.
- Whether fn still reaches the event tap with Do Nothing selected is reported both ways online; the
  owner's manual test on this change settles it for the hotkey.

**Amendment 2026-09-27 (owner report: with fn, a double tap never went hands-free; Right Option's did):**
- Settled by a listen-only probe on the owner's MacBook keyboard, Globe action on Do Nothing: fn does
  reach the event tap (`flagsChanged`, key code 63), and each release from a tap is followed 0–3 ms
  later by a `keyDown` and `keyUp` of key code 0xB3, the Globe key's own, which Carbon has no name for.
  The gesture read that key-down as typing between the taps (ADR-DESK-021: typing breaks a double
  tap), so the second press started an ordinary hold. The app log showed it: "tap; waiting for a
  second press", then a new arming instead of hands-free, about 100 ms apart.
- `PushToTalkGesture.keyPressed` ignores that key-down while fn is the hotkey
  (`DictationHotkey.globeKeyCode`); both events still reach the app. `HotkeyMonitorTests` replays
  the recorded sequence. The owner confirmed the double tap with fn on a build with this change.
- The Electron app's `voice-hotkey` helper (ADR-DESK-032) carries the same skip and replay test.

