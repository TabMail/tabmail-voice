## ADR-DESK-043: The paste history, on a triple tap

**Context:** Owner, 2026-09-30: "triple tap to see past history of the pastes, so that you can
actually just click on one of those to copy", and "when dictation is going on … show the press space
to enter agent mode or triple tap to see history tooltip".

**Decision:**
- `PasteHistory` (`src/core/dictation/pasteHistory.ts`) keeps every text dictation and agent mode pasted, or
  copied instead (ADR-DESK-042), the newest first, at most `pasteHistoryLimit` (20); the same text
  again moves to the top. **In memory only**, for the app's life: no user content is written to disk
  (root ADR-004).
- Gesture (`PushToTalkGesture`): a press while hands-free that comes within `doubleTapWindow` of the
  double tap's second release is `showHistory`, not `finish`. The hands-free dictation the double tap
  started has heard a moment at most; it is discarded unseen.
- The history window (`history/index.html`) opens where the chat window's answer box does (amended, owner,
  2026-09-30: "paste history should appear like the answer tool, not near cursor";
  `historyWindowFrame`): `chatPillGap` over the pill of the hold that asked for it and its bubbles,
  or under them where there is more room (`chatSide`, with the history's tallest), centered on the
  pill and kept on screen, the edge by the pill staying put as the list measures itself. The pill's
  place (`OverlayWindowController.pillPlace`: at the caret, or the pointer without one) is read before
  the hands-free dictation is discarded, which forgets it. (It first opened by the mouse pointer,
  `historyWindowOrigin`, now gone.) It is `pasteHistoryWindowWidth` wide (the chat's width) and as
  tall as its list up to `pasteHistoryMaxHeight`; it opens hidden and shows, focused, once the list
  has measured itself (`Windows.fitHistory`; owner, 2026-09-30: "a brief flash where the pill renders
  at full height and shrinks"), a reopening keeping the last measured height. Each entry is clipped to `pasteHistoryEntryLines`
  lines with how long ago it came. It takes focus; a click copies the whole entry to the clipboard and
  closes it; Escape or a click elsewhere closes it. On macOS the app then hides, so focus returns to
  the app the user was in, unless Settings, the welcome window, the context debug window or the chat
  window is open (hiding the app would hide the chat, with nothing to show it again while the next
  holds talk to it).
- The Space tip becomes `agentAndHistoryTip` ("Press [space] for agent mode, / triple-tap [hotkey]
  for history", 4 s, at most 10 holds); opening the history learns it. Using Space no longer does,
  as the tip still teaches the history. Its new id restarts its counts.

**Consequences:**
- The history is lost when the app quits.
- A triple tap works only from hands-free listening: while the previous dictation is still
  transcribing, the double tap finds nothing listening and the gesture ends, so a third press starts
  a new hold. With the history open, a paste still to come sees this app in front and is copied.

