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

