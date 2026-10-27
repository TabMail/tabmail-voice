## ADR-DESK-007: Screen context from the Accessibility tree, not screen pixels (phase 2 prototype)

**Context:** Phase 2 gives dictation the context on screen. Measured on one Mac (2026-09-25): the
Accessibility tree of the focused window gives structured, visible text in Chrome, Safari,
Firefox, Slack, Notion, Cursor, Codex, Calendar, Messages and Thunderbird in 0.2–1.5 s; Vision
OCR of a 5K screen takes 0.8 s (fast) to 5 s (accurate), yields flat lines with no structure,
and needs the Screen Recording permission.

**Decision:** Read the Accessibility tree we already hold the permission for. At key-down the
frontmost app's focused window is walked in child order (reading order) within a node and time
budget, skipping interface chrome (buttons, menus, toolbars, images) and anything outside the
window. Headings, links and table rows become one block each. The focused field becomes a caret
block at its place in that order, its text marked at the caret; its ancestors are never
collapsed or pruned so the walk reaches it. The page host comes from the nearest web area above
the caret. Web editors report the caret as a text-marker range, so markers are read first, then
the field's value and selected range. Terminals under tmux are read from tmux (`capture-pane` of
the most recently active client's pane, cursor from tmux, foreground process of its tty); the
terminal's own text is every pane side by side and iTerm2's caret index drifts.

**Consequences:**
- Prototype only: wired in Debug builds; the latest capture is kept in memory and shown in a
  debug window. Logs carry sizes and timings, never text. Nothing is stored or sent.
  ⛔ Superseded by ADR-DESK-008 (2026-09-25): captured in every build and sent with the transcript
  for the cleanup. Still never logged or stored. *(Amended by ADR-DESK-015, 2026-09-26: debug builds
  log it in full to the local debug log file.)*
- A plain terminal tab without tmux gets its visible lines but no caret mark or program.
- The tmux pane is the most recently active client's, and is used only when most of its last
  lines appear in the front terminal's text; a tmux attached in another tab or window is ignored.
- OCR stays a possible later fallback for apps whose tree is thin, as an owner decision.
- *(Amended by ADR-DESK-016, 2026-10-25: a second read takes the whole window, on screen or not,
  within count budgets only; the first still takes what the window shows.)*
- *(Amended by ADR-DESK-016, 2026-09-26: the visible text is laid out in lines from the elements'
  frames, web controls and toolbars are read, and text in point-thin boxes is left out.)*
