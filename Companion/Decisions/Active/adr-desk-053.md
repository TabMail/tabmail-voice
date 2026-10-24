## ADR-DESK-053: The screen is read by a program of its own

**Context:** On Windows and Linux one helper process did the screen read and the paste. A read
that took long (a terminal's whole viewport through UI Automation or AT-SPI) held up the paste
behind it, so the terminal read was cut at 2.5 s, short of the helper's request timeout, and a
long read gave a partial or no terminal context. Owner, 2026-10-05: if a dictation takes 30
seconds and the screen read 15, that's fine; make the read a separate helper, a process of its
own, so it can take the time it needs. Then: do it on macOS too, and make it a small program of
its own, not a mode of the big helpers — the Unix philosophy, one program doing one thing.

**Decision:**
- **`voice-screen-reader`, one small program on each platform.** It serves `readScreen` and
  nothing else: macOS `VoiceScreenReader` (`ScreenReaderService` in `VoiceMacOSKit`),
  `voice-screen-reader.exe` (`native/windows/src/screen_reader.cpp`) and `voice-screen-reader`
  (`native/linux/src/screen_reader.cpp`). It takes no arguments and needs no microphone, hotkey,
  input session or portal. `voice-macos`, `voice-windows.exe` and `voice-linux` no longer serve
  `readScreen`. Only the walk is per platform (Accessibility, UI Automation, AT-SPI); the
  exclusions, the redaction and the viewport rules are the shared code (ADR-DESK-045, 046, 047).
  On Linux the reader keeps its own record of what has focus, and the AppArmor profile lets it
  leave the app's profile as `voice-linux` does, since AT-SPI accepts only unconfined peers.
- **The app owns the reader's lifetime** (`ScreenReader`, `src/main/native/screenReader.ts`, over
  a `HelperClient` named `voice-screen-reader`). It starts with the app and is killed at quit
  (`stopEndsAtOnce`: a read stuck in a provider never reads its closed stdin). A new read while
  the last is still going, or a read past `screenReaderTimeout` (the longest a recording runs), kills
  the reader and starts it afresh (`HelperClient.restart`), so a stuck provider never holds a read
  back or keeps a process alive. A read that answered, refused or ended with the process leaves it
  running. A reader started afresh takes requests only after its start-up focus lookup has run
  (on Linux), so the read that replaced another finds the window in front; if that lookup found
  nothing, the read answers null at once rather than waiting.
- **What waits for a read is bounded by the caller, not the reader.** A dictation takes the read
  only if it is done `contextWait` after the release; agent mode, which needs the whole read (its
  selection decides between Edit and Compose), waits `agentScreenWait` (5 s) and then goes on
  without the screen.
- **No terminal cap on Windows and Linux.** The terminal read's time limit is gone (Windows
  `terminalReadBudgetMs` unbounded, and the reader has no watchdog; Linux `withoutDeadline()`); an
  ordinary window's walk keeps its 1.5 s budget, which bounds how much it collects, not a wait.
  macOS keeps its walk budget as before.
- **Consequences:** one more helper process on each platform. Window tokens are each process's
  own, and `readScreen` takes none, so nothing passes between the reader and the main helper. On
  macOS the reader is the app's child, so it reads under the app's Accessibility permission, as
  `voice-macos` does.

*Amendment (2026-10-05, with ADR-DESK-052):* while GNOME holds the keyboard for Right Alt, the window
in front has no focus. The Linux reader asks the extension (`Holding`), as the helper does, so a read
made during the hold still reads that window; the Shell itself is never read.
Known limitation, accepted by the owner (2026-10-05): a reader *started* during the hold, because
the app restarted it for a read that superseded a still-running one, finds no focused window to
start from, so that one dictation gets no screen context (and agent mode offers Compose rather than
Edit). The next dictation reads normally.

*Amendment (2026-10-06, owner direction): no screen read has a time limit.* The shared walk's 1.5 s cap
(`timeBudgetMilliseconds`, and the `elapsed` the helpers sent with each `stop`) is gone from the
core and every helper; only the node budget (5,000) and the text budget stop a walk. A read runs
in the reader while the user speaks, the caller decides how long to wait for it (above), and the
cap cut Chrome reads short (it fell back to slow paths and left most of a long page unread); on the Mac, whole
reads finish in 300–1,500 ms. On Windows a read takes longer where the provider is slow: in the
test VM each look through 5,000 elements took about 3 s, and a focused element that size about 12 s,
past the dictation's wait (`contextWait`, 500 ms) and agent mode's (`agentScreenWait`, 5 s), so that
dictation gets no screen context where the cap used to give it part of one. Nothing bounds a read's
time but its counts and the provider's speed: a page built to be slow to read can keep the reader
busy until the next read restarts it or `screenReaderTimeout` (600 s) ends it, and a node's
children come in one call whatever their number. The reader is its own program, so a dictation
never waits on it longer than its own wait. This replaces the terminal-only exception above: Windows drops
`terminalReadBudgetMs` and every time check in the walk and its caret sources, and Linux drops
`withoutDeadline()`. What is not a screen read keeps its own bound: on macOS the look for an
excluded page before a field read for corrections (`focusedFieldPageScanBudget`, 0.2 s), on Windows
that read's looks (200 ms) and the look through what holds a page's selection
(`contextSelectionScanMs`), and on Linux the whole field read (`fieldReadMilliseconds`, 1.5 s, the
time it had before).

