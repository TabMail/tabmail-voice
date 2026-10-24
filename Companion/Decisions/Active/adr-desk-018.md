## ADR-DESK-018: Debug mode, only for allowed accounts

**Context:** Owner, 2026-09-26: the menu's Start Dictation and debug items (Play Last Recording,
Show Last Screen Context, Show Log File) should show only in debug mode; debug mode is the
"Use development server" switch, and that switch should show only to the allowed debug accounts.

**Decision:**
- `DebugAccess` allows the same accounts as iOS `DebugModeManager`: the `tabmail.ai` domain and its
  short list of named addresses, compared case-insensitively.
- The Settings switch is now "Debug mode" (stored as `debugMode`), shown only while an allowed
  account is signed in. Debug mode is on only when the switch is on AND the account signed in is
  allowed (`AppSettings.isDebugMode(for:)`); a switch left on does nothing once another account, or
  none, is signed in.
- Debug mode sends dictation to the development server, and is part of the settings snapshot read
  at key-down (ADR-DESK-017, `dictation(for:)`).
- The menu shows Start Dictation and the debug items only in debug mode. A Stop for a recording in
  progress stays whatever the mode, so a recording can always be stopped (ADR-DESK-010). The debug
  items are also compiled only into debug builds, as before.

**Consequences:**
- Everyone else dictates with the hotkey only; the menu keeps setup, Welcome Guide, Settings and Quit.
- The old `useDevelopmentServer` switch isn't carried over: debug mode starts off once.

