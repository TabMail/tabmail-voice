## ADR-DESK-002: Insert by pasting, then restore the clipboard (amended: the paste never reads the clipboard; it is saved ahead and put back after)

**Context:** Dictated text must land in any focused field: native, Electron, browser, terminal.

**Decision:** Write the text to the general pasteboard (marked `org.nspasteboard.TransientType` /
`ConcealedType`), post ⌘V, wait `DictationConfig.clipboardRestoreDelay`, then restore every item
and type of the prior clipboard, unless the pasteboard changed meanwhile.

Across macOS, Windows and Ubuntu, send the platform paste command and let the target
application decide whether to consume it. Do not require an editable-field accessibility
pattern or an application allowlist for insertion. Retain target identity, cancellation
and clipboard safeguards. A completed paste command does not prove the target changed
its text; editable-field eligibility still governs correction learning and field reads.

**Rationale:** Setting `kAXSelectedTextAttribute` silently fails in most web views and Electron
apps; synthesizing per-character key events is slow and breaks on non-ASCII text. Pasting is what
Wispr Flow and similar tools do.

**Consequences:** A clipboard manager that ignores the transient markers may record the text.
Apps that read the pasteboard lazily after the restore delay would paste the old clipboard; the
delay is a config value to tune if that's seen.

**Amendment (owner, 2026-10-05) — the clipboard is written, never read, and not put back.** Owner:
*"we don't need to ever read the clipboard, and we should never read the clipboard. We should just
paste it into it"*; *"we won't restore the clipboard after paste."* Saving the clipboard to put it
back afterwards was the only reason any helper read it, and the read was what failed: it asks the
app that owns the clipboard for every item's data, which a busy app (or a VM's clipboard agent)
hands over late, so on the Mac a paste sometimes timed out ("Something went wrong") and worked when
tried again, and Windows and Ubuntu bounded the wait and typed the text or pasted without restoring.
Now every helper writes the text, marked as before (transient and concealed on the Mac, which does not
keep it off Universal Clipboard; out of clipboard history and the cloud on Windows; plain text on
Ubuntu), sends the paste keys, and is done: `TextInserter` on the Mac, `Clipboard::putText` and
`paste` on Windows, `Inserter` on Ubuntu. There is no restore delay on the wire (`insert {text}` on
the Mac; `{text, window, deadline}` on Windows and Ubuntu, waited for `insertionReplyGrace` past the
deadline), no save on a thread of its own, no typed fallback, and Ubuntu no longer refuses a paste
while the clipboard's state is unannounced or holds a file transfer. Ubuntu still pastes only once
this session owns the selection, and a copy landing between the publish and the paste vetoes it.
Consequences: after a dictation the clipboard holds the dictated text, and what the user had copied
before is gone, as it already was for an unpasted dictation (ADR-DESK-042). The lazy-reader hazard
above is gone with the restore. On Windows a clipboard another program holds open for longer than
the helper's 500 ms open wait still cannot be written, and that paste fails. The Windows paste and
privacy fixtures keep the test machine's clipboard as they found it (`SavedClipboard`); `electron.mjs`
and `terminal-paste.mjs` leave their synthetic text on the test VM's clipboard. The helpers never put
anything back.

**Amendment (owner, 2026-10-08) — saved ahead, put back after; the paste still never waits.** Owner:
*"I now want our paste to not affect clipboard unless we of course change app"*, *"we don't
contaminate the clipboard directly"*, and of the delay the old save caused: *"I still don't want that
delay, so pasting should happen and the cleaning up sort of best effort cleanup or delayed cleanup as
required. So no holdup."* This reverses the 2026-10-05 "not put back"; its "the paste never reads the
clipboard" stands.
- **Save, ahead and in the background.** Every system helper answers a new wire method,
  `clipboardSave {}` → `{}`, at once. The app sends it, without waiting, as a dictation starts (right
  after `arming`) and as it ends (`transcribing`). The helper's `ClipboardKeeper` then reads every
  item and type off the request path: a detached task on the Mac (measured: a read stuck on a late
  provider never holds up a main-thread write; it comes back stale and is dropped), a thread of its
  own on Windows, asynchronous portal `SelectionRead`s on Ubuntu's event loop. A clipboard left as it
  was since the last save (the pasteboard's `changeCount`, the clipboard sequence number, the portal's
  selection announcement) is not read again. One read runs at a time: a save asked for while one is
  still reading is skipped on the Mac and Windows (an owner that never answers holds one read, not
  one per copy); on Ubuntu the newer save cancels the older read.
