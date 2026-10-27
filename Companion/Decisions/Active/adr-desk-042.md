## ADR-DESK-042: The text goes where the caret was at key-down, or onto the clipboard

> **Amended (owner, 2026-10-08): nothing goes on the clipboard by itself; the note offers to copy.**
> With the paste putting the clipboard back (ADR-DESK-002, same date), a switched app no longer
> writes the text to the clipboard either. The note at the mouse pointer says "Switched apps. Click
> to copy." (a dictation whose end was lost: "Couldn't transcribe the end. Click to copy the rest.")
> for `notPastedDisplayDuration` (10 s), with a bar running down the time, and takes clicks (pointer
> mode on the Mac and Windows, the whole overlay on Linux: ADR-DESK-036's 2026-10-10 amendment). A click copies the text (IPC
> `copyNotPasted`) and shows "Copied to clipboard" once the clipboard has taken it, or "Couldn't
> copy. It's in the paste history." when it refused it; the note expiring, or the next hold, drops
> the text, and wins over a click's write still under way. It still goes into the paste history
> (ADR-DESK-043) either way.
>
> **Amended (owner, 2026-10-09): copied, the note goes; its x dismisses it.** Owner: the note should
> *"disappear immediately when copied, or should be dismissable by clicking on the x"*. A click whose
> write succeeds ends the note at once (no "Copied to clipboard" message; the `copied` phase is gone);
> a refused write still says "Couldn't copy. It's in the paste history.". An x at the note's end
> (IPC `dismissNotPasted`) ends it at once, copying nothing; the text stays in the paste history.
>
> **Amended (owner, 2026-10-09, same day): the note shows the text it copies.** Owner: the note
> *"should actually show what was dictated there"*, with *"a typical copy icon properly located"*,
> so that *"you can click on that word or the box or that icon to copy"*. The note is a card
> (`noteWidth`): its message by the clipboard and its x on top, and under them a box with the text,
> in the chat window's colors for the user's words, cut short after `noteTextMaxLines` lines, with a
> copy sign at its first line's end; the box and the sign turn the brand's blue under the pointer. A
> click anywhere on the card but the x copies, as before. The `notPasted` phase carries the text
> (`text`), which the click copies, in place of the controller's own copy of it: what is shown is
> what is copied. The text reaches the overlay's page, as the chat window's replies do; it is never
> logged. Taller than the pill, the card is never taller than `noteMaxHeight` (its message cut after
> `noteMessageMaxLines`), and placed at the pointer it keeps that much of the work area under the
> pill's top (`overlayOrigin`'s `roomBelow`), so near the bottom of a display it shows whole.

