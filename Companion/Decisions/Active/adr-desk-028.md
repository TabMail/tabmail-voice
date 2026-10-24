## ADR-DESK-028: Notes and Messages, through AppleScript

**Context:** Owner, 2026-09-26: the agent answers from Apple Notes, adds notes, and sends iMessages;
AppleScript is acceptable where the app has no framework. Sending or creating anything is confirmed
first (ADR-DESK-023). One switch per app, on by default, in Settings and the wizard (ADR-DESK-024).
The backend defines `notes_search {query}`, `notes_create {title, body}` and `messages_send {to,
text}` (`src/tools/macos/`). First built in the Swift app; built here in the Electron app
(ADR-DESK-032).

**Decision:**
- The `notes` connector with `NotesSearchTool` (`notes_search`: notes whose title or text contains
  the query, locked notes left out, newest first, at most `notesSearchMaxResults` in full, more
  said) and `NotesCreateTool` (`notes_create`: a title and text, added to the default account's
  default folder once confirmed), in `src/core/agent/connectors/notes.ts`. The `messages` connector with
  `MessagesSendTool` (`messages_send`: one iMessage to one phone number or email address, once
  confirmed; a name goes back to the model to look up with `contacts_search`), in
  `messages.ts`.
- Neither app has a public framework, so each tool runs a fixed AppleScript through a
  `ScriptRunner` (`appleScript.ts`, faked in tests). What the model wrote reaches the script only
  as `argv`, never inside its source, so no text can change what a script does. The arguments
  follow `--`, so one that looks like an option (`-e …`) is data too (without it, a search for `-e`
  plus script ran that script unconfirmed).
- The runner is `/usr/bin/osascript` launched from the **main process** (`src/main/native/osascript.ts`),
  not a `voice-macos` method. The one reason is cancellation: `ConnectorTool.run` now takes the
  request's `AbortSignal`, and a canceled request or a closed chat window ends the osascript
  process. The helper channel can't call off a request it has taken, so a script run there would
  keep going, a send included, until it finished or timed out. This is a system program run with
  arguments, not native code in Node, so `apps/desktop`'s rule (OS work in a native helper, never
  a Node addon) is kept in spirit; the scripts are plain text either way. A request already
  canceled starts no process: Node starts one for an aborted signal and ends it only a tick later.
- Each script waits at most `appleScriptTimeoutSeconds` for the app to answer each command it
  sends (`with timeout`); a whole run has no deadline (ADR-DESK-023), and canceling ends it. A search's
  output is capped at `appleScriptMaxOutputBytes`; past it the search fails rather than cutting a
  note short.
- A note's text is written as Notes' HTML (`NotesScripts.html`): the title as its heading, one line
  per line, escaped, so what the user confirmed is what the note shows.
- Access: macOS asks the first time the app sends Notes or Messages an Apple Event
  (`NSAppleEventsUsageDescription`, the hardened runtime's `automation.apple-events` entitlement).
  A refusal (-1743) fails the request with where to allow it (System Settings › Privacy & Security
  › Automation), naming the app the script tells (`ScriptError.noAccess`).

**Consequences:**
- The first use of each app raises macOS's Automation prompt, and launches the app if it is not
  running.
- Notes' text and the message go to the model and the app only: nothing is stored (ADR-004).
- Messages sends over iMessage only; SMS through a paired iPhone is not offered. A send canceled
  after Messages has taken it may still go out.
- Unverified against a live Notes library: whether its `notes` include "Recently Deleted" ones, and
  how long a search over a large library takes (each command bounded by `appleScriptTimeoutSeconds`,
  the whole search only by a cancel). No test
  sends an Apple Event to either app: the scripts are compiled against each app's dictionary
  (`osacompile`), and the runner is tested on scripts that tell no app.
- Offered on macOS only, with the other connectors.

**Amendment 2026-10-07 (live Notes):** on macOS 27 Notes cannot name a note's own folder: `name of
container` fails with -1700 on every note, so every search failed, and every `notes_create` failed
after adding its note (the owner's smoke test of 0.2.0). The scripts no longer ask a note for its
`container`: `search` walks every account's folders (`folders of` an account lists its subfolders
too, and a folder's `notes` are only its own, so each note is read once, with its folder's name), and
`create` returns the name of the default folder it adds the note to. A live suite now runs the tools
against the real Notes app (`test/main/native/notesLive.test.ts`, macOS only, opt-in with
`TABMAIL_VOICE_LIVE_NOTES=1` as it adds and deletes notes and folders named with one run's marker). It
answers the earlier unverified point: a search does match notes in "Recently Deleted", which it reads
as that folder. That `folders of` an account lists its subfolders is observed on macOS 27 only:
Notes' scripting dictionary does not say. Measured on macOS 27 (a library of about 640 notes in four
accounts): a search matching 20 notes takes about 2 s, faster than the earlier whole-library
`notes whose` (about 13 s); one matching several hundred notes runs for minutes, as it did before, bounded
only by a cancel.

