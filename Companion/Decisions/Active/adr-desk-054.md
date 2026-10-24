## ADR-DESK-054: Shared logic lives in Rust only; native code is thin OS adapters

**Context:** The three platforms' helpers share a Rust static library (`native/shared/rust`) for
redaction, exclusions, address classification, context rendering and the terminal viewport
(ADR-DESK-046's shared-core amendment). A census of the Swift and C++ helpers on 2026-10-05 still found
some 830 lines of logic that is not about the OS: the decisions made at each node of the screen
walk, the excluded-page scan, building the screen read's reply, the terminal surfaces' run and caret
arithmetic, the focused field's read policy, request validation, and constants and markers written
out in each helper. Written three times, it had drifted apart: Windows never marks a withheld part
`[hidden for privacy]`, and treats an excluded-page scan that runs out of budget as "no excluded
page" where macOS withholds the part it was looking through (macOS keeps a three-way answer, none,
excluded or not seen whole, and each of its call sites decides); the helpers counted a 0×0 box and a terminal caret at a run's ends differently, and checked
the focused field's length in different units and ranges. Owner, 2026-10-05: move the platform
logic that is really shared (redaction and everything like it: exclusions, viewport rules, text
policy) into the shared Rust core, leaving only the OS walk and adapters per platform, and make the
design explicit.

**Decision:**
- **Shared logic lives in Rust only.** A rule that does not depend on the OS — what is read, refused,
  withheld or redacted, how text is cut, joined, measured and rendered, the budgets and limits, the
  markers, the shape of a reply and the validation of a request — is written once, in
  `native/shared/rust`, and every helper calls it through the C ABI (`include/voice_core.h`; Swift
  `CVoiceCore`, C++ `VoiceCore.h`). A helper never re-implements one, and never keeps a copy of a
  shared number or string; it asks the core (`limits`).
