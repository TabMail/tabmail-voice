## ADR-DESK-034: A bubble under the pointer grows and says what it is

> ⚠️ **Amended by ADR-DESK-036 (owner 2026-09-28):** bubbles grow about their center, not up from
> their bottom edge, to fixed sizes (`agentBubbleHoverDiameter`, `agentBubbleRunningDiameter`), from
> a smaller size at rest.

**Context:** Owner, 2026-09-28: "for the tools, when mouse hovers over them, make them sort of
enlarged and also show tooltips on what this tool is. Sort of something that you can even inspect."
The overlay lets every click through (ADR-DESK-022) until the chat window opens, so the page saw no
pointer at all.

**Decision:**
- The overlay window ignores the mouse with `forward: true` (`Windows.overlay`, and again as the
  chat window closes): clicks still pass through to the app under it, but the pointer's moves reach
  the page, which is all a hover needs. The window stays unfocusable, so hovering takes no focus.
- A bubble under the pointer (a tool's or an app's, ADR-DESK-033) grows to `agentBubbleHoverScale`
  upward from its bottom edge, as a running one does (a running one keeps its own, larger scale), and
  shows in full even while faded for another tool's run.
- Its tooltip names it and says what it does, in the words Settings uses (`settingsDescription`),
  drawn as the tips are. It goes over the bubble as grown (`grownBubble`), `bubbleTooltipGap` clear,
  or under it when the canvas has no room over it, moved in from the canvas's edge when centering
  would leave it (`bubbleTooltipCenter`); it is hidden until measured and lets the pointer through,
  so it never takes the hover from the bubble under it.

**Consequences:**
- Hovering needs no click and moves no focus, so it works mid-hold without disturbing the dictation.
- Electron forwards the pointer's moves on macOS and Windows only: on Linux the bubbles show no
  hover. On Windows forwarding is a system-wide low-level mouse hook, kept while the overlay is
  hidden, and Electron has open reports of forwarding making the cursor or other windows flicker
  there (electron#35030, #35414, #48035); worth forwarding only while the overlay shows once the
  Windows helpers exist.
- The hover follows the bubbles: one that goes (Space back to dictation) takes its hover with it, and
  each bubble's tooltip is measured afresh, never shown at the last one's size.
- A tooltip can cover other bubbles, the pill or a tip while it shows; it is drawn over them.