- *(Amended 2026-09-30, owner: a password field (`kAXSecureTextFieldSubrole`) is never read, focused
  or not, nor anything inside it, as correction learning already does (ADR-DESK-038). The read no
  longer relies on the app hiding the field's value; the focused one still gets its caret block,
  empty. A password an app shows in an ordinary field or as text is still read: excluding apps is
  issue #5.)*
- *(Amended 2026-10-01: the refusal comes before anything is asked of the field. A focused password
  field is given neither to the terminal's pane reader nor to the caret read, and the field read for
  correction learning asks for its subrole before its value and never asks a password field for
  one.)*
- *(Amended 2026-10-01, owner: a page that has the focus itself is read like any page. With a page
  clicked on, rather than a field in it, the focused element is the web area; the walk treated it as
  the field the caret is in and never went into it, so Safari and Chrome, which give no text around
  a caret there, gave an empty screen (one caret block, one character), and Firefox gave only the
  2,000 characters after the page's start. The walk now goes into a focused page (`walk`), its
  password fields and framed excluded pages refused as anywhere. The text around the page's caret is
  dropped (`gather`): it is the page's own text. What is selected in the page is kept, for agent
  mode's Edit and as the caret block before the page's text. A focused web area that can be edited
  (its value is settable: a mail's compose window, an editor whose whole document is editable) is
  not such a page: it stays the field the caret is in, read by its caret and not walked into, as
  before (`isPageInFocus`, since renamed `isFieldInFocus`). The Windows helper applies the same rule: it walks a focused document
  that is no editable field.)*
- *(Amended 2026-10-01, owner: the Windows helper reads as the Mac one does, "unless impossible".
  The two were read side by side and the Windows helper changed where they differed:*
  - *A focused page that can't be edited keeps its selection (`selectedInPage`), marked as the
    caret block before the page's text. It is asked for only when something is selected, after
    what encloses the selection was looked through for a password field and an excluded page.*
  - *The page's host, without a page the focus is in, is the first page the walk reaches.*
  - *A field read through IAccessible2 (Firefox, Chromium) that can't be shown safe gives no caret
    text and the window is still read; it used to end the whole read with nothing.*
  - *A window with no focused element in it (none, or the focus in another of the app's windows)
    is read without a caret; it used to be no read at all.*
  - *A terminal (`HelperConfig::terminalApps`) has its focused pane read as a field of the lines in
    view, with the text around its caret in the reply and no caret block, as the Mac does without
    tmux. The tmux pane read itself is not on Windows: tmux runs there only inside WSL.*
  - *A table row, and a row of an app's own list, is one block of its cells joined by " | "; a
    heading or link that gives no name is the text under it as one block (`subtreeText`).*
  - *A field is read whole up to `contextMaxFieldChars`, and only a longer one by the lines in
    view; a piece of text is no longer cut at 1,000 characters.*
  - *The walk stops at 5,000 elements visited or 1.5 s, as on the Mac: elements waiting to be
    visited no longer count against it (a wide tree stopped early), and there is no depth stop.*
  - *NordPass is in the Windows built-in excluded apps, as in the Mac list.*

  *Three differences stay, on purpose:*
  - *A box that shows nothing is not walked into on Windows. The Mac walks in because Slack keeps
    its message list in such a box (ADR-DESK-016), and can, because a Mac element's frame is what
    is left of it after clipping. Chromium on Windows reports frames unclipped
    (`AXPlatformNodeWin::get_BoundingRectangle`), so the text of a screen-reader-only label looks
    full-sized there and walking in would read text that is not on screen. (Settled 2026-10-05 in
    ADR-DESK-054: Windows walks in too, by the owner's choice made knowing this.)*
  - *A focused element that is neither a field nor a page (a list, a button) is read like any
    other on Windows; the Mac puts an empty caret block in its place and reads nothing under it.
    Matching the Mac would make Windows read less: left for the owner. (Settled the same day, in
    the next amendment: the Mac changed.)*
  - *The Windows helper refuses a window for an excluded page it finds before checking that the
    page is inside the window, and looks through a link, row or control for one before reading
    its name. The Mac skips an element outside the window first. Windows is the stricter; matching
    the Mac would loosen it: left for the owner. (Settled the same day, in ADR-DESK-047's
    amendments: the Mac looks through such an element too, and Windows is to skip a page outside
    the window as the Mac does.)*

  *The Windows changes were written and reviewed by reading: they were not built or run when made.)*
- *(Amended 2026-10-01, owner: where the two helpers differ, the read is to be the larger of the
  two, so the Mac helper now reads a focused element that is no field as Windows does. With a list,
  a row or a group in focus (a mail list, a chat's message list), the Mac put an empty caret block
  in its place and read nothing under it. The walk now reads it like any element (`walk`): its
  rows, text and fields at their place, its password fields and framed excluded pages refused as
  anywhere, a button skipped outside web content as any button is. The rule for a page in focus is
  this rule: the text around the caret is dropped, since it is the element's own, and what is
  selected is kept as the caret block before it. The field the caret is in (`isFieldInFocus`) is a
  text field, text area or combo box (`contextFieldRoles`), or an element whose value can be set
  (an editor's document); it stays the caret block and is not walked into. A text area that can't
  be edited (a terminal, a read-only view) is still such a field and keeps the text around its
  caret, which Windows reads only from a field that can be edited or a terminal's pane.)*
- *(Amended 2026-10-06, measured in Gmail's rich-text compose with the owner: a Chromium field on
  the Mac is counted and placed by its text markers. Chromium gives a field no marker-index
  conversion (no `AXStartTextMarkerForTextMarkerRange` or `AXEndTextMarkerForTextMarkerRange`, and
  an `AXIndexForTextMarker` counted only from the marker's own node), so the marker read gives up
  and the field's value and selected range were read, and both are wrong there:*
  - *Its character range (`AXSelectedTextRange`) puts a caret on an empty line at the start of the
    paragraph above it (9 against the markers' 96, on every read), with a placeholder for its
    bounds. Its markers are right: the caret's offset is the length of the text from the field's
    start to it (`AXLengthForTextMarkerRange`, `MarkerCaretSource.selection`). A selection made
    backward keeps its markers in the order it was made, so the earlier one starts it.*
  - *Its value (`AXNumberOfCharacters`) can hold a paragraph break that its markers and string
    ranges (`AXStringForRange`) leave out (347 against 346). The read counted the field by its value
    and read it by ranges, so the last range ran past the text, came back empty, and the whole read
    became unavailable: the "[redacted]" caret the owner kept seeing. The field is now counted in
    its markers too, but only when its string ranges end where its markers do: Chromium counts an
    image or other embedded object as a character in its markers and not in its string ranges, so
    a field holding one is read by its value and character range as before, which agree with its
    string ranges. A field whose value has no characters is read as empty: Chromium gives an empty
    text field its placeholder in its markers; an element with no character count (a page, a link)
    gets no caret read, as before. WebKit (Safari, Mail) answers its marker-index conversion only
    under private names and is read the same way; Gecko converts and keeps the marker read.*
  - *An empty line has no character in either, and a left-out break joins two paragraphs, so the
    text before a caret starting a line still reads as if the caret followed the last word (a
    caret on the empty line below "is it ready?" reads as right after the "?"). A line break added
    to that text when the caret's line starts at it was tried and dropped: a line also starts at a
    wrap inside a word longer than the line, and a break put between the texts around the caret
    there splits a secret the caret sits inside, which the shared core then redacts in neither
    half (ADR-DESK-046). The owner wants the break where the caret starts a paragraph, on every
    platform, in the shared core (2026-10-06); a paragraph's start is never inside a word.*

  *Every read logs where the caret was placed (offsets and lengths, never text), and why a read
  became unavailable. Windows (UIA) and Linux (AT-SPI) read the caret through other interfaces and
  are not changed.)*
- *(Amended 2026-10-06: a caret whose surrounding text could not be read is an empty caret
  window, not a withheld selection. Every helper stood the redaction placeholder in for the
  selection whenever a caret window could not be read (the field changed or lost the focus while it
  was read, a range gave no text, a marker did not round-trip), a caret with nothing selected
  included. The app then took the caret for a hidden selection: agent mode chose Edit, which refuses
  a selection that reached it redacted (ADR-DESK-046), and said "The selection holds what looks like
  a password or key" at a caret in a web form's comment box in Firefox (`caret 0/10/0`, the
  placeholder's ten characters) where a dictation pastes. With text selected the selection is still withheld, so
  Edit never rewrites text it did not see; with nothing selected the window is empty and unflagged,
  as the shared core already gives a caret it withholds (`caretWindow`), so Compose writes at the
  caret. The shared core makes the choice (`caretUnread`, with whether text is selected; its cases
  in `context/context-cases.json`), and its own withheld caret window gives the same answer;
  `SharedContext.CaretWindow.unread` on the Mac and `CaretSource::unread` for Windows and Linux only
  ask it (ADR-DESK-054). Where the selection is not known (it could not be read at all) it is
  withheld, as before. The Mac's marker read (Gecko, WebKit) now logs where
  it placed the caret and why a read failed, as the value read already did. Measured with it in
  that web form, in an empty single-line field: Firefox counts the field as one character long,
  the caret at its start, and gives no text for that character, so the read around the caret
  fails; a field holding text is read in full. Which call refuses the character is not logged.)*
- *(Amended 2026-10-06: a Chromium rich editor (a `contenteditable`, Gmail's compose) is read
  around its caret on Windows and Ubuntu, as on the Mac. AT-SPI gives each paragraph or link as an
  embedded object (U+FFFC) with text of its own; Linux walks them in order (`hypertext.h`) and the
  core's `hypertext` op joins them, a block on a line of its own. A link is gone into only where
  its text is U+FFFC and its element is not one the read is already in: GTK's labels give a link's
  text inline and the label itself as its element, and are read as they are. A caret Chromium gives
  a text at an element's object, the element reporting none (the caret at the end of the text before
  a link), is placed just before that element. A selection's start or end Chromium gives at an
  element's object, the element reporting no part of its own or an empty one, is at the element's end
  (measured in Chrome on Ubuntu, 2026-10-06, as Chromium's source has it: an endpoint inside an element
  maps to its object, and one anywhere else gives the element a part): a selection from a paragraph's end starts before the break after it, one
  ending at the next paragraph holds that break, and one at an image keeps its edge. The caret is read this way
  only in an editable focus; a page in focus (Chromium gives it document hypertext too) is read by its
  own text, as any element. A rich text holding
  more than the caret source's bytes or its own element budget (`caretSourceElements`, 300, in the core:
  measured in Chrome on Ubuntu, 300 paragraphs read in 0.6–0.7 s and 499 in up to 1.5 s, the whole
  screen read's time) is
  not read at all (an element is not asked for its text past the bytes left, nor for its links when it
  has more than the elements left); nor is one the core refuses to join. Neither
  fails the rest of the screen read. The breaks the core puts between blocks are its own, not the
  provider's (amended 2026-10-06, after the train's tier-2 review): the joined text marks them
  U+2029, as the caret window marks its put-back breaks, and wherever it goes (the caret's read, a
  text block, a field's text or its recognition context, the field read for corrections) the core
  shows each as a line break and checks it as it checks the caret window's, over the whole screen:
  the screen is redacted without them too, and where one falls inside a match there, every line
  holding one is withheld (the field read gives none), and every other line must read the same
  either way, or nothing is read. A key split across blocks is whole only without them, and a
  token whose label is in the block above is seen only with the screen around it; two tokens on
  consecutive blocks are both hidden only with them. Before, a key split across two blocks, or one
  under its label, reached the reply in unrecognised pieces. An open edge is never cut at a `.`
  before an added break, which is no sentence's end (a JWT's header). A selection over added breaks with nothing
  redacted in it keeps Edit on, on every platform: the breaks shown as line breaks are no change
  to the user's text. A key opening a block after a sentence's `.`, a `:` or a space is withheld
  with every line holding an added break (more withheld than needed, never less). A selection the editor reports that the elements' parts leave
  empty makes the caret unavailable rather than a caret with none. Windows reads the field through
  UIA's TextPattern, which leaves out the break of an empty line: measured on Electron's
  Chromium, a caret on an empty line sits at the end of the paragraph above, its line starts at
  the caret and holds only the break, and its paragraph starts before it. So the helper sends what
  starts at the caret (`caretStarts`: whether a paragraph does, whether a line does, and the line's
  first bytes, at most `caretLineBytes`), and the core's `caretWindow` adds the break left out
  when the caret starts a paragraph, or a line holding only a break, and the text before it ends
  in none. A line a soft wrap starts gets no break: a long link wrapped at the caret stays one
  line. The break counts within the before-part's budget (one at the limit gives up the part's first
  character, and its start is then unknown), and never stays at a caret inside a secret: a break
  inside a key wrapped at the caret would split it into halves no pattern matches (a reviewer of the
  Mac's first version showed both halves leaving unredacted), and so would one between a field's
  key and its label in the block above. Only the whole screen shows the second, so the render
  decides: it redacts the screen without a break just before the caret too, and where the redactor
  places the caret inside a match there, neither text can be trusted alone. The break may be one the
  text holds, and taking that out can join two keys into one match that hides the second's start. So
  the caret's text is withheld there (a selection becomes the refusal marker), and a block that reads
  differently with and without the break refuses the read. Owner, 2026-10-06: the paragraph rule
  is the stricter one and holds on every platform; the Mac's own rule (`MarkerCaretSource`) moves
  to the core's after the Chrome caret change lands. Left: a soft wrap inside a long word, a
  break Chromium leaves out further back than the caret's line, and on Ubuntu the break before a
  paragraph a BACKWARD selection ends at the start of (Shift+Up from a line's start): AT-SPI reports it
  as it does a selection of the line before alone, so that break is not selected. A forward one
  (Shift+Down) is told apart by the caret at the next paragraph's start, and holds the break.)*
- *(Amended 2026-10-06: the Mac follows the core's rule. A Chromium field read by its text markers
  (`MarkerCaretSource.selection`) is asked where the paragraph holding the selection's start begins
  (`AXParagraphTextMarkerRangeForTextMarker` on the earlier marker; an empty line is a paragraph
  of its own), and the bounded caret collector hands that to the core's `caretWindow` as
  `caretStarts` (`voice_core_source_caret_starts`). The Mac measures no line, so only a paragraph
  start adds the break, and a field that answers no paragraph, or one read by its value or a
  marker-index conversion, gets none, as before.)*
- *(Amended 2026-10-06, owner: the breaks further back are put back too. In Gmail the caret on the
  first of two empty lines under a sentence read one empty line short, and every paragraph that
  starts right after text (each `<div>` of a rich editor) ran into the one above. The adapter now
  says where each paragraph starts within the core's `paragraphStartUnits` (twice the graphemes a
  side shows) of the selection, in its own offsets (`voice_core_source_paragraph_starts`). The Mac reports where each block
  of the field's tree starts (`HelperConfig.blockRoles`: a `<div>` is an `AXGroup`, inline
  formatting and links are not), and text after a block, finding the first sibling that reaches
  the window by halves. Chromium's own paragraph answers were tried first and dropped: walked back
  from a paragraph's start they give each run of text (a word edited apart) as a paragraph, and
  the owner's smoke test read "plan" / "ning" on two lines. A caret at the end of a line and one
  at the start of the block after it have one offset in the text, so the adapter also says which
  (`caretEndsLine`; the Mac: the element Chromium gives the caret's marker started before it and
  reaches it), and the break at that offset then follows the caret; without it the owner's caret
  after a line's last word read as if on the next line. With the block starts, the Mac no longer
  sends Chromium's answer to whether a paragraph starts at the caret (`caretStarts.paragraph`):
  every left-out break is at a block start, and that answer also says yes at a bold word or link
  inside a line. The core's `caretWindow`
  puts back the break before each start that has none, as U+2029, within each part's budget (a
  side at its limit gives up its far end, and its edge is then unknown). An open edge is cut where
  the provider's own text closes a token, found before any break goes back, and the breaks (the
  caret's own too) go back only inside the text kept: a break first would read as the whitespace
  after a `.` and cut a token's head off, showing the rest. A caret source sends the starts near
  the caret or `caretStarts`, never both (the core refuses the pair): the render checks each kind of
  break apart, and one of each could split a key both checks miss. The render shows U+2029 as
  a line break, and redacts the caret's text without the put-back breaks too, with each one
  anchored: one inside a match there withholds the caret's text, and a block that reads differently
  either way refuses the read, as for the caret's own break. Tested in real Chromium by
  `native/macos/Tests/electron.mjs`.)*
- *(Amended 2026-10-06: Windows and Linux. Windows finds its block starts as the Mac does, in the
  field's own tree: Chromium's paragraphs are groups only UI Automation's raw view holds (a search's
  own view is the control view, so a node's children come in one call with a raw-view tree filter),
  `HelperConfig::blockControlTypes` (group, list, list item, table, and text with a heading level)
  are blocks, and `RangeFromChild` places each. The core takes byte offsets into the caret window's
  parts (`CaretSource::window` sends `paragraphStarts` and `caretEndsLine` to `caretWindow`); each
  start's offset is the length of the text measured to it along the window, from the stretch's start
  and then from one start to the next, and must be what the parts hold there, or no starts are sent.
  No range measured starts at the caret: Chromium orders a caret at the end of a line before the
  block starting at its offset and reads the text between them as that line's break, though the text
  around the caret shows none (measured in Electron), so a start measured from the caret lands one
  past it. The caret ends a line when the element `GetEnclosingElement` gives for the selection's
  start starts before it and reaches it, as on the Mac. UI Automation's paragraph units miss these
  starts, so they are not used. Linux needs no adapter: it reads a rich editor through its elements
  (the hypertext walk), whose block marks put every break back already. Both run the Mac's seven
  cases in real Chromium (`windows/tests/electron.mjs`; `linux/tests/electron.mjs`, which runs on
  Wayland, as GNOME reads only the active window and does not activate a new X11 one).)*
- *(Amended 2026-10-07, owner: the screen is read exactly as it is laid out, and redacted as it
  is, with heuristics only for what the screen shows.) The core no longer puts its own breaks into
  the text as U+2029 and reads it two ways: the breaks a rich editor's blocks show (the `hypertext`
  join, the caret window's put-back breaks) are line breaks, and the text is redacted once, as
  read. The withholding that compared the two readings (every line holding an added break, the
  field read's refusal) is gone with them. A secret the screen shows over two lines is read in two
  and can reach the reply in unrecognised pieces: accepted by the owner as rare in real use and
  never the whole secret. The helpers' fallbacks for where a line starts (the Mac's
  `startsParagraph`, found in the Gmail smoke; Windows' paragraph units and merged text) stay.*

  *The pieces of one line on screen are now redacted as that one line. Chromium gives a run of bold,
  a link or code inside a paragraph as a piece of its own (Mac `AXStaticText`, UIA text elements),
  and each block was a line of its own to the redactor, so a key split by a bold run was read in
  its pieces. Text and link blocks the render puts on one line (`separator`: inline, at or right of
  the one before, overlapping it by half the smaller one's height) are joined for the redactor as the
  screen shows them, and each block takes back its own redacted parts. Between them goes a space
  where the screen has one, and nothing where they abut. Measured in Electron's Chromium on the Mac
  (2026-10-07): a bold run inside a word starts exactly where the text before it ends, and a space
  the screen shows is inside its piece's box (`Visit ` ends where the link starts), so geometry
  alone can't tell the two apart. `admit` now keeps one space at each edge of a piece that had any
  (the core trims every block but a field, the caret and one given with its runs when it reads the blocks back), and two
  pieces abut only with no space at that edge and a gap of at most a tenth of the smaller box's height
  (`ABUTTING_GAP`) either way. A piece whose box ends well past the next one's start wrapped onto
  more lines (a Slack message) and gets a space. A helper gives a wrapped piece one box over all its
  lines, so where it meets the piece beside it is not known: a key split by styling where either
  piece wraps is read in its pieces, as the base read it, accepted by the owner as rare
  (2026-10-07), tracked as #178 (P3) *(fixed the same night, owner: the readers give where a
  piece's text starts and ends, the amendment below)*. The render uses the same joiner, so the read shows
  "Visit [example] now" and a word split by italics stays one word. A soft wrap between two pieces
  is still a line break. AT-SPI gives Chromium's paragraph as one text with its runs, so Linux had
  no split. A piece that touches a key with no space on screen (a label laid against a `ghp_` key)
  before or after it reads as a key glued to a word, which the redactors do not match (an AWS or
  Google key must start and end at a word's edge), so the whole key is shown:
  accepted by the owner as rare (2026-10-07), tracked as #175 (P3) *(fixed the same night,
  owner: such keys are redacted glued, ADR-DESK-046's amendment)*. The base redacted it only
  because each piece was a line of its own; one plain piece holding the same text never was. A
  link's box holds the space the screen shows before or after it inside the link (`Read <a>more
  </a>now`), and every platform gives a link's text through `SemanticText`, which trims it: it now
  gives such a space as a hidden run at the block's edge, which counts for the join and the redactor
  and is never shown, so the read is "Read [more] now" and a key that is a link's text, or follows
  one, is redacted. A block whose runs start or end hidden (a field's source inside a link) is
  spaced there as well: text the screen does not show is never glued to the key beside it. The read is
  redacted as the one text the screen shows: the pieces of a line joined as the render joins them,
  and a line break between lines, each joiner and break a part the read does not show. A block that
  shows nothing but blanks is dropped first, so the redaction and the render see the same neighbours
  (two abutting pieces with an empty field between them in reading order are matched as joined). A
  match puts its `[redacted]` where its replaced text starts; when that is a part the read does not
  show (a joiner, a line break, a link's hidden run, a field's text around what it shows), the next
  shown part the match changed takes it instead, once, so the read says where shown text was taken
  out and never shows hidden text (a key body after `Key` held in a link reads "[Key] [redacted]"). *(Superseded the same night by the amendment below: the read is laid out once and redacted last, and a marker goes where the first shown character was taken out.)* A private key's body with no header beside a label on its first line (`Key:`
  beside a block of base64) is one line with the label now, so its first base64 line follows a space:
  `private-key-lines`, and `private-key-end` before a full line of base64, start a body after a
  space or a tab as well as at a line, which also redacts one plain piece holding the same text.
  The patterns for a header-less body take a line break as the core does (`\n`, `\r`, U+2028,
  U+2029): a Qt editor gives U+2029 between its paragraphs, which the core's old second reading
  turned into `\n`, so a body read from one was shown once that reading was gone. A field's own
  U+2029 is given as `\n`, so in the field read U+2029 is only ever a terminal's row break. The end
  line's pattern takes the space it starts after instead of looking ahead for the base64 after it:
  a lookahead runs in the regex library's backtracking engine, which took 21 s on 200 KB of short
  lines; the hostile-text test now has those shapes.
  Each platform's real-Chromium test (`macos/Tests/electron.mjs`,
  `windows/tests/electron.mjs`, `linux/tests/electron.mjs`) reads a key split by bold and a link
  between words, a link holding the space after it and a key that is a link's text; the Mac and
  Windows runs fail on the old per-piece lines.)*
- *(Amended 2026-10-07 night, owner: the read is laid out once and redacted last, at its most
  stable point; a key the redaction misses is a reader's bug.)* Each round of review on the change
  above found the redaction and the render disagreeing: the read was redacted as one arrangement
  (parts, joiners, each part's result mapped back) and rendered as another (the render dropped
  empty blocks, worked out the separators again and moved markers), and every place the two
  differed showed a key whole or put a marker in the wrong place. Owner: *"the OS level specific
  binaries that cannot be shared standardized read; the shared Rust looks at the standardized read
  sequence and does the redaction"*, and *"the other bugs that could cause issues with redaction are
  actually bugs at a lower level that does not properly read the streaming text."* The text enters
  memory either way, so redacting earlier protects nothing; it is done last, on the text as laid
  out, and nothing is laid out after it.

  The helpers give the read as before (blocks with their text, runs, a field's source and boxes,
  and the caret's three parts). The core lays it out once: blank blocks are dropped, and what goes
  between each block and the one before it (`separator`: nothing, a space, a line break or two) is
  set on the block (`lay_out`, `Block::before`). The text the screen shows is that one sequence:
  each block's text where it is, its hidden runs and a field's text around what it shows in place,
  the separators between, and the caret's parts; each byte knows its part and whether the read shows
  it. It is redacted once by `privacy::redact_traced`, the same rules as `redact`, which also says
  which input byte each output byte is (a replacement keeps what its template copies around the
  placeholder, such as `token=` or the `@` after an address password, where the match has it at its
  ends; nothing else of the match survives, even characters that look like the marker's own, so a
  value written `[…]` is redacted whole). *(Amended 2026-10-08: `redact_traced` and its per-byte
  origin map are replaced by `privacy::taken`, the byte ranges every rule's matches take out of the
  text as read, with no rule order (ADR-DESK-046, 2026-10-08); each part keeps the bytes it shows
  outside them.)* The read then shows, for each part, only the bytes it shows
  that survived, and one `[redacted]` where the redaction took text out (one match, or several side
  by side), in the part that showed the first character taken; where it took only text the read does
  not show, nothing marks it, so the read never says where hidden text was. The caret's window is
  reported on its own as well, so a match that runs into it marks it too. The render only adds the
  markup (`## `, `[ ]`, `| `, `> `, `» `, `‸`) around what survived and puts the block's own
  separator before it, made at least as much as the whitespace the redaction left at a part's edge
  (a key that ends inside a piece that goes on keeps the space or line break the screen shows after
  it); a block left with nothing is dropped, and the blocks either side of it keep
  the stronger of the separators around it (a line break over a space). Budgets cut the result
  after the redaction, as before. A key the screen shows whole that this misses is read wrongly by
  that OS's reader (a piece left out, a boundary misplaced), and is fixed in that reader, never
  made up for in the core. The corpus is the specification: every case passed unchanged; four new
  ones pin a block dropped mid-read, the marker in the caret's window, and one marker for matches
  side by side.
- *(Amended 2026-10-07 night, owner, #178: a key split by styling where one piece wraps is read
  whole.)* A piece that wraps onto more lines (a Slack message, a long bold run) has one frame over
  all its lines, so where it meets the piece before or after it was not known: its frame starts at
  the line's left edge and ends at the column's right one, and `separator` read a gap where the
  screen shows the two abutting, so the key was read in two pieces. Each reader now gives, with a
  text or link block's frame, `ends`: the box of its text's first line or character and of its last
  (Mac: the first and last characters' boxes by text markers in Chromium and WebKit, by character
  ranges elsewhere; Windows: the first and last of the line rectangles of the block's range in the
  page's text; Linux: the first and last characters' extents). `separator` meets the pieces where
  the first one's text ends and the next one's starts, and uses the frame where a helper gives no
  ends or an empty box; the line below (a blank line between columns) is still read from the
  frames. The OS code only measures; the decision stays in Rust. Each platform's real-Chromium test
  reads a key split by bold where the bold run wraps, and one where the run after the key wraps;
  the Mac run fails without the ends.

**Amendment 2026-10-07 — a field its markers cannot read around the caret is read by its value
(issue #162).** Owner, raising it to P2: in Firefox's address bar on the Mac the marker read placed the
caret (`caret 30+0 of 30 chars, from the marker indices`) but gave no text around it, so the caret
window was unread and a dictation after a sentence's `.` was not spaced, while the field's value and
selected range read fine a second later (`CorrectionWatch`). Where the markers place the caret but
give no text around it, `MarkerCaretSource.read` now reads the field as an ordinary field is read
(`valueCaretWindow`: its value and selected range, within the same budgets), and is unread only when
that gives nothing either, a selection still withheld. A field that changed while its markers were
read is unread, as before, and not read again. Only the Mac reads by markers.



**Amendment 2026-10-26 — non-field selections keep private recognition context (#263).** A
shown read retains the approved bounded source before and after a selection in a focused page,
list or row until the same combined redaction pass used for fields. `caretSelectionOnly` marks
those sides as recognition-only: they consume source allowance, reserve no presentation space,
and appear in no reply field, rendered block, summary or content log. The selected bytes have
no new source edge where the hidden neighbors meet them. A whole-window read still carries no
independent caret source or selection.
