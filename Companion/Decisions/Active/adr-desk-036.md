## ADR-DESK-036: The chat window opens over the pill; the bubbles are a history of what ran

**Context:** Owner, 2026-09-28, reading an agent-mode answer session's log: "the answer box [should]
appear above the … voice pill … and close the other tools"; "while the chat is running, I don't see
the circle running and executing tools"; "we want the tools to appear below the … voice pill … only
show like three or so, and it just fades away to the right … sort of alphabetical … the most recent
run tool just appears on the left … shifting the other tools to the right"; the Settings tools page
sorted alphabetically; "the answers being shown are … pretty rough … look at Thunderbird and how the
text appears … and mimic that"; and some turns seemed "not in turn". Asked, the owner chose a small
resting circle for the pill between follow-ups, and, for an unclear request in agent mode, "have a
prompt to ask the user". Later the same day: a gray request bubble "looks bad"; "make the … neon glow
very apparent for the pills … a hint that we're in agent mode, only for the pill"; the pill should
circle while agent mode works; a bubble "slightly smaller than the pill" at rest but as large as
before when grown; and "4 entries tops". The log showed three causes: the chooser pasted a spelled-out
name as Compose text into the app instead of continuing the conversation; the answer asked instead of
acting on a correction; and the web search, run on the backend inside a round, showed nothing, since
the stream was read whole and named its tools only in development builds.

**Decision:**
- **Placement.** The pill stays where the overlay put it for the caret, or for the pointer without
  one (`pillPosition`; the pointer's spot is kept, so the chat opens there even if it has moved). The
  chat window opens `chatPillGap` over the pill and its bubbles (`chatStripHeight`), or under them
  when the tallest window would not fit over them but would under them; on a screen too short for
  either, on the side with more room, growing no taller than that room and scrolling instead
  (`chatSide`, `ChatPlacement.maxHeight`), so all of it, a question's buttons too, stays on screen.
  The side is decided once, so it never flips as the chat grows. The overlay window is laid out by
  `chatWindowFrame`, keeping the edge on the pill's side fixed as it fits the chat's height, so the
  pill never moves; its bubbles keep the side they had
  (`ChatPlacement.bubblesUnder`). The view is told where the pill is across the window
  (`ChatPlacement.pillX`). The window takes the mouse over all of it while the chat is open, as
  before; the pill's layer lets the pointer through to the chat but for its bubbles.
- **One tree.** The overlay page renders the pill in the same place in its tree with the chat window
  open or not, so the pill and its bubbles don't remount as the chat opens. The chat appears once,
  fading in as it rises `chatAppearRise` from the pill and scales up from `chatAppearScale` over
  `chatAppearDurationSeconds`. Under it the pill rests as a circle with a fainter sparkle
  (`agentRestingSymbolOpacity`) while nothing runs, listens for a follow-up without the warm-up
  swirl, and keeps the last request's bubbles until a follow-up knows its own.
- **The row.** Bubbles go in one row under the pill (over it without room, `bubblesFitUnder`), a
  `agentBubbleGap` from it and `agentBubbleSpacing` apart (`bubbleRow`): the first
  `agentBubbleRowVisibleCount` (3) centered on the pill in full, then `agentBubbleRowFadeCount` (1)
  fading away to the right (`bubbleRowOpacity`), four at most. Their order is `bubbleOrder`: those
  that ran, the latest first (`DictationController.recentBubbles`, `ranNow`: the tool the agent
  chose, then the app whose tool starts), then the rest alphabetically by name (`alphabetical`). The
  history lasts the app's run, in memory only. A bubble slides to its new place over
  `agentBubbleMoveDurationSeconds`.
- **Running.** *(Amended 2026-10-05, below: one bubble runs at a time, the first in the row.)* A bubble circles while its tool runs, and an app's while one of its tools runs: a
  `ConnectorTool` here, or a server tool of the app's (`serverToolConnector`: the web's `search_web`)
  inside a round, one at a time as the answer's tools run in turn
  (`DictationController.runningConnectors`, cleared at teardown). The pill circles while agent mode works (`running`). Bubbles are
  `agentBubbleDiameter` (20) at rest, smaller than the pill, and grow about their center to
  `agentBubbleHoverDiameter` or `agentBubbleRunningDiameter`, as large as before; neighbors both
  running don't touch.
