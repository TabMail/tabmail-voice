## ADR-DESK-017: Settings are read once, as a dictation starts

**Context:** Owner standing rule, 2026-09-26 (root `Companion/Rules/Active/snapshot-settings-at-operation-start.md`):
"lock in all the settings … by taking a snapshot when everything starts … the snapshot is the first
thing that happens on the settings." Three review rounds in a row on the Thunderbird relay each
found another window where changing the email app in Settings mid-send paired one app's chat with
another; each fix compared Settings again and missed the next window.

**Decision:**
- `DictationController.start()` reads `AppSettings.dictation` (a `DictationSettings` value: consent,
  backend URL, screen reading, email app) as its first step at key-down, and the hold reads only that
  snapshot until it finishes: consent, whether the screen is read, the server every request of the
  hold goes to, the email app the Space toggle offers and the relay sends to. A change made during a
  hold applies from the next one.
- Nothing downstream reads Settings: the transcription and completions clients are made with the
  snapshot's URL, `ScreenContextProbe` no longer checks screen reading (the controller doesn't ask
  it), and `ThunderbirdRelay.send(_:to:)` is given the app.
- Facts about the world stay live: which app is in front (the key-down app for Edit and Compose), and
  whether the email app runs, is in front and has the chat focused.

**Consequences:**
- Every "does Settings still say X" comparison in the relay is deleted; a mid-send Settings change
  can no longer retarget a send.
- Not covered: the hotkey itself. Changing it in Settings reinstalls the monitor, which cancels a
  hold in progress (`HotkeyMonitor.setHotkey`); the owner accepts that behavior (2026-09-26).

