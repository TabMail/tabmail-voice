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

**Amendment, 2026-10-27 (owner: "show them in release builds when debug mode is on"):** the sentence
"The debug items are also compiled only into debug builds" no longer holds. The menu's Play Last
Recording, Show Last Screen Context, Show Smoke Test Tip and Show Log File exist in every build and
show while debug mode is on (the switch on AND an allowed account, `AppSettings.isDebugMode`, the
`MenuState.debugMode` the tray reads), and in none while it is off.

- **The invariant:** a debug item and the data behind it exist in a release build only while debug
  mode is on.
- **The last recording** (`TabMail-last-dictation.wav` in the temporary folder) is kept per dictation
  from the settings snapshot taken at key-down (`DictationSettings.keepsRecording`, ADR-DESK-017): a
  switch changed during a hold applies from the next dictation. With debug mode off nothing is
  written, in a debug (unpackaged) build as well as a release one.
- **Turning debug mode off deletes the file** (the privacy-safe choice), as does signing out or
  signing in to an account that is not allowed, and so does a launch with debug mode off (the switch
  or the account changed while the app was closed). Deleting and writing run in order
  (`LastRecording`), so a recording still being written when debug mode goes off is removed after it
  lands. A dictation that started with debug mode on but ends after it went off keeps nothing: the
  delete is the one place a change of debug mode applies mid-dictation, because "off" is a privacy
  action (`LastRecording.follow`). The last screen context, held in memory, and the sample tip are
  dropped the same way, and the windows showing them are redrawn.
- The file is created for this user alone (mode 0600), over nothing: an existing file or symlink at
  that name is removed first and never written through (the temporary folder is shared on Linux).
- The debug log file (ADR-DESK-015) is NOT deleted when debug mode goes off; it stays for the owner
  to read and rotates by size. Owner, 2026-10-27, decided: keep it ("having those logs is fine. This
  is really debug mode, and it's only something that you can turn on if you are our developers").
- **Show Log File** offers the file debug mode writes (ADR-DESK-015; on macOS
  `~/Library/Logs/TabMail Voice/TabMail Voice.log`, elsewhere Electron's `logs` folder).