- **Paste, then put back.** `insert` writes the text and sends the paste keys at once, as before,
  and answers after the keys. `restoreDelay` after them (the shared core's, 500 ms: the target reads
  the clipboard as it handles the keys), in the background, the saved clipboard goes back, only while
  the clipboard still holds the paste's text and the save was of the clipboard as it was just before
  the paste. The paste's own change count is the one its clear gives on the Mac and its own selection
  announcement on Ubuntu; on Windows the sequence number is read once the paste closes the clipboard
  (closing adds the formats Windows makes from the text), so the put-back also checks, with the
  clipboard open, that it still holds the paste's text. Otherwise the text stays: a copy made in between is never overwritten, and there is no
  other fallback. A paste refused once its text is written puts the clipboard back too. Two pastes in
  a row, the second before the first's put-back: the clipboard as it was before both goes back, once.
- **Not saved, not put back:** a password manager's clipboard (the Mac's
  `org.nspasteboard.ConcealedType`, Windows' `ExcludeClipboardContentFromMonitorProcessing`, Ubuntu's
  `x-kde-passwordManagerHint`), told by its types before any data is asked for: putting it back would
  outlive the manager's clear; an Ubuntu file transfer (`application/vnd.portal.filetransfer`); a
  clipboard over the shared core's limits (`maxBytes` 64 MiB, `maxFormats` 256; the core's
  `{"clipboard": {}}` request gives them and the delay; Windows counts its memory formats toward
  `maxBytes`, and copies a bitmap, palette or metafile handle uncounted); Windows' owner-display and
  private handles.
  The paste's own text is marked as before, so it is never saved either.
- **Residuals, to be confirmed by the owner:** (a) Windows only: a save still reading when the paste
  comes holds the clipboard open, as any other program can, and the paste waits up to its 500 ms open
  wait for it; a save held past that by an app slow to hand its data over fails the paste. (b) On the
  Mac and Ubuntu a save still under way at the paste is dropped and the text stays. (c) A copy made
  after the release-time save and before the paste is lost to the paste, as any copy the paste
  writes over: the clipboard as it was before that copy is not put back, and the text stays. (d) Ubuntu saves
  nothing until the portal first announces the selection (GNOME is silent at session start). (e) A
  password manager's clipboard is not put back; the text stays. (f) Mac and Windows: a clipboard
  copied while an earlier save is still reading is not saved, and the text stays. (g) Mac and
  Ubuntu have no conditional clipboard write: a copy that lands between the put-back's check and its
  write (on the Mac, two adjacent calls, the items built before the check) is overwritten by the
  clipboard as it was. Windows checks and writes with the clipboard open, which no other writer can
  take. A clipboard the Mac fails to read (no items, which macOS gives for an error, not an empty
  list) is not saved, so never put back as empty. After a put-back
  the Mac and Windows read the clipboard again at the next dictation (the change count read after a
  put-back may already be a newer copy's, which an old save must never be taken for); Ubuntu keeps
  the offer it put back while the session still owns it.
- **Tests.** Mac `ClipboardKeeperTests` (every type put back; an empty clipboard; the paste never
  waits for a save held on a late provider; a copy after the paste, or between the save and the
  paste, kept; a save the clipboard changed during dropped; two pastes; one read for an unchanged
  clipboard, and again once put back; one read at a time; every item put back in order; a slow
  paste still reading the text; a concealed clipboard never read; one that fails to read, or an item
  whose owner gives no data, never put back; a copy made as the paste is written kept; an app
  reading the clipboard after the keys gets the text; the limits, rejected over and kept at them), `MacServiceRequestTests` (the registered `clipboardSave` and `insert` share one
  keeper: saved, pasted, put back), the app's `clipboardSave.test.ts` (a save that times out, exits
  or is refused holds up no paste and rejects nowhere); Windows `paste.mjs` (put back with every
  format, a copy after the paste, a save older than the clipboard, a password manager's copy, a late
  owner saved in the background and put back, and the paste itself still never asking a late owner)
  and `clipboard-keeper.cpp` (a copy made as the paste closes the clipboard kept; one made as a save
  lets it go saved at the release, or the text left);
  Ubuntu `input-session.cpp` (the same over the fake portal, plus a read held when the paste comes,
  file transfers, too many formats and the unannounced selection).