- **Agent mode's pill.** In agent mode (and under the chat window) the pill glows as neon, a tight
  blue glow in a wide purple one (`agentPillGlow…`); dictation's pill and every bubble keep the plain
  glow. *Amended 2026-09-29:* the owner found the blue and purple neon "not as apparent" beside
  dictation's own blue and purple glow and, from eight colors rendered side by side and then seen
  live, chose red-pink: a tight `#FF2D55` glow in a wide `#FF006E` one (`agentPillGlowInnerColor`,
  `agentPillGlowOuterColor`), the one color in the overlay outside the brand's.
  *Amended 2026-10-06:* the owner saw a long message under the chat window ("The selection holds
  what looks like a password or key…") cut off at the left and right, its neon glow clipped: the pill
  was as wide as the window (`pillMaxTextWidth` and the pill's padding, about 410 points, in a
  window of `chatWidth` and its shadow margin, 412). The pill is now never wider than the window it
  is drawn in less its glow on each side (`pillGlowReach`, the wider of the two glows), so a long
  message wraps to another line rather than reach the window's edge; with the chat window closed the
  canvas leaves the same room. A window placed against a screen's edge, with the pill off its
  center, can still clip the glow on that side, where it is off the screen anyway.
  *Amended 2026-10-06:* the owner saw "something like dots circling" in the working pill's ring. A
  circling rim is a conic gradient masked to a ring with a hard inner edge, which the rasterizer draws
  stair-stepped, and the steps of the spinning arc turning over the still track's read as dots
  running around the ring (the thinking circle's and a running bubble's too). The mask's inner edge
  now fades over `ringEdgeSoftness` (1 point, about the edge's center, keeping the ring's width).
- **Server tools as they run.** `HTTPRequest.onChunk` hands the completions stream to `SSEParser` as
  it arrives (a piece may end anywhere, a CRLF split across two included), and `Completions.round`
  reports each `tool_started`, `tool_completed` and `tool_failed` event that names its tool
  (`ServerToolEvent`); the chat shows a named tool's label while it runs. The backend now names the
  tool in production too, for every client (its ADR-023 amendment of 2026-09-28, deployed before this
  build; an event without a name is skipped, so an older backend shows no progress, as before). Its
  arguments and result stay development-only.
- **Replies as Thunderbird shows them.** A reply is laid out in blocks (`replyBlocks`: paragraphs at
  blank lines, each line break a line; bulleted and numbered lists, numbered from where they start,
  an unmarked line continuing an item; `#` headings), each line's inline Markdown as before, and
  revealed as TabMail's chat in Thunderbird reveals one: a line or list item every
  `chatRevealStepInterval` (100 ms), each fading in over `chatRevealFadeDuration` (180 ms) as it rises
  `chatRevealRise`, the newest kept in view unless the user scrolled up. Line height and paragraph
  spacing are Thunderbird's (`chatLineHeight`, `chatParagraphSpacing`). The request sits on the right
  at most `chatRequestMaxWidthFraction` of the width, as there, but in a light tint of the brand's
  gradient with a hairline brand border rather than gray. (Amendment 2026-10-05: one flat pale blue,
  `palette.chatRequestFill`, with a hairline `chatRequestBorder`, not a gradient; owner: a single flat
  color, chosen professionally.) While a request waits with nothing else
  to show, the window says `chatThinkingLabel`.
- **Settings** lists the tools and apps together alphabetically (`alphabetical`). The welcome
  wizard keeps its own order.
- **Unclear requests** (backend ADR-023 amendment, 2026-09-28): the chooser picks Answer for an
  unclear request, a bare name, a spelling or a reply to the last answer's question, and never
  guesses text into the app; the answer carries a reply or correction on into the request before it,
  and asks one short question when still unclear.

**Consequences:**
- The pill never jumps as the chat opens or grows, and the caret's line stays clear of the chat, which
  opens away from it.
- A follow-up's pill listens in place under the chat instead of in a status pill inside it; a
  follow-up's phase changes show nothing new in the chat, so they no longer scroll it.
- Only four bubbles show: with more tools and apps on, the rest show once they run.
- A server tool's progress needs the backend deployed first; the Voice app tolerates an older one.
- The reveal starts again for a reply whose turn remounts (it doesn't while the chat stays open).
- Shown once measured (amended, owner, 2026-09-30: no blink "for the agent answer tool"): the overlay
  window is transparent (`setOpacity(0)`) from `showChat` until the chat's first measured height
  (`fitChat`), and opaque again if the chat closes first, so the window resized for the chat never
  shows the pill out of place for a frame before the page lays the chat out. The pill is not drawn
  for those few frames.


**Amendment 2026-10-01: nothing in the chat shrinks.** Owner: the question for a new calendar entry
"was actually way hidden below in the answer", so it could be neither checked nor confirmed, and it
ran out of time unanswered. The chat's scrolling column has a set height once it is at its tallest,
and a column shrinks whichever of its items clip their own overflow: the question's card does, for
its timer bar, so in a chat long enough to scroll it was squeezed to its padding, its buttons cut
off where no scroll reached them. The column's items now keep their height (`.chat-scroll > *`) and
the chat scrolls. The `overlay-chat-confirmation-long` preview fails when the buttons are cut off
(`whole` now also looks at every clipping box above them); the one preview of a question had no
earlier turn, so it never scrolled.

**Amendment 2026-10-05: the chat grows in a window that stays at its tallest.** Owner, 2026-10-04:
as an answer showed, the window "clicks and clacks" as it grows, "immediately changing height and
then moving there"; "the animation is super clunky". The overlay window was resized to every height
the chat measured (`fitChat`), and a window resized while it shows keeps its last frame, drawn from
its new top-left corner, until the page draws one at the new size: the chat, held at the edge by
the pill, showed a frame out of place on every new line. The overlay now stays at the chat's
tallest size (`chatMaxHeight`) while the chat is open, and the page grows the chat in it to what it
shows, over `chatGrowDurationSeconds`, its edge by the pill staying put. Only the chat as measured,
with its shadow and the pill's strip, takes clicks, as the window that size did: on macOS and
Windows the window lets clicks through but still passes the pointer's moves to the page, which says
on each move whether the pointer is over the chat or the pill's bubbles (`chatPointer`), and the
overlay takes clicks only then; Linux windows get no moves while letting clicks through, so there
the overlay is cut to the chat's shape (`setShape`) instead (`ChatHitTest`). Placed afresh
(`refreshPlacement`), it lets clicks through until the page's next move, unless the resting pointer
is already over the chat as first measured (`fitChat`), so a click with no move since still reaches it.

*Amendment (2026-10-10): on Linux the overlay takes clicks over its whole frame while the chat window
or the note shows, not cut to a shape.* On Ubuntu's X11 (Xwayland) an empty shape is no window at all,
not the whole window as Electron documents it, so every pill after the first chat window or note showed
nothing; and any `setShape` on the transparent overlay crashed Xwayland in the VM, taking every X11
window, the app's among them, with it (reproduced with a bare Electron window). Nor can the app look
where the pointer is: an X11 client learns of the pointer only over its own windows, and the overlay
letting clicks through is not one (VM, 2026-10-10: polled every 50 ms, the pointer brought onto the
chat from a GNOME Text Editor window was never seen, and the click went through). So while the chat
window or the not-pasted note shows, the whole overlay takes clicks (`ChatHitTest` "frame"); from the
moment they close (while the closed chat shrinks into its pill too) it lets them through again. macOS
and Windows keep the page's pointer moves. Trade-off: while either shows, a click on the overlay's
transparent part beside it (at most the chat's tallest frame, `chatMaxHeight`, or the pill's canvas)
does not reach the app under it.

**Amendment 2026-10-05: one bubble runs, the first in the row.** Owner: with Answer running, a
calendar tool's bubble "shows up on the left but it's not spinning". "The only one that circles is the
one on the far left, and the only one that's enlarged". When the calendar result is back, "the answer
tool just goes to the left again at the front and then circles". In the log, `calendar_read` ran for
17 ms. Its bubble moved to the front and circled too briefly to see, and then stayed in front while
Answer, which also circled, went on behind it.

- `DictationController.runningBubble` replaces `runningConnectors` in `OverlayState`. It is the app
  whose tool started last, while it runs (a `ConnectorTool`, or the web's search on the backend), and
  otherwise the tool agent mode runs (`running(tool)`).
- When an app's tool ends, the bubble still running (the answer) moves back to the front of the history
  (`ranNow`). The running bubble is therefore always first in the row.
- The overlay circles and enlarges only that bubble. Every other bubble, the answer an app runs for
  included, is at rest size and faded (`agentBubbleIdleOpacity`). The pill still circles while agent
  mode works.
- `bubbleOrder`, the row's places and the history kept for the app's run are unchanged.
- The history now ends with the answer first after a request whose apps ran ("answer, web, calendar"),
  where it used to end "web, calendar, answer".
- A tool shorter than a frame still never visibly circles. The bubble no longer stays in front once its
  tool has finished.


> **Amended (owner, 2026-10-09): the chat window grows out of its pill and shrinks back into it.**
> The owner: opening, *"it should also seem like it's growing out of the pill"*; closing (a write
> that ends a request, a timeout, the x), *"go get smaller and disappear … the reverse animation so
> that it looks like it's getting sucked back into the agent pill"*. So the chat window opens from
> `chatPillScale` about the pill's center (its `transform-origin`, from where the pill's layer puts
> it, over the chat or under it) to full size, fading in on the pill's spring
> (`chatOpenDurationSeconds`), in place of rising `chatAppearRise` from `chatAppearScale` (both
> gone). Closing, the page draws the last chat shrinking back to that point, fading out
> (`chatCloseDurationSeconds`): the overlay keeps the chat's frame meanwhile (`shrinkChat`), letting
> every click through, then leaves it as before (transparent while the page draws it away), for the
> phase of that moment. A follow-up meanwhile keeps it open where it was. A chat never shown (not
> yet measured) closes at once.
>
> Tests: `overlay/index.test.ts` (the chat's origin at the pill's center over it and under it; it
> grows from it, and its last chat stays drawn, shrinking into it, while placed), `overlayWindow.test.ts`
> (the overlay keeps the chat's frame, opaque and click-through, for the close's length, then leaves
> it; a follow-up during it keeps it open, taking clicks again), each red-verified against the
> instant close.

> **Amended (owner, 2026-10-19): memory has a bubble.** The owner: *"for the memory tool … we don't
> seem to have a memory tool icon, like the bubble, like the other tools"*. The memory tools
> (ADR-DESK-061) ran under no bubble. They now have one, `memoryBubble` ("Memory", with Settings'
> memory icon, a clock with an arrow going back, in the bubbles' accent; its tooltip
> `memoryBubbleDescription`). It shows whenever a tool's bubble does (`shownBubbles`), since the
> memory tools come with every request that offers one (`loopTools`), and has no switch in Settings.
> It runs as an app's does while a memory tool runs, at the front of the row, and stops with it; the
> chat window's label for a memory search is unchanged.
>
> Tests: `bubbleOrder.test.ts` (memory's name and description; it shows with the tools' bubbles and
> never alone; it sorts with them), `controller.test.ts` (it runs while `memory_search` does, moving to
> the front, and stops before Answer's bubble runs for the reply), `overlay/index.test.ts` (its icon and
> tooltip; it circles alone at the front while running; none without tools), each red-verified against
> the bubble left out.