- **Native code is a thin OS adapter.** What stays in Swift and C++ is what only the OS can do:
  walking the Accessibility, UI Automation and AT-SPI trees and reading their attributes, text
  ranges and geometry (UI Automation's opaque text-range endpoints included); focus and foreground
  identity and their re-checks; getting an address from a provider; app identity; clipboard, keys,
  portals, the GNOME extension, the microphone, the productivity providers, watchdogs and deadlines.
  Where a decision needs facts from the walk, the adapter hands the core those facts (a node's role
  class, frame, password flag, page, child count) and does what the core answers, through a handle
  like the semantic and source handles.
- **The core's cases are the contract.** Each shared rule has its cases in `native/shared/`
  (`privacy/*-cases.json`, `context/*-cases.json`, `hotkey/gesture-cases.json`); the Rust suite runs
  every file, and every helper's suite runs the cases of a rule that helper applies, through the
  same C ABI it ships with (CTest on Windows and Linux, `scripts/swift-errors.sh test` on macOS,
  which now runs `cargo test` too). A rule only the app applies has its cases run by Rust and the
  app's suite (`context/terminal-action-cases.json`).
- **Where the helpers disagreed, one answer, decided by the owner (2026-10-05):**
  - An excluded-page scan that runs out of budget fails closed on every platform: a part to be read
    whole (an element read in one piece, a terminal's surface) that the scan could not see whole is
    withheld. ADR-DESK-047's two owner-kept cases (2026-10-01) stand: a walk that runs out of budget
    keeps what it gathered, having never read the page it did not reach, and the 0.2 s page scan
    before a field is read for corrections, which stay on this computer, does not stop that read.
  - A withheld part is marked `[hidden for privacy]` on every platform, Windows too.
  - The focused field's read for correction learning follows the macOS and Windows rule: only the
    field itself is checked for being a password field, not its ancestors (the excluded-site page
    scan before the read stays). A request's `maxLength` is 1 to 20,000, Windows's range (macOS took
    any length from 0, Linux 0 to 20,000).
  - A box thinner than 1 point (scaled for the display) either way is hidden; a 0×0 frame (none
    reported) counts as shown; a hidden box's children are still walked. Asked again with the
    trade-off that ADR-DESK-007 recorded (Chromium on Windows reports a child's frame unclipped,
    so walking into a screen-reader-only label reads its text as though it were drawn), the owner
    kept this rule: Slack is an Electron app that works the same on every platform and keeps its
    message list in a 1×2 box, and screen-reader-only text is useful context to make good use of,
    not to hide. Windows walks in from then on; Linux counts a 0×0 frame as shown.
- **And two that need no owner call, being wording or strictly more private:** stop reasons are
  `node budget` and `time budget` on every platform, and the host of the page a read came from is
  checked against the excluded sites after every read, not only on macOS.
- **The paste's rules follow Windows's numbers** (a unification, reported to the owner
  2026-10-05): every helper refuses a text that is empty, longer than 512 KiB or holds a NUL, and
  the Windows and Linux helpers, which the app gives a deadline (macOS gets none), a deadline that
  is not after the helper's clock or more than 5 s past it. Until then macOS
  pasted any text, empty or holding a NUL, at any length, and Linux took up to 1 MiB with a
  deadline at most 3 s ahead. The app's own paste is far under 512 KiB and sets its deadline
  within 5 s, so no dictation is refused by this.
- **Moved in steps, each its own PR with tests:** this rule, dead code that duplicated the core, and
  the policy cases run by every helper; then the screen read's reply, the focused field's policy
  and request validation; then the terminal surfaces' arithmetic; then the walk's per-node
  decisions and the excluded-page scan, behind a walk-policy handle, applying the decisions above.

**Consequences:**
- A change to what is read or withheld is made once and holds on every platform; a helper's diff is
  OS work only. Every new rule starts in the core with its cases, not in a helper.
- The C ABI carries more calls per read (one per walked node once the walk policy moves), each a
  small JSON or handle exchange; the walk's budgets bound how many.
- Until the walk-policy step lands, the walk's per-node decisions are still per platform. The
  decisions above were applied in each helper first, one step before that move: Windows looks
  through a part read whole and withholds it behind the marker (served by the core's `limits`)
  when the look runs out, reads no terminal window it could not look through whole, and walks into
  hidden boxes; Linux counts a 0×0 frame as shown and names its stops `node budget` and
  `time budget`.
- The helpers' own `HelperConfig` keeps only OS numbers (timeouts of an OS call, retry intervals);
  a number the helpers share comes from the core.

**Amendment 2026-10-06 — the terminal surface's rules (the third step).** One `surface` op in the
core now builds a terminal's runs, selection and caret from what the helper read (its spans, texts,
selections, caret offset and drawn frame). Where macOS and Linux had answered differently, the core
answers once:
- A caret drawn on the clip's edge is inside it, on all four sides (a caret at a line's first column
  sits on the left edge); one whose bottom touches the clip's top, or whose top touches its bottom,
  is outside.
- A caret at a span's end belongs to that span, a caret on a boundary to the span it starts, and a
  caret in no span is `outsideViewport`.
- A malformed selection (inverted, out of range, unsorted or overlapping) is withheld, and the
  surface kept: the reply says the selection is incomplete and has no ranges, so Edit refuses.
  Linux refused the whole surface before. **Windows still refuses the surface** (its UI Automation
  read is not on the op); both fail closed, and Windows moves to the op's rule when its terminal
  read does.
- The budget is in UTF-8 bytes. A helper reads at most that many UTF-16 units (macOS) or scalars
  (Linux), each at least one byte, so nothing that fits is left unread; the core then checks the
  exact bytes and refuses a surface over them. macOS read a third and Linux a quarter of the budget
  before, refusing mostly-ASCII screens that fit.
- A caret frame that is not finite or has a negative size refuses the surface, as a request the
  core cannot trust. A caret whose drawing could not be confirmed is sent without a frame on macOS
  (`outsideViewport`) and without a caret on Linux (`unavailable`), as is VTE's ambiguous caret at
  a text's start or end. None of these is `exact`, the only status the app acts on.

**Amendment 2026-10-06 (the walk-policy step):** the walk's decisions now live in the core,
`voice_core_walk_json`: `node` (what to do with one element, from the facts a helper sends: a
shared role, focus, page, password, hidden, frame, window and how thin a box hides its text),
`look` (what a look inside a part read whole decides), `census` (each step of that look),
`stop` and `limits`. `native/shared/context/walk-cases.json` holds its cases, run by Rust,
Swift and CTest `voice-walk`. Each helper maps its OS roles onto the shared ones (macOS
`HelperConfig.contextRoles`, Windows and Linux `sharedRole`) and keeps only OS work: the tree,
attributes, geometry, a page's address, a field's or control's text, and the provider census it
looks with (Windows asks the core at each step, `walk.h`'s `lookForExcludedPage`; Linux keeps
AT-SPI's collection census, `safeSubtree`, and maps its answer onto `look`). The rules are the
Mac's, the most tested, so on Windows and Linux (overnight owner rule, 2026-10-05: the Mac is the
reference for a behaviour difference, the more robust option for a conflict):
- A field holding an excluded page is replaced by the marker; the window is no longer refused.
- An element wholly outside the window is skipped with what it holds, an excluded page there too
  (ADR-DESK-047's 2026-10-01 amendment; Windows refused one); one the window may show, even hidden
  or thin, still refuses it.
- A piece of text, field, heading, link or row whose box shows nothing is skipped, not walked into
  (Linux walked into hidden text); containers and a page's list items are still walked into.
- A heading, link or row is read as on the Mac: its own label is looked through when it is read,
  and each of its parts is judged and looked through on its own; the whole block is no longer
  withheld when one look of everything under it runs out (Windows, Linux).
- A password element on the focus's path is walked into like any ancestor; one elsewhere is never.
- Linux reads a list item outside a page as a row; Windows already did.
- A look does not count the element it looks inside: up to 5,000 elements inside it are seen
  whole. Linux's census without a provider collection had missed what lay under the last
  elements it fetched at the budget's edge; it now fetches one more than fits, so it says when
  it overflows. Only visits count, not what waits: a look goes deep first, the children last
  fetched first, so each element fetches one more child than the visits left, and what waits past
  the budget leaves the look not seen whole only once the budget's visits are spent. Giving up as
  soon as the waiting outnumbered the budget missed an excluded page among a wide element's last
  children that the Mac's look had found. The Mac takes AX's children whole (AX gives them at
  once); Windows and Linux fetch the core's count.
- The more robust choice where the Mac has no answer: a page's control on Windows and Linux is
  looked through before its caption is read, shown or not, so a hidden control holding an
  excluded page refuses the window (the Mac skips a hidden titled control unread).

**Amendment 2026-10-06 (the train's tier-2 review): the last shared decisions move in.** A review
of the whole train found shared rules still decided in Swift and C++ after the walk-policy step.
Each now lives in the core, with the helper keeping only what the OS gives:
- **Markers and refusals:** the withheld-part marker, the redaction marker, an unavailable caret's
  reply and a screen read's stop reason come from the core (`hiddenMarker`, `caretUnread`,
  `admit`'s `stop`); no helper spells one. The helpers' unused caret pre-renders (each sent the
  caret's block with the text around the caret already marked, which the core replaces) and the
  Mac's inline-block flag are deleted: the caret's block goes out empty.
- **Thin boxes:** a helper sends the display scale (Windows: the window's DPI) and the core applies
  its one-point rule; no helper keeps the threshold. A terminal's surface on Windows, read outside
  the walk, asks the walk's `shown` op whether it shows anything.
- **Protected text and terminal surfaces:** the look for a password element inside a terminal's
  subtree, and on Windows and Linux inside a focused field or a part read whole, is the core's
  `census` with `protect` (`walk.h` `holdsNoPassword`, the Mac's `SharedWalk`, Linux's
  `safeSubtree` where AT-SPI gives no collection; with one, the provider's role query finds the
  password elements), so a password element anywhere under it or a look not seen whole refuses it.
  The protected census counts the element itself: the element and up to 4,999 elements inside it
  are seen whole, as Windows's census before the train did. So on Linux without a collection, a
  part read whole holding exactly 5,000 elements is withheld where the Mac's look, which does not
  count the element (above), reads it: one element at the budget's edge, withheld rather than
  read, the more robust option for a conflict. Gathering a window's surfaces (how many, how many bytes, which spans may be read, and
  whether the viewport is complete) is the viewport's `collect` op, which the helper drives step by
  step without changing its state.
- **Rich editors:** Linux sends a rich editor's elements as they are (`hypertext` with `elements`,
  its only form: each one's text, caret, selection, block flag and links), and the core joins them, placing the
  caret, the selection and the breaks it adds between blocks. The Mac and Windows block walk near
  the selection (which element to place, which starts a line, when the walk ends, and which side of
  a block boundary the caret is on) is the core's `blockStarts` op, run as a step protocol like the
  census: the helper places each element it is asked about and says what the OS reports.
Each op's state round-trips through the helper and is validated on every step; a reply out of turn
is refused, and a refused step fails the read closed. Behaviour does not change, but for the
protected census's count: the block walk is
checked against the Mac's former walk on random fields (`blocks/tests.rs`), and the other ops by
their shared cases (`context-cases.json`, `surface-cases.json`, `walk-cases.json`), which every
helper runs.

