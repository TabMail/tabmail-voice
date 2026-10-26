## ADR-DESK-016: Lay the screen read out as the screen shows it

**Context:** Owner, 2026-09-26: a Compose reply in a Slack DM swapped who said what; it thanked the
other person for help the user was giving. The read (ADR-DESK-007) had the whole conversation but
no authors: Slack's authors are buttons, and the walk skipped every button. Each piece of text was
also its own line, so an author, the time and the message were three unrelated lines. The owner's
direction: rather than patch one app, reconstruct how the screen looks and pass that on.

**Decision:** The walk keeps each piece of text's frame, and the visible text is laid out from the
frames: text and links side by side on one line are joined (`Alex [Today at 9:20:09 AM]`), anything
else starts a line, and a jump back up the window (the next pane) leaves a blank line. In web
content, controls and toolbars are read: a control adds its title when it has no description
(Chromium and WebKit title a control with the text drawn in it; a screen-reader label comes as the
description, and one Electron app reported it as the title too), else its children's text. Native apps title their
icon buttons ("Back", "Copy"), so outside web content controls and toolbars stay skipped. Text in a
box at most a point thin is left out: web apps keep screen-reader-only labels, list items scrolled
out of view (clipped to 1 point at the list's edge) and hover-only actions in such boxes. The box
is still walked into, since Slack keeps its whole message list inside a 1×2 screen-reader-only list.

**Consequences:**
- Measured 2026-09-26 with the reader compiled into a command-line tool against the running apps:
  Slack reads every message with its author and time and the thread as its own block; a chat panel in Chrome,
  an Electron chat app and Safari drop icon labels and scrolled-out history; Messages and Reminders
  read as before.
- Conversation scrolled out of view is no longer read (a chat side panel in Chrome: 5.9k → 1.3k chars).
  It was hidden, and read only because the web app kept it in the tree; the read is what is on
  screen.
- Messages grouped under one author header (Slack's follow-ups) carry no author of their own, as on
  screen; the model reads them as the author's above.
- Screen-reader-only text inside a normal-sized box under a 1-point one still comes through (Slack's
  "Canvas List Folder"); pruning 1-point boxes would drop Slack's message list.
- The walk reads elements through `ScreenTree` (`LiveScreenTree` in the app), so tests run it on a
  fake tree shaped like Slack's (`ScreenContextTests`), and once on a real window of the test host
  (`LiveScreenTreeTests`, which needs the Accessibility permission), beside the layout on frames measured in
  Slack and the hidden-box rule on frames measured in Slack and Chrome. Test text is placeholders,
  never what was on the measured screen.

**Amendment 2026-10-01: a row's text views are part of its text.** Owner: in a native chat app
agent mode "didn't seem to get enough context" of the discussion on screen. The read held each
message's time and sender and no message: the app puts a message in a text area (`AXTextArea`) in
its table row, and a row's text was gathered from static text and text fields only
(`ScreenContextReader.subtreeText`), though the walk reads a text area anywhere else. A row,
heading or link now takes a text area's value like a field's, shown ones only, within the same
`contextMaxBlockChars`. A password field is still never read (`walkNeverReadsAPasswordField`).

**Amendment 2026-10-01: a field that frames an excluded page is marked hidden, and the rest is
read.** A field (text area or text field) is read by its value and never walked into, in the window
and in a row alike, so a page of an excluded website framed inside one was not seen: the window was
read without it and nothing said so. Owner: "There should be a marker. We still need to read the
rest and just have this marker that some area is hidden."
- The reader looks inside a shown field for an excluded page (`holdsExcludedPage`) before reading
  it. A field that holds one is not read: `HelperConfig.contextHiddenMarker` ("[hidden for
  privacy]") stands in its place, as the field's block in the window or its cell in a row, and the
  walk goes on.
- First built, the same day, as a refusal of the whole window (the screen answered as hidden, as
  the Windows helper does for an edit control); the owner chose the marker instead. Everywhere
  else an excluded page still hides the whole window (ADR-DESK-047): a page the window shows
  brings its title and tabs with it, which a field's contents do not.
- The Windows helper still refuses the whole window in this case: the stricter of the two, not
  changed here because it could not be built or run on this machine.
- **A field that could not be looked through whole is marked hidden too.** The look stops at the
  walk's element budget (its own count) and at the read's time budget. A field it gave up on might
  hold an excluded page it did not reach, so the field is not read and the marker stands in. This
  is the opposite of the look's answer for the focused element (ADR-DESK-047, "kept as it is"):
  there, giving up closed would drop every large window; here it costs one field.
- No app is known to frame a page in a field. The cost: most fields have no children, but a
  rich-text editor on a web page that is not in focus has its whole subtree looked through (roles
  and page addresses, never text) before its value is read. One with more elements than the budget
  is shown as hidden though it holds no page, and a slow one can use up the read's time, so the
  rest of the window after it goes unread: context lost, never the field's text.


**Amendment 2026-10-25: two reads, what the window shows and the whole window (owner).** Owner:
"that decision not reading thing was the wrong decision ... we should read the whole thing ...
everything that the accessibility tree gives and screen readers are able to read ... for both agent
mode and dictation." Referring to a page or a conversation means its whole text, not the part
scrolled into view. Then, the same day, on cost: "for dictation, first create keywords from shown
screen content and add more from off screen if needed. Now, for off screen reading, for the agent,
this should then be a tool, so that it's used only when agent thinks it needs more context about
what the user is talking about, eg, can you summarize, or can you write a comment about this
considering others. Otherwise we'd waste a lot of tokens?", and "for off screen keywords, i meant if
there is room".
- **Two scopes.** A `readScreen` request takes what the window shows (the rule above, unchanged), or
  with `wholeWindow: true` the whole window, as a screen reader reads it. The shared core validates
  the flag (`request.rs`, absent = false) and the walk decides by it (`walk.rs`, the node's
  `wholeWindow` fact): reading the whole window, an element outside the window and text in a box at
  most a point thin are read (Chromium squashes what is scrolled out of view into such a strip at the
  window's edge, and keeps screen-reader-only labels and hover-only actions in such boxes).
- **Layout of the whole window.** A thin box says nothing of where its text is, so the core marks it
  `unplaced` and the helpers lay it out with no frame: it starts a line of its own, never joined to a
  neighbour as if side by side. Text that is on screen is laid out as before.
- **What each OS calls hidden.** A new `offscreen` fact carries what the OS says is scrolled out of
  view: Windows `IsOffscreen`, Linux not `SHOWING`. It hides an element only when reading what the
  window shows; reading the whole window it does not, and only `hidden` (Windows: no `IsOffscreen`
  any more; Linux: not `VISIBLE`, meant to be seen) skips, after its look. The Mac has no such fact
  and keeps geometry, as before. Password fields, interface chrome outside web content, excluded apps
  and websites and secret-looking text stay out in both scopes. Terminals keep the on-screen rule
  (`shown`): their surface is what the terminal shows.
- **Who reads which.** The app reads what the window shows at key-down, then, once that has answered,
  the whole window (`ScreenContextProbe.window`), numbered after it so a stop of the first never
  reaches it.
- **The same window, or none.** The whole window is read after the first read has answered, so the
  user may have brought another window to the front meanwhile, and every helper reads the window in
  front. The request carries the first read's number (`sameWindowAs`, only with `wholeWindow`, the
  core validates it), and the helper reads only that read's window, while it is still the one in
  front and that read was its last: otherwise it answers null, the whole window not read, as when no
  app is in front. Each helper keeps its last numbered read's window by the OS's name for it (macOS:
  the app's process and focused `AXUIElement`, compared with `CFEqual`; Windows: the `HWND`; Linux:
  `Foreground`'s window token; `walk::LastReadWindow` in C++). Another app in front is refused
  before anything of it is looked at. A helper restarted between the reads keeps nothing, so the
  whole window is not read.
- **Fields by scope.** Reading what the window shows, a field is read whole only when it is short
  (at most 20,000 characters within a 256 KiB source window), as before; a longer one is read by
  the part it shows, so no text scrolled out of view enters what the window shows. Reading the whole
  window, a field the screen's budget holds is read whole. The core decides both (`fieldPlan` with
  the read's `wholeWindow`, which also gives the bound of the whole-field probe, `wholeBytes`).
  On Windows a classic edit control has no text pattern, so the walk reads it by its value (as the
  caret read always did), whole when `fieldPlan` allows and not at all otherwise, since it gives no
  part it shows. Before, the walk read nothing of one, in focus or not; the Windows VM pass found
  the gap when the focused field came to be read like any field (2026-10-26).
  On the Mac a field's whole text is what its provider gives: AppKit gives a text view's whole
  text, so its two scopes differ; Chromium caps a text field's character count and value at 10,000
  characters (measured 2026-10-26: 10,000 of a 23,045-character textarea), so reading the whole
  window can't take more of one than what the window shows. An unfocused long AppKit text view is
  left out of what the window shows, as before the two scopes (#266).
- **The field in focus.** Reading what the window shows, the focused field is the caret block: the
  text around the caret, at most 2,000 characters a side, as before. Reading the whole window, it is
  read whole like any field (an editable page walked like any page), just after the caret block,
  which then only marks it: none of the caret's text is sent apart from the field, the selection
  included. A selection kept apart from the text around it loses what a redactor needs to know it
  (`token=` before a selected value), while in the field it is redacted in place; the request's
  selection (Edit) comes from what the window shows. The core decides both (`walk::node` with the
  scope; `around` says what is kept of the caret's text). A focused password field is only the
  caret block in both. (Review, 2026-10-26: round 4 found the whole window still read the focused
  field by its caret, losing a long document past 2,000 characters; round 5 found the first fix's
  selection-only caret block sent a selected secret unredacted.) The same gap in what the window
  shows for a selection in a focused page (not a field) predates this and is tabmail-voice #263.
- **What each takes.** Dictation takes the terms of what the window shows first, then the whole window's in
  the room left in the vocabulary, only if that read is done by the upload: it is never waited for
  (ADR-DESK-038). Agent mode's request carries what the window shows (`screen_text`); the model reads
  the whole window only by calling `screen_read` (ADR-DESK-061's local-tool pattern, below), so a
  long page costs its tokens only when the request needs it.
- **Budgets.** Counts only, set for a desktop reading in memory: the walk's node budget 5,000 →
  100,000 (the look for an excluded page uses the same count), and the read's text budget
  (`SCREEN_BYTES`) 256 KiB → 1 MiB, with the block and selection snapshots sized from it. A
  heading, link or row has no budget of its own any more (it was 20,000 characters or 256 KiB): it
  is read, like the rest of the window, until the screen's budget fills, and one piece of it (a
  text, or a field read whole, up to the screen's budget reading the whole window) is taken whole however large. Nor is there
  a count of blocks: 5,000 short pieces no longer refuse the read. No time limit returns
  (ADR-DESK-053, 2026-10-06); a read still going when the app stops waiting answers with what it
  has read so far (ADR-DESK-053, 2026-10-25).
- **Consequences.** A second read runs after every screen read, in its own helper process, while the
  user speaks; one still going when the next dictation starts is ended with the reader. The agent's
  prompt stays the size of what is shown; `screen_read` adds a round when the model wants the rest.
  Tests that sized a tree one element past the budget size it from the core's limits, so they follow
  the rule rather than a copy of the number.


**Amendment 2026-10-26: reads follow the captured target, including in the background.** The
`readScreen` request may carry `target`, the exact window captured at key-down (ADR-DESK-042).
Both scopes read that window even after another window takes focus; `sameWindowAs` still binds the
whole read to the preceding numbered read. A missing or invalid target is not replaced with the
window now in front. Exclusions and redaction are applied to the target before text is returned.
A caret/selection is included only when it belongs to that exact window: another window of the
same process cannot contribute it. Windows and Linux may return no caret for a background target.
Legacy unaddressed diagnostic reads retain their foreground behavior.