**Amendment 2026-10-07 — a terminal's field read runs in the helper, within a field read's time.**
Correction learning in a terminal reads its viewport in voice-windows and voice-linux (and the Mac
helper), as the box around the cursor (ADR-DESK-038, amended 2026-10-07); the screen read stays in
voice-screen-reader. That read is bounded as every field read is (1 s on Windows, 1.5 s on Linux),
and one out of time gives no field, so it holds up a caret placement or a paste at most that long.

**Amendment 2026-10-07 (later) — the focused field is read by a program of its own,
`voice-field-reader`, on every platform.** On Windows and Linux the overlay could appear 1–1.5 s
after the dictation key: `voice-windows.exe` ran `caretAnchor`, `insert` and `focusedFieldValue` one
at a time on one worker thread, and `voice-linux` served every request from one loop, so the caret
lookup at the key's press waited behind a correction watch's field read (a watch reads the field
every `correctionPollInterval` for `correctionWatchDuration` after each paste, and a terminal's read
takes up to the limits above). `voice-macos` answered each request in a task of its own, so the Mac
never waited: the platforms differed. Owner, 2026-10-07: the same architecture on every platform, not
a per-platform one — a separate program, a screen reader and a focused-field reader, sharing code.
- **`voice-field-reader`, one small program on each platform**, beside `voice-screen-reader`: macOS
  `VoiceFieldReader` (`FieldReaderService` in `VoiceMacOSKit`), `voice-field-reader.exe`
  (`native/windows/src/field_reader.cpp`) and `voice-field-reader` (`native/linux/src/field_reader.cpp`).
  It serves `focusedFieldValue` and nothing else (it served `frontmostApp` too until the 2026-10-08
  change below), with the same code the helpers
  ran (`SharedRequest.fieldValue`, `Automation::fieldValue`, `focusedRead`, the shared core's bound
  and redaction). `voice-macos`, `voice-windows.exe` and `voice-linux` no longer serve
  `focusedFieldValue`, so a caret placement or a paste never waits behind a field read.
- **The watch's target is the field reader's own.** A watch asks the field reader what is in front
  as it starts (`FieldReader.target`, just after the paste) and reads that window or process: on
  Linux window tokens are each process's own, and the same rule holds on every platform. The
  dictation no longer hands the watch its target. A window that took the front between the paste and
  that question is watched instead; its field does not hold the pasted text, so nothing is learned.
  *Superseded 2026-10-08 (below): that window can hold the same words.*
- **Changed 2026-10-08 — the watch is bound to the paste's own target, by an identity both helpers
  share.** A review of the change above found its last sentence wrong: a window switched to in the
  moment after the paste can show the same words (the same message open in another window, a
  draft beside a preview), and its edits were then learned as corrections of the dictation. As before
  the field reader, the dictation hands the watch its target: the main helper's `frontmostApp` at
  key-down (`targetApp`), which the paste was just checked against (`DictationController.deliver`;
  `CorrectionWatch.watch(target, …)`), and the field reader reads that one only. The two programs name
  it by an identity both have: the app's process on macOS (`pid`, as before), the window's handle on
  Windows (`window`, the HWND `voice-windows.exe` names, passed through), and on Linux, where a window
  token is each process's own, the window's process: `voice-linux`'s `frontmostApp` replies
  `{window, pid}` (the pid its focus record already took from AT-SPI), the app keeps the pid of the
  last reply's window (`LinuxSystem.appOf`) and maps the paste's window token to it (`FieldReader`'s
  `identity`), and the reader reads only while the window in front is that process's
  (`focusedRead` checks `pid` against its own focus record before reading, and the window in front
  again when the read ends). A token
  with no known process reads nothing. The field reader no longer serves `frontmostApp` on any
  platform. A read asked while another is still going (a superseded watch's) restarts the reader, as
  the watch's start did. Accepted by the owner (2026-10-08): on macOS and Linux the identity is the
  app, not the window, so two windows of one app switched between within a moment of the paste can
  still mix, as on the Mac before; Windows names the window.
- **The app owns its lifetime as it does the screen reader's** (`FieldReader`,
  `src/main/native/fieldReader.ts`, over a `HelperClient` named `voice-field-reader` with
  `stopEndsAtOnce`): started with the app, killed at quit; a watch that starts while a read is still
  going, or a request past `fieldReaderTimeout` (`correctionWatchDuration`), restarts it. On Linux it
  takes requests only after its start-up focus lookup, as the screen reader does. The AppArmor
  profile lets it leave the app's profile (`Ux`) as the other helpers do.
- **The field read's own limits stay** (Windows' 200 ms looks and `terminalFieldReadMs`, Linux
  `fieldReadMilliseconds`, macOS `focusedFieldPageScanBudget`): they bound how hard a read every half
  second works a slow app. On Windows the read no longer runs under `voice-windows.exe`'s 2.5 s
  watchdog; the app's timeout ends a stuck one.
- **Consequences:** one more helper process on each platform. Where the amendment above says a
  terminal's field read runs in the helper, it now runs in `voice-field-reader`; its time limits stand.