**Amendment (owner, 2026-10-09) — the newest copy goes back.** Owner: *"if anything happened in
between we just [keep] the new thing"*, choosing to keep the newest copy over the clipboard as it was
at the release. The app no longer asks for a save only at key-down and at the release: it asks at
key-down and then every `clipboardSaveInterval` (250 ms) through the hold and the transcription,
until the paste writes (`DictationController.saveClipboardUntilThePaste`; it stops right before the
paste, where a save would be of the paste's own text, and when the dictation ends any other way). The
helpers already skip a clipboard unchanged since its save, so an unchanged clipboard costs a change
count or sequence number compare, and nothing changes in them. What goes back after the paste is the
copy the user made last, one made while the words are transcribed too. Residuals, amended: (c) a
copy made within one interval of the paste, or still being read when the paste comes, is lost to
the paste, and the text stays; (f) a copy made while an earlier save is still reading is saved by the
next ask after that read ends. (a), (b), (d), (e) and (g) stand: the clipboard holds one thing on
every platform, so taking the paste's text off it means writing the saved clipboard back, and the Mac
and Ubuntu have no conditional write for that. The owner accepted these residuals the same day, tracked as P5 issues:
(a) #194, (b) #195, (c) and (f) #196, (d) #197, (e) #198, (g) #199; and three edges the reviews
found: a Windows save whose thread can't start stops put-backs until the helper restarts (#200), an
Ubuntu copy announced as the paste offers its text brings back the older clipboard (#201), and
Windows bitmap, palette and metafile handles go uncounted toward `maxBytes` (#202).
- **Tests.** `controller.test.ts` › the clipboard is saved from key-down until the paste writes
  (asked every interval through the hold and the transcription, never while the paste is out or after
  it), and a dictation canceled or ended with its note stops saving; Mac `ClipboardKeeperTests` ›
  `putsTheNewestSavedClipboardBack` (a copy saved by a later ask goes back, every type of it).

**Amendment (owner, 2026-10-20) — the clipboard goes back only after the target reads the paste.**
Owner: under high load, *"something in the clipboard is being directly pasted instead of what I
dictated."* The cause: the put-back ran a fixed `restoreDelay` (500 ms) after the paste keys, with no
sign the target had read the clipboard yet. A busy target handles the keys late, reads the clipboard
after the put-back, and pastes what the user had copied before. Reproduced on the Mac with a target
reading 700 ms after the keys (`aBusyAppReadingAfterTheDelayGetsThePastesText`, red before this
change). Asked whether to stop going through the clipboard at all, the owner chose to keep the paste
and fix the put-back.
- **The text is offered, not written, and its read is seen.** Each helper hands the paste's text over
  only when an app asks for it, and so knows when the target has read it: on the Mac an
  `NSPasteboardItemDataProvider` (`OfferedText`; macOS asks on the main thread for another app's
  read); on Ubuntu the portal's `SelectionTransfer` for the session's offer (as before; the keeper now
  counts one, but only one asked for after the compositor answers the paste's first key, and only
  once its bytes were written: GNOME's clipboard manager and its X bridge read every new selection
  as it is set, before any key, the target reads only once it has the keys, and a failed transfer
  gave the app nothing); on Windows delayed rendering (`SetClipboardData(CF_UNICODETEXT, NULL)`, then
  `WM_RENDERFORMAT` to a message-only owner window on a thread of the keeper's own). Markers and
  privacy formats are written as before.
- **Put back `restoreDelay` after the read, or after `readWait`.** The put-back waits for the first
  read of the paste's text, at most `readWait` (the shared core's, 10 s, now in the
  `{"clipboard": {}}` reply) from the paste keys, then `restoreDelay` as before, then the same checks
  (the clipboard still holds the paste's text, the save is of the clipboard as it was). 10 s covers a
  target stalled by the load that caused this, and still returns the user's clipboard soon when the
  keys went nowhere. A paste refused before its keys (a modifier held, focus moved, a failed
  `SendInput`) goes back after `restoreDelay` alone on Windows and Ubuntu, with no read to wait for. A later paste replaces
  the earlier one's text, and its own put-back is the one that waits: each put-back is bound to its
  own paste as it is scheduled (on Windows the number `offer` gives it), so an earlier paste's
  put-back that runs late never waits for, nor puts the clipboard back over, a later one's text.
- **The helper's exit.** The Mac and Windows write a still-unread text in full as the helper ends (the
  Mac at the end of the helper's input, `HelperChannel.onEnd`; Windows by `WM_RENDERALLFORMATS` as the
  owner window closes), so the clipboard keeps the text, not nothing. Ubuntu is unchanged: the portal
  serves the text only from the session.
- **Residuals (accepted by the owner, 2026-10-20).** On the Mac and Windows the text is handed over once (the system keeps it after), so
  a clipboard manager or Universal Clipboard that reads every new clipboard and ignores
  the transient and concealed markers counts as the read, so the put-back falls back to today's timing
  after that read. A target slower than `readWait` still gets the clipboard as it was. On the Mac
  another app's read needs the helper's main thread free; it is, except while a Calendar or Contacts
  request runs, which ends before its paste. A helper killed (not ended) with the text unread leaves
  an empty clipboard on the Mac and Windows, where it would have held the text; tracked in
  issue #241.
- **Tests.** Mac `ClipboardKeeperTests` › `aBusyAppReadingAfterTheDelayGetsThePastesText`,
  `putsTheClipboardBackWhenNoAppReadsThePaste`, `handsOverAnUnreadPasteAsTheHelperEnds`,
  `keepsANewerCopyAsTheHelperEnds`, `aPasteOvertakenAsItsKeysGoLeavesTheNewerPastesWait`,
  `aWaitStartedAfterTheOfferEndedReturnsAtOnce`, `anAppReadingNearTheEndOfTheWaitGetsThePastesText` (the stub
  paste keystroke now reads the clipboard, as a target does), `MacServiceRequestTests` › `anUnreadPasteIsKeptAsTheHelperEnds` (the helper's closed input wired
  to the hand-over, with the wait for a read still on and run out), `HelperChannelTests` ›
  `closedInputRunsTheEndHandlersInOrderBeforeExiting`; Windows `clipboard-keeper.cpp` (a late
  reader gets the text, an unread paste goes back after `readWait`, a refused paste at once, a refused
  paste's put-back run after a newer paste leaves that paste, an unread text kept as the keeper ends); Ubuntu `input-session.cpp` (a read 250 ms after the keys gets the
  text, an unread paste goes back after `readWait`, both with the fake portal reading the offer as it
  is set, as GNOME does; a paste refused before its keys goes back without waiting; a failed transfer after the keys leaves
  the text for a later read; checked on GNOME, where those reads come before any key); the shared `request-cases.json` (`readWait`).

