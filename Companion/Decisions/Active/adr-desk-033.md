## ADR-DESK-033: The bubbles surround the pill, one for each app Answer reaches

> ⚠️ **Placement SUPERSEDED by ADR-DESK-036 (owner 2026-09-28):** one row under the pill (over it
> without room), four at most, the latest to run first, replaces the rows around it
> (`bubbleCenters`, `agentBubbleRowCapacity`, `agentBubbleRowsAbove`). An app's bubble now circles
> while its tools run. One bubble per tool and per connector switched on stands.

**Context:** Owner, 2026-09-26: "many bubbles surround the pill": the single row above the pill fills
first, then the bubbles wrap around the pill's sides and underneath, keeping clear of the caret's
line. Owner, 2026-09-27: each connector switched on gets its own bubble ("Connector bubbles"). First
built in the Swift app (its ADR-DESK-031 there, on the unmerged agent-tool branch); built here in the
Electron app (ADR-DESK-032), numbered 033 as 031 is the Globe key's.

**Decision:**
- Beside the tools' bubbles (`DictationController.tools`), agent mode shows one for each connector
  (`DictationController.connectors`) switched on at key-down whose tools this computer has, while
  Answer, whose loop runs them, is offered; with Answer off, none. The connector's icon, never drawn
  as running (its tools' progress shows in the chat window, ADR-DESK-023); it fades while a tool
  runs, as the idle tools' bubbles do. One `Bubble` draws both.
- `bubbleCenters(pill, sizes, underFits)` places them in order: a row of up to
  `agentBubbleRowCapacity` (5) centered over the pill (with no more bubbles than that, the row as
  before); then one beside the pill on the left and one on the right; then rows under the pill. When
  they don't fit under it (`bubblesFitUnder`: the pill opened above the caret's line, or sits too near
  the work area's bottom for a row and the tip under it), the later rows go over the first instead,
  so none covers a caret's line under the pill. The overlay window works this out as it places the
  pill, and the view is told (`OverlayState.bubblesFitUnder`).
- A tip under the pill goes under any bubbles under it (`underBubbles`); the hands-free tip over the
  pill (ADR-DESK-021's amendment) goes over them all, as before. The canvas grew to room for two
  rows and a tip over the pill (`agentBubbleRowsAbove`), the pill still centered in it.

**Consequences:**
- With every tool offered at once (three) and every connector (eight since Shortcuts was retired,
  ADR-DESK-029; nine before) on, eleven bubbles: five over, two beside, four under (or a second row
  over).
- A pill below the caret still has its first row over the caret's line, as before; only the rows
  after it keep clear of it.
- A thirteenth bubble (two more connectors) would start a third row: the geometry test, which places up to
  every tool and connector, checks they stay inside the canvas.

**Amendment 2026-10-27:** Answer is always offered (ADR-DESK-022 amendment of that date), so the
connectors' bubbles show whenever the tools are known; "with Answer off, none" no longer arises.