> **Amended (owner, 2026-10-09, later the same day): the note's look.** From two pages of candidates
> the owner chose a minimal card (*"no gradients … no too much apparent icons, no splitting regions
> that are non-subtle, and no horizontal lines that go completely through"*), rounder, on the glass
> every floating surface now shares (ADR-DESK-048's 2026-10-09 amendment): the message as a small gray
> caption with a faint clipboard and x, the text itself under it at `noteTextFontSize`, no box, and a
> blue "Copy" with its sign at the card's right, which takes a wash of the accent under the pointer.
> Its countdown is a faint inset hairline. A click anywhere but the x copies, as before;
> `noteMaxHeight` is 140 for the caption's second line.

> **Amended (owner, 2026-09-30, same day): only the app is checked.** Tested on a dev build in
> iTerm2, every dictation was copied as "Cursor moved" though nothing had moved: iTerm2's caret is a
> position in its whole scrollback, which drifts with every line of output (a TUI's spinner), and it
> accepts a selection set but ignores it, the cursor being the program's. Owner: "just checking if
> focused app changed should be what we do since that one is robust but not others", with "a 'check
> if focus changed' function" wired in. So:
> - The controller keeps the app in front at key-down (`targetApp`, as before this ADR) and, before
>   each paste, dictation's and agent mode's Edit and Compose alike, asks `focusChanged`: the app in
>   front now against it (a read that fails counts as none). Changed: nothing is pasted; the text goes
>   on the clipboard and into the paste history, and the `copied` note ("Switched apps: copied to
>   clipboard and history") shows at the mouse pointer. Unchanged: the paste of ADR-DESK-002, into
>   whatever has focus in that app.
> - Canceled while the app in front is read: the text goes nowhere, not even the history.
> - Gone: `captureTarget`, `InsertionTarget`/`InsertionTargets`, the settle poll and its
>   `HelperConfig` values, the `insert` outcome and `session`, and the `caretMoved` outcome with its
>   "Cursor moved" note. `insert` is as before this ADR.
> - Consequences: a caret moved within the same app is not put back (the ADR-DESK-002 behavior);
>   a helper restart after key-down no longer copies the text once the restarted helper is up (it reads
>   the app in front as well); a read that fails while it restarts copies it. The decision below is kept as the record of what was tried.

**Context:** Owner, 2026-09-30: "if I move my cursor or caret while the dictation is still trying to
go on, I paste it in the wrong place … paste … where the dictation button was pressed". The paste
(ADR-DESK-002) went to whatever had focus when the text arrived. Asked, the owner chose, both for an
app switched in the meantime and for a caret that can't be put back: "Don't paste, keep text". Then:
"if the app focus changed, we can just briefly show at the mouse cursor location that we've just
copied it into your history and also your clipboard" (the history is ADR-DESK-043).

**Decision:**
- At key-down the controller asks `voice-macos` to keep the insertion target (`captureTarget
  {session}`, the dictation's generation): the app in front, its focused element
  (`kAXFocusedUIElementAttribute`) and that element's selection, as a text-marker range
  (`AXSelectedTextMarkerRange`, WebKit and Chromium) where it has one, else a character range
  (`kAXSelectedTextRangeAttribute`). One target is kept, the latest dictation's; each AX call times
  out after `HelperConfig.insertionTargetTimeout` (0.25 s).
- `insert {text, restoreDelay, session}` first puts the target back (`InsertionTarget.restore`):
  another app in front → `appChanged`; focus in another element → focus it back, and `caretMoved` if
  it won't take it; a caret moved → select the kept range again, and `caretMoved` if the field won't
  take it. A set gets `insertionTargetSettleTime` (0.2 s) to show, checked every
  `insertionTargetPollInterval`: Chromium hands focus and selection sets to its renderer and answers
  reads from its cached tree until the renderer replies. Only then the paste of ADR-DESK-002; the reply is `{outcome: "pasted" | "appChanged" |
  "caretMoved"}`. Nothing is ever brought to the front: an app switch is the user's. Captures run
  concurrently, so an older session's finishing late never replaces a newer one's; an `insert` whose
  session has no target (a capture that failed, a helper restarted since key-down) pastes nothing.
- Two marker ranges are the same when `CFEqual`, or when both have the same non-empty bounds
  (`AXBoundsForTextMarkerRange`, taller than zero): an app may describe one place with different
  marker objects.
- Not pasted: the text goes on the clipboard (Electron's `clipboard.writeText`, left there, not
  restored) and into the paste history, and the dictation ends in a `copied` phase whose message
  ("Switched apps: copied to clipboard and history", "Cursor moved: …") shows at the mouse pointer,
  where the user now is, not at the old caret, for `overlayErrorDisplayDuration`. Like `failed`, the
  next hold replaces it.
- Agent mode's Edit and Compose paste the same way; the target app check they had
  (`isTargetAppFrontmost`, the "You switched apps, so nothing was pasted" failure of ADR-DESK-011's
  amendment) is gone, the helper's check replacing it. The Thunderbird tool is unchanged.

**Consequences:**
- An app that shows no focused element at key-down (thin accessibility trees, some games and
  terminals) is checked by app only: the text pastes where focus is then, in that app.
- A field without a readable selection gets its focus back, not its caret.
- A caret the user moved on purpose within the same field goes back to where it was at key-down.
- A dictation whose `voice-macos` restarted after key-down (ADR-DESK-032's amendment: "what was said
  is then pasted through the restarted helper") is copied instead, with the "Cursor moved" note: the
  restarted helper has no target for it.
- The clipboard keeps the text after an unpasted dictation: the user's earlier clipboard is replaced,
  which is what "copied to your clipboard" means.



**Amendment 2026-10-26 (owner): restore the captured window before pasting.** At each key-down,
Voice captures the exact window in front; when Voice itself is in front, it captures the external
window that had focus immediately before Voice. Both plain dictation and agent Edit/Compose use
that target. Each new key-down over another external window chooses that window for that operation.
Reads use the same captured identity, including the subsequent whole-window read. A paste brings
that exact living window back to the front, verifies it, then pastes into whatever field currently
has focus within it. It does not restore a field's earlier caret or selection. A focus switch alone
no longer produces the not-pasted note. A gone window, lost identity, refused activation or failed
native final check still produces the existing note and preserves the text in paste history. There
is no alternative-window, title, geometry or process-only substitution. Native cancellation,
deadlines and clipboard ownership checks remain in force. Implementation: `TargetWindows` in the
main process; each platform's capture and activation adapters. macOS's ownership split is recorded
in ADR-DESK-053's amendment of the same date.


**Amendment 2026-10-26 (owner): offer copy when the field can no longer receive the paste.**
The macOS reader retains the focused AX element with the captured window, including the external
window remembered before Voice. After restoring that window, it compares the current focused
element with the retained one. A missing or different element refuses the paste through the existing
not-pasted card, now captioned "Couldn't paste. Click to copy." No text, caret offset or selection is
compared or restored, so typing in the same element does not itself refuse a paste. Apps exposing
no focused element at capture retain the existing window-only paste behavior of ADR-DESK-002.
The same card still handles a lost window or refused activation, for dictation and agent Edit/Compose.
Blocking window lookups finish before the field comparison. A final foreground-app observation,
then deadline, clipboard and cancellation checks, follow it immediately before key-down; a slow AX
reply must not authorize the older paste through a newer foreground choice.
Logical field tracking through replacement elements, and equivalent field guards on Windows/Linux,
are tracked in [#276](https://github.com/TabMail/tabmail-voice/issues/276) (P4).
