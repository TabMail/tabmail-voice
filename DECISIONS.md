# TabMail Voice — Decisions

Compact index of architectural decisions for `tabmail-voice` (the TabMail Voice app). Cross-cutting decisions live in the
root `DECISIONS.md` (notably ADR-004 zero content retention, which dictation audio and transcripts
fall under).

---

Each decision's full text, its amendments included, is in `Companion/Decisions/Active/` (or
`Superseded/`), one file per ADR. A new decision or an amendment is written there in full, with
one line here carrying its number and title.

- **[ADR-DESK-001](Companion/Decisions/Superseded/adr-desk-001.md)**: Native Swift menu-bar app, on-device speech recognition *(superseded: speech by ADR-DESK-005, native Swift by ADR-DESK-032)*
- **[ADR-DESK-002](Companion/Decisions/Active/adr-desk-002.md)**: Insert by pasting, then restore the clipboard (amended: the paste never reads the clipboard; it is saved ahead and put back after)
- **[ADR-DESK-003](Companion/Decisions/Active/adr-desk-003.md)**: Not sandboxed; Developer ID distribution
- **[ADR-DESK-004](Companion/Decisions/Superseded/adr-desk-004.md)**: Phase 1 needs no account and no backend *(superseded by ADR-DESK-005)*
- **[ADR-DESK-005](Companion/Decisions/Active/adr-desk-005.md)**: Speech-to-text on the TabMail backend (OpenRouter), shared by all platforms
- **[ADR-DESK-006](Companion/Decisions/Active/adr-desk-006.md)**: Boot the microphone at key-down, reveal the overlay at the caret after the hold
- **[ADR-DESK-007](Companion/Decisions/Active/adr-desk-007.md)**: Screen context from the Accessibility tree, not screen pixels (phase 2 prototype)
- **[ADR-DESK-008](Companion/Decisions/Active/adr-desk-008.md)**: Agent Compose/Edit share dictation caret spacing; Clean up every transcript with the screen context, on the backend
- **[ADR-DESK-009](Companion/Decisions/Active/adr-desk-009.md)**: The app identifies itself to the backend as `voice` (was `macos`)
- **[ADR-DESK-010](Companion/Decisions/Active/adr-desk-010.md)**: A welcome wizard for consent, permissions and features; screen reading switchable
- **[ADR-DESK-011](Companion/Decisions/Active/adr-desk-011.md)**: Agent mode on a double tap: the agent chooses a tool, the tool writes the text *(its two calls superseded by one tool loop, ADR-DESK-055)*
- **[ADR-DESK-012](Companion/Decisions/Active/adr-desk-012.md)**: The app is TabMail Voice (`ai.tabmail.voice`)
- **[ADR-DESK-013](Companion/Decisions/Active/adr-desk-013.md)**: One repository for TabMail Voice on every platform, one folder per platform
- **[ADR-DESK-014](Companion/Decisions/Active/adr-desk-014.md)**: Thunderbird connector spike: drive TabMail's chat from outside
- **[ADR-DESK-015](Companion/Decisions/Active/adr-desk-015.md)**: Debug builds log user content in full, to the local log file only
- **[ADR-DESK-016](Companion/Decisions/Active/adr-desk-016.md)**: Lay the screen read out as the screen shows it; 2026-10-25: two reads, what the window shows and then the whole window (`wholeWindow`, `offscreen` fact; off-screen, point-thin `unplaced` text on its own line; node budget 100k, 1 MiB); the whole window bound to the first read's window or null (`sameWindowAs`, `LastReadWindow`); long fields whole only in the whole window (`fieldPlan` scope); agent reads the whole window only via `screen_read`
- **[ADR-DESK-017](Companion/Decisions/Active/adr-desk-017.md)**: Settings are read once, as a dictation starts
- **[ADR-DESK-018](Companion/Decisions/Active/adr-desk-018.md)**: Debug mode, only for allowed accounts; 2026-10-27: debug menu items + last recording (kept per dictation from the key-down snapshot, deleted when debug mode goes off) in release builds while debug mode is on
- **[ADR-DESK-019](Companion/Decisions/Active/adr-desk-019.md)**: Dictate in the keyboard's language, shown beside the waveform
- **[ADR-DESK-020](Companion/Decisions/Active/adr-desk-020.md)**: Agent tools one file each, connectors one folder each
- **[ADR-DESK-021](Companion/Decisions/Active/adr-desk-021.md)**: Tips that retire once learned, and hands-free dictation on a double tap
- **[ADR-DESK-022](Companion/Decisions/Active/adr-desk-022.md)**: The Answer tool, the chat window, and agent tools switched on and off; a click elsewhere or an app switch closes the idle chat window (closesChatElsewhere, chatMouseDown, chatFocusChanged, dismissChat; amendment 2026-10-25; amendment 2026-10-27: Answer always on, no switch, switchableAgentToolIDs, noToolEnabled removed, #279)
- **[ADR-DESK-023](Companion/Decisions/Active/adr-desk-023.md)**: The Answer tool's loop, with tools that run on this computer
- **[ADR-DESK-024](Companion/Decisions/Active/adr-desk-024.md)**: Calendar and Reminders, the first apps the Answer tool reaches
- **[ADR-DESK-025](Companion/Decisions/Active/adr-desk-025.md)**: Contacts, the third app the Answer tool reaches
- **[ADR-DESK-026](Companion/Decisions/Active/adr-desk-026.md)**: Files, Spotlight search the Answer tool can open from
- **[ADR-DESK-027](Companion/Decisions/Active/adr-desk-027.md)**: Email, a prefilled new message in the user's email app
- **[ADR-DESK-028](Companion/Decisions/Active/adr-desk-028.md)**: Notes and Messages, through AppleScript
- **[ADR-DESK-029](Companion/Decisions/Active/adr-desk-029.md)**: Shortcuts, listed and run through the `shortcuts` command
- **[ADR-DESK-030](Companion/Decisions/Active/adr-desk-030.md)**: The web, searched on the backend, read and opened on this computer
- **[ADR-DESK-031](Companion/Decisions/Active/adr-desk-031.md)**: While fn is the hotkey, the Globe key's own action is off
- **[ADR-DESK-032](Companion/Decisions/Active/adr-desk-032.md)**: One Electron app for macOS, Windows and Linux
- **[ADR-DESK-033](Companion/Decisions/Active/adr-desk-033.md)**: The bubbles surround the pill, one for each app Answer reaches *(placement superseded by ADR-DESK-036)*
- **[ADR-DESK-034](Companion/Decisions/Active/adr-desk-034.md)**: A bubble under the pointer grows and says what it is
- **[ADR-DESK-035](Companion/Decisions/Active/adr-desk-035.md)**: Agent mode sends the user's name, set in the wizard or Settings
- **[ADR-DESK-036](Companion/Decisions/Active/adr-desk-036.md)**: The chat window opens toward the vertical screen center (2026-10-26); the bubbles are a history of what ran; the chat window drags with its pill (chatDragStart, dragChat, draggedChat; amendment 2026-10-25)
- **[ADR-DESK-037](Companion/Decisions/Active/adr-desk-037.md)**: The Thunderbird tool is off until its native connector
- **[ADR-DESK-038](Companion/Decisions/Active/adr-desk-038.md)**: A dictionary of the user's words, typed or learned from their corrections; 2026-10-25: whole-window terms fill the vocabulary room left, never waited for
- **[ADR-DESK-039](Companion/Decisions/Active/adr-desk-039.md)**: A shorter wait between the release and the text
- **[ADR-DESK-040](Companion/Decisions/Active/adr-desk-040.md)**: The recording is peak-normalized before it is uploaded
- **[ADR-DESK-041](Companion/Decisions/Active/adr-desk-041.md)**: The app updates itself from cdn.tabmail.ai
- **[ADR-DESK-042](Companion/Decisions/Active/adr-desk-042.md)**: The text goes where the caret was at key-down, or onto the clipboard Captured target window, before Voice, background reads, restore/activate before paste, macOS focused field identity and click-to-copy on field loss; P4 scene tracking #276 (2026-10-26).
- **[ADR-DESK-043](Companion/Decisions/Active/adr-desk-043.md)**: The paste history, on a triple tap
- **[ADR-DESK-044](Companion/Decisions/Active/adr-desk-044.md)**: The code in folders by concern, each with a place for what comes next
- **[ADR-DESK-045](Companion/Decisions/Active/adr-desk-045.md)**: Apps the screen is never read in, with the password managers built in
- **[ADR-DESK-046](Companion/Decisions/Active/adr-desk-046.md)**: Secret-looking text is taken out of the screen read, in the helper, from one shared definition
- **[ADR-DESK-047](Companion/Decisions/Active/adr-desk-047.md)**: Websites the screen is never read on, with the password managers' web vaults built in; 2026-10-25: reading the whole window, an excluded page refuses it wherever it is, outside it too
- **[ADR-DESK-048](Companion/Decisions/Active/adr-desk-048.md)**: Every color in one palette file; one time for every color change
- **[ADR-DESK-049](Companion/Decisions/Active/adr-desk-049.md)**: Long dictations, cut into chunks at pauses and sent while the user speaks
- **[ADR-DESK-050](Companion/Decisions/Active/adr-desk-050.md)**: Windows and Linux update themselves too, from signed packages proven by the app *(Linux half superseded by ADR-DESK-058)*
- **[ADR-DESK-051](Companion/Decisions/Active/adr-desk-051.md)**: Agent mode reads a PDF the user approves, parsed in a disposable sandbox, redacted in the helper
- **[ADR-DESK-052](Companion/Decisions/Active/adr-desk-052.md)**: Right Alt as an Ubuntu dictation key, held by the GNOME extension
- **[ADR-DESK-053](Companion/Decisions/Active/adr-desk-053.md)**: The screen is read by a program of its own; 2026-10-25: numbered reads, `readScreenStop` answers with what was read so far (stop rule in Rust `read_stops.rs`); the whole window is read after, numbered after Reader-owned AX window tokens and guarded paste, preparePaste/finishPaste/cancelPaste (2026-10-26).
- **[ADR-DESK-054](Companion/Decisions/Active/adr-desk-054.md)**: Shared logic lives in Rust only; native code is thin OS adapters
- **[ADR-DESK-055](Companion/Decisions/Active/adr-desk-055.md)**: Agent mode is one tool loop; Compose and Edit end it by pasting; 2026-10-25: `screen_read` local tool reads the whole window (no protocol bump; listed only when the window was read)
- **[ADR-DESK-056](Companion/Decisions/Active/adr-desk-056.md)**: On GNOME, the extension says which window is in front
- **[ADR-DESK-057](Companion/Decisions/Active/adr-desk-057.md)**: On Windows, the Visual C++ runtime is installed system-wide by the installer
- **[ADR-DESK-058](Companion/Decisions/Active/adr-desk-058.md)**: Linux updates through an apt repository
- **[ADR-DESK-059](Companion/Decisions/Active/adr-desk-059.md)**: The Linux AppImage, for those who can't install the package
- **[ADR-DESK-060](Companion/Decisions/Active/adr-desk-060.md)**: Calendar events are edited, deleted and shared, at parity with Thunderbird and iOS
- **[ADR-DESK-061](Companion/Decisions/Active/adr-desk-061.md)**: Memory: agent-mode requests kept on this computer, searched by Thunderbird's helper
- **[ADR-DESK-062](Companion/Decisions/Active/adr-desk-062.md)**: The default event duration, in Settings and set by agent mode's Settings tool
- **[ADR-DESK-063](Companion/Decisions/Active/adr-desk-063.md)**: The knowledge base and writing style, kept on this computer, sent with agent mode; amended 2026-10-27: no KB refine (chat summarize removed, `KBRefiner`/`kbRefine.ts` deleted), KB changes only via `kb_add`/`kb_del`/Settings, memory_search covers chats; History copy states the last `promptHistoryMax` versions; amended 2026-10-27: a preferences file that can't be read or is damaged is never written over, reset or moved; launch dialog + tray Fix item with manual steps; failed saves say how to fix; while the settings file can't be read no screen, field (word learning) or other app (connectors) is read and no memory kept
- **[ADR-DESK-064](Companion/Decisions/Active/adr-desk-064.md)**: The app sends a protocol version, and shares Thunderbird's and iOS's prompts and tools
- **[ADR-DESK-065](Companion/Decisions/Active/adr-desk-065.md)**: On macOS the app is in the Dock while Settings is open
