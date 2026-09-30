// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { connectorIDs } from "../../../src/core/agent/connectors/registry.js";
import { agentToolIDs } from "../../../src/core/agent/tools.js";
import * as config from "../../../src/core/config.js";
import {
  bubbleRow,
  bubbleRowOpacity,
  bubblesFitUnder,
  bubbleTooltipCentre,
  chatSide,
  chatWindowFrame,
  grownBubble,
  hintCentre,
  hintCentreOver,
  maxX,
  maxY,
  midX,
  opensUpward,
  overlayOrigin,
  type Point,
  pillPosition,
  type Rect,
  type Size,
  tipGoesAbove,
  underBubbles,
} from "../../../src/core/ui/overlayGeometry.js";
import { type DictationTip, tipDetails, tipLines } from "../../../src/core/onboarding/tips.js";

const canvas = { width: 200, height: 60 };
const pillHeight = 30;
const display: Rect = { x: 0, y: 0, width: 1000, height: 800 };

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < maxX(b) && b.x < maxX(a) && a.y < maxY(b) && b.y < maxY(a);
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && maxX(inner) <= maxX(outer) && maxY(inner) <= maxY(outer);
}

function framed(centre: Point, size: Size): Rect {
  return rect(centre.x - size.width / 2, centre.y - size.height / 2, size.width, size.height);
}

/** Where the pill itself lands: centred vertically in the canvas (one line tall). */
function pillFrame(origin: Point): Rect {
  return rect(origin.x, origin.y + (canvas.height - pillHeight) / 2, canvas.width, pillHeight);
}

const allTips = Object.keys(tipDetails) as DictationTip[];

/** The tip as the overlay draws it: its arrow and box, as wide as allowed. */
const tip: Size = { width: 2 * 150, height: config.tipArrowHeight + config.tipHeight };

/** Where the overlay sits: at the caret, the tip under it and the bubbles above, in top-left screen
 * coordinates as Electron and the helper's Accessibility rects give them. */

describe("overlay geometry", () => {
  /** The pill's top edge sits exactly the configured gap below the caret's line: not the transparent
   * canvas's edge, which would leave the pill visibly lower. */
  test("the pill sits just below the caret line", () => {
    const caret = rect(500, 380, 1, 20);
    const origin = overlayOrigin(caret, canvas, pillHeight, display);
    expect(origin.x).toBe(midX(caret) - canvas.width / 2);
    expect(pillFrame(origin).y).toBe(maxY(caret) + config.overlayCaretGap);
  });

  /** A caret too low for the pill and a tip under it, but high enough that no lowering is needed to
   * keep the pill on screen above it. */
  test("moves above the caret when there is no room below", () => {
    const caret = rect(500, maxY(display) - config.listeningPillHeight - config.tipFootprint - 20, 1, 20);
    const origin = overlayOrigin(caret, canvas, pillHeight, display);
    expect(maxY(pillFrame(origin))).toBe(caret.y - config.overlayCaretGap);
    expect(opensUpward(caret, pillHeight, display)).toBe(true);
    expect(opensUpward(rect(500, 380, 1, 20), pillHeight, display)).toBe(false);
  });

  /** With the caret near the bottom of the display, on a short or a tall line, the tip under the
   * listening pill is always on screen and the pill never covers the line; the overlay opens above
   * the caret's line only when the tip would not fit under a pill opened below it. For a display
   * whose work area starts at 0, one shortened by the Dock, and a display below the main one. */
  test("the tip under the listening pill is always on screen", () => {
    const canvas = config.overlayCanvasSize;
    const pill: Size = { width: 120, height: config.listeningPillHeight };
    const tipBottom = maxY(framed(hintCentre(rect(0, 0, pill.width, pill.height), tip), tip));
    let openedBelow = 0;
    let openedAbove = 0;
    const displays = [display, rect(0, 0, 1000, 730), rect(0, 800, 1000, 800)];
    for (const area of displays) {
      for (const lineHeight of [14, 16, 20]) {
        for (let bottom = maxY(area); bottom >= maxY(area) - 150; bottom -= 1) {
          const caret = rect(500, bottom - lineHeight, 1, lineHeight);
          const origin = overlayOrigin(caret, canvas, config.pillHeight, area);
          const pillTop = origin.y + (canvas.height - config.pillHeight) / 2;
          expect(pillTop + tipBottom, `tip off screen for a ${lineHeight} pt line at ${bottom}`).toBeLessThanOrEqual(maxY(area));
          const drawnPill = rect(origin.x + (canvas.width - pill.width) / 2, pillTop, pill.width, pill.height);
          expect(intersects(drawnPill, caret), `pill covers a ${lineHeight} pt line at ${bottom}`).toBe(false);
          if (pillTop >= maxY(caret)) {
            openedBelow += 1;
          } else {
            openedAbove += 1;
            expect(maxY(caret) + config.overlayCaretGap + tipBottom, `opened above a ${lineHeight} pt line at ${bottom} with room below`).toBeGreaterThan(maxY(area));
          }
        }
      }
    }
    expect(openedBelow).toBeGreaterThan(0);
    expect(openedAbove).toBeGreaterThan(0);
  });

  test("the pill stays on screen at the edges", () => {
    for (const caret of [rect(2, 380, 1, 20), rect(998, -10, 1, 20)]) {
      expect(contains(display, pillFrame(overlayOrigin(caret, canvas, pillHeight, display)))).toBe(true);
    }
  });

  /** Agent mode's bubbles in one row under the pill (over it when they don't fit under it), for the
   * listening pill and the circle it shrinks to, with no bubbles (dictation) up to more than ever
   * show: the first `agentBubbleRowVisibleCount` centred on the pill, the rest going on to the right,
   * all level, a gap apart and clear of the pill, and every one that shows inside the canvas. The tip
   * goes under the pill and any bubbles under it, overlapping none, inside the canvas with its
   * shadow. */
  test.each([true, false])("bubbles go in a row under the pill and the tip under them (under fits: %s)", (underFits) => {
    const area = rect(0, 0, config.overlayCanvasSize.width, config.overlayCanvasSize.height);
    const bubble: Size = { width: config.agentBubbleDiameter, height: config.agentBubbleDiameter };
    const shadow = config.tipShadowRadius + config.tipShadowOffsetY;
    const visible = config.agentBubbleRowVisibleCount;
    const showing = visible + config.agentBubbleRowFadeCount;
    for (const size of [{ width: 120, height: config.listeningPillHeight }, { width: config.pillHeight, height: config.pillHeight }]) {
      const pill = rect(midX(area) - size.width / 2, (area.height - config.pillHeight) / 2, size.width, size.height);
      for (let count = 0; count <= agentToolIDs.length + connectorIDs.length; count += 1) {
        const frames = bubbleRow(pill, count, underFits).map((centre) => framed(centre, bubble));
        expect(frames).toHaveLength(count);
        const tipFrame = framed(hintCentre(underBubbles(pill, frames), tip), tip);
        expect(tipFrame.y).toBeGreaterThanOrEqual(maxY(pill));
        expect(Math.abs(midX(tipFrame) - midX(pill))).toBeLessThan(0.001);
        expect(contains(area, rect(tipFrame.x - shadow, tipFrame.y - shadow, tipFrame.width + 2 * shadow, tipFrame.height + 2 * shadow)), `tip outside the canvas (${count})`).toBe(true);
        frames.forEach((frame, index) => {
          if (underFits) expect(frame.y, `bubble ${index} of ${count} is not under the pill`).toBeCloseTo(maxY(pill) + config.agentBubbleGap);
          else expect(maxY(frame), `bubble ${index} of ${count} is not over the pill`).toBeCloseTo(pill.y - config.agentBubbleGap);
          expect(intersects(frame, tipFrame), `bubble ${index} of ${count} overlaps the tip`).toBe(false);
          if (index < showing) expect(contains(area, frame), `bubble ${index} of ${count} outside the canvas`).toBe(true);
          const next = frames[index + 1];
          if (next) expect(next.x - maxX(frame), `bubbles ${index} and ${index + 1} of ${count} not a gap apart`).toBeCloseTo(config.agentBubbleSpacing);
          // Grown as it runs, still clear of the pill.
          expect(intersects(grownBubble(frame, config.agentBubbleRunningScale), pill), `bubble ${index} of ${count} grown over the pill`).toBe(false);
        });
        // The first few centred on the pill.
        const first = frames[0];
        const lastVisible = frames[Math.min(count, visible) - 1];
        if (count >= visible && first && lastVisible) expect((first.x + maxX(lastVisible)) / 2, `row not centred on the pill (${count})`).toBeCloseTo(midX(pill));
      }
    }
  });

  /** Neighbouring bubbles both running (an app's tool and the answer), each grown, stay apart; at rest
   * a bubble is smaller than the pill (owner, 2026-09-28). */
  test("running neighbours don't touch", () => {
    const pill = rect(100, 100, 120, config.listeningPillHeight);
    const [first, second] = bubbleRow(pill, 2, true).map((centre) => grownBubble(framed(centre, { width: config.agentBubbleDiameter, height: config.agentBubbleDiameter }), config.agentBubbleRunningScale));
    if (!first || !second) throw new Error("no row");
    expect(second.x - maxX(first)).toBeGreaterThan(0);
    expect(config.agentBubbleDiameter).toBeLessThan(config.pillHeight);
  });

  /** The first few bubbles show in full, the next ones less and less, fading away to the right, and
   * none after them. */
  test("the row fades away to the right", () => {
    const visible = config.agentBubbleRowVisibleCount;
    const showing = visible + config.agentBubbleRowFadeCount;
    const opacities = Array.from({ length: showing + 3 }, (_, index) => bubbleRowOpacity(index));
    expect(opacities.slice(0, visible)).toEqual(Array<number>(visible).fill(1));
    for (let index = visible; index < showing; index += 1) {
      expect(opacities[index], `bubble ${index}`).toBeGreaterThan(0);
      expect(opacities[index], `bubble ${index}`).toBeLessThan(opacities[index - 1] ?? 0);
    }
    expect(opacities.slice(showing)).toEqual([0, 0, 0]);
  });

  /** Bubbles go under the pill only when it sits below the caret's line with room under it for their
   * row and the tip; a pill that opened above the line, or one with too little room under it, gets
   * them over it. */
  test("bubbles go under the pill only when they fit below the caret's line", () => {
    const row = config.agentBubbleGap + config.agentBubbleDiameter;
    const room = config.overlayCaretGap + Math.max(config.pillHeight, config.listeningPillHeight) + config.tipFootprint + row;
    const caret = (bottom: number) => rect(500, bottom - 20, 1, 20);

    expect(bubblesFitUnder(caret(400), config.pillHeight, display)).toBe(true);
    expect(bubblesFitUnder(caret(maxY(display) - room), config.pillHeight, display)).toBe(true);
    expect(bubblesFitUnder(caret(maxY(display) - room + 1), config.pillHeight, display)).toBe(false);
    expect(opensUpward(caret(maxY(display) - room + 1), config.pillHeight, display)).toBe(false);
    expect(bubblesFitUnder(caret(maxY(display) - 10), config.pillHeight, display)).toBe(false);
    expect(opensUpward(caret(maxY(display) - 10), config.pillHeight, display)).toBe(true);
  });

  /** Only a tip that stays up while listening goes over the pill, and only in an overlay opened
   * above the caret's line: the hands-free tip (owner, 2026-09-27). Timed tips stay under the pill. */
  test.each(allTips.flatMap((name) => [false, true].map((upward) => [name, upward] as const)))("only the hands-free tip goes over the pill, only when opened upward (%s, %s)", (name, upward) => {
    expect(tipGoesAbove(tipDetails[name].displayDuration, upward)).toBe(upward && name === "handsFree");
  });

  /** A tip over the pill: centred over it, clear of the pill and of agent mode's bubbles, overlapping
   * neither, and inside the canvas with its shadow. For the listening pill and the circle it shrinks
   * to, with no bubbles and as many as are ever offered, in an overlay opened above the caret's line,
   * where none fits under the pill (`bubblesFitUnder`). */
  test("a tip over the pill clears the bubbles and stays in the canvas", () => {
    const area = rect(0, 0, config.overlayCanvasSize.width, config.overlayCanvasSize.height);
    const bubble: Size = { width: config.agentBubbleDiameter, height: config.agentBubbleDiameter };
    const shadow = config.tipShadowRadius + config.tipShadowOffsetY;
    for (const size of [{ width: 120, height: config.listeningPillHeight }, { width: config.pillHeight, height: config.pillHeight }]) {
      const pill = rect(midX(area) - size.width / 2, (area.height - config.pillHeight) / 2, size.width, size.height);
      for (let count = 0; count <= config.agentBubbleRowVisibleCount + config.agentBubbleRowFadeCount; count += 1) {
        const bubbles = bubbleRow(pill, count, false).map((centre) => framed(centre, bubble));
        const tipFrame = framed(hintCentreOver(pill, bubbles, tip), tip);
        expect(maxY(tipFrame), `not over the pill (${count} bubbles)`).toBeLessThanOrEqual(pill.y);
        expect(Math.abs(midX(tipFrame) - midX(pill))).toBeLessThan(0.001);
        for (const frame of bubbles) expect(maxY(tipFrame), `not over the bubbles (${count})`).toBeLessThanOrEqual(frame.y);
        expect(contains(area, rect(tipFrame.x - shadow, tipFrame.y - shadow, tipFrame.width + 2 * shadow, tipFrame.height + 2 * shadow)), `leaves the canvas over ${count} bubbles`).toBe(true);
      }
    }
  });

  /** A bubble grows about its centre, as the page scales it (`transform-origin: center`): same centre,
   * `scale` times the size. */
  test("a grown bubble keeps its centre", () => {
    expect(grownBubble(rect(100, 50, 40, 40), 1.5)).toEqual(rect(90, 40, 60, 60));
    expect(grownBubble(rect(100, 50, 40, 40), 1)).toEqual(rect(100, 50, 40, 40));
  });

  /** The hovered bubble's tooltip, as wide as it gets and taller than its longest description wraps, for every bubble as many are
   * ever offered, grown as hovered or running, whether bubbles fit under the pill or not: over the
   * bubble when there is room, else under it; clear of it by `bubbleTooltipGap` and never over it;
   * centred on it unless that would leave the canvas, and always inside the canvas. */
  test.each([true, false])("a bubble's tooltip clears it and stays in the canvas (under fits: %s)", (underFits) => {
    const area = rect(0, 0, config.overlayCanvasSize.width, config.overlayCanvasSize.height);
    const bubble: Size = { width: config.agentBubbleDiameter, height: config.agentBubbleDiameter };
    const tooltip: Size = { width: config.bubbleTooltipMaxWidth, height: 130 };
    const pill = rect(midX(area) - 60, (area.height - config.pillHeight) / 2, 120, config.listeningPillHeight);
    const frames = bubbleRow(pill, config.agentBubbleRowVisibleCount + config.agentBubbleRowFadeCount, underFits).map((centre) => framed(centre, bubble));
    for (const scale of [config.agentBubbleHoverScale, config.agentBubbleRunningScale]) {
      for (const [index, frame] of frames.entries()) {
        const grown = grownBubble(frame, scale);
        const tooltipFrame = framed(bubbleTooltipCentre(grown, tooltip, config.overlayCanvasSize), tooltip);
        const roomOver = grown.y - config.bubbleTooltipGap - tooltip.height >= 0;
        if (roomOver) {
          expect(maxY(tooltipFrame), `bubble ${index} at ${scale}`).toBeCloseTo(grown.y - config.bubbleTooltipGap);
        } else {
          expect(tooltipFrame.y, `bubble ${index} at ${scale}`).toBeCloseTo(maxY(grown) + config.bubbleTooltipGap);
        }
        expect(intersects(tooltipFrame, grown), `bubble ${index} at ${scale} covered`).toBe(false);
        expect(contains(area, tooltipFrame), `bubble ${index} at ${scale}: tooltip outside the canvas`).toBe(true);
        // Centred on it, unless that would leave the canvas.
        const centre = Math.min(Math.max(midX(grown), tooltip.width / 2), area.width - tooltip.width / 2);
        expect(Math.abs(midX(tooltipFrame) - centre), `bubble ${index} at ${scale} off centre`).toBeLessThan(0.001);
      }
    }
  });

  /** A bubble nearer an edge of the canvas than half its tooltip's width gets the tooltip moved in to
   * that edge, still clear of the bubble. */
  test("a tooltip by an edge of the canvas moves in", () => {
    const tooltip: Size = { width: config.bubbleTooltipMaxWidth, height: 90 };
    const canvasSize = config.overlayCanvasSize;
    const left = framed(bubbleTooltipCentre(rect(10, 200, 30, 30), tooltip, canvasSize), tooltip);
    const right = framed(bubbleTooltipCentre(rect(canvasSize.width - 40, 200, 30, 30), tooltip, canvasSize), tooltip);
    expect([left.x, maxY(left)]).toEqual([0, 200 - config.bubbleTooltipGap]);
    expect([maxX(right), maxY(right)]).toEqual([canvasSize.width, 200 - config.bubbleTooltipGap]);
  });

  /** Over the bubble while the tooltip fits over it exactly, under it a point short of that. */
  test("a tooltip goes under its bubble only without room over it", () => {
    const tooltip: Size = { width: 100, height: 90 };
    const fits = config.bubbleTooltipGap + tooltip.height;
    const over = framed(bubbleTooltipCentre(rect(200, fits, 30, 30), tooltip, config.overlayCanvasSize), tooltip);
    const under = framed(bubbleTooltipCentre(rect(200, fits - 1, 30, 30), tooltip, config.overlayCanvasSize), tooltip);
    expect(over.y).toBe(0);
    expect(under.y).toBe(fits - 1 + 30 + config.bubbleTooltipGap);
  });

  /** The tip's room beside the pill is its gap, arrow and box, in `tipLineCount` lines, the most any
   * tip has; a tip of fewer lines has a shorter box. */
  test("the tip takes the room left for it", () => {
    expect(config.tipFootprint).toBe(config.tipGap + tip.height);
    for (const name of allTips) {
      for (const hotkey of ["rightOption", "function"] as const) expect(tipLines(name, hotkey).length).toBeLessThanOrEqual(config.tipLineCount);
    }
    expect(config.tipBoxHeight(2)).toBe(config.tipHeight - config.tipLineHeight - config.tipLineSpacing);
  });
});

describe("the chat window's place", () => {
  const margin = config.chatShadowMargin;
  const row = config.agentBubbleGap + config.agentBubbleDiameter;
  const tallest = { maxHeight: config.chatMaxHeight };

  /** The chat itself in the overlay window's frame `frame`, `height` tall, over the pill and its
   * bubbles or under them (`below`). */
  function content(frame: Rect, height: number, below: boolean): Rect {
    const y = below ? maxY(frame) - margin - height : frame.y + margin;
    return rect(frame.x + margin, y, frame.width - 2 * margin, height);
  }

  /** The pill stays where the overlay placed it for the caret: its top edge's centre. */
  test("the pill is where the overlay put it", () => {
    for (const caret of [rect(500, 180, 1, 20), rect(500, 780, 1, 20), rect(2, 180, 1, 20)]) {
      const origin = overlayOrigin(caret, config.overlayCanvasSize, config.pillHeight, display);
      expect(pillPosition(caret, display)).toEqual({ x: origin.x + config.overlayCanvasSize.width / 2, y: origin.y + (config.overlayCanvasSize.height - config.pillHeight) / 2 });
    }
  });

  /** Over the pill and its bubbles, `chatPillGap` clear of them, as it grows; the window's bottom edge
   * (and so the pill in it) stays put. Over the bubbles too when they go over the pill. */
  test.each([true, false])("the chat window opens over the pill, which stays put (bubbles under: %s)", (bubblesUnder) => {
    const pill = { x: 500, y: 500 };
    const top = bubblesUnder ? pill.y : pill.y - row;
    const bottoms = new Set<number>();
    for (const height of [40, 120, config.chatMaxHeight]) {
      const frame = chatWindowFrame(pill, height, display, { below: false, ...tallest }, bubblesUnder);
      expect(maxY(content(frame, height, false)), `${height}`).toBe(top - config.chatPillGap);
      expect(frame.height).toBe(2 * margin + height + config.chatPillGap + config.chatStripHeight);
      expect(frame.width).toBe(config.chatWidth + 2 * margin);
      expect(midX(frame)).toBe(pill.x);
      bottoms.add(maxY(frame));
    }
    expect([...bottoms]).toEqual([top + config.chatStripHeight + margin]);
  });

  /** Under the pill and its bubbles when there is no room over them for the tallest window, the
   * window's top edge staying put as it grows; exactly enough room keeps it over them. */
  test.each([true, false])("the chat window opens under the pill without room over it (bubbles under: %s)", (bubblesUnder) => {
    const top = bubblesUnder ? 0 : row;
    const lowest = display.y + config.chatPillGap + config.chatMaxHeight + top;
    expect(chatSide(lowest, bubblesUnder, display)).toEqual({ below: false, ...tallest });
    expect(chatSide(lowest - 1, bubblesUnder, display)).toEqual({ below: true, ...tallest });
    const pill = { x: 500, y: 40 + top };
    for (const height of [40, config.chatMaxHeight]) {
      const frame = chatWindowFrame(pill, height, display, { below: true, ...tallest }, bubblesUnder);
      expect(frame.y).toBe(40 - margin);
      expect(content(frame, height, true).y).toBe(40 + config.chatStripHeight + config.chatPillGap);
    }
  });

  /** A long conversation scrolls inside the window rather than growing it past its maximum height. */
  test("the chat window is at most its maximum height", () => {
    const over = { below: false, ...tallest };
    expect(chatWindowFrame({ x: 500, y: 500 }, 5_000, display, over, true).height).toBe(chatWindowFrame({ x: 500, y: 500 }, config.chatMaxHeight, display, over, true).height);
  });

  /** On a screen too short for the tallest chat on either side of the pill, it goes on the side with
   * more room and grows no taller than that room, scrolling instead, so it stays on screen whole: its
   * newest lines and a question's buttons are never off the bottom. */
  test.each([true, false])("the chat window stays on a short screen, wherever the pill is (bubbles under: %s)", (bubblesUnder) => {
    const short: Rect = { x: 0, y: 25, width: 1000, height: 540 };
    const tops = new Set<boolean>();
    for (let pillTop = short.y + 60; pillTop <= maxY(short) - 120; pillTop += 20) {
      const side = chatSide(pillTop, bubblesUnder, short);
      tops.add(side.below);
      expect(side.maxHeight, `${pillTop}`).toBeLessThanOrEqual(config.chatMaxHeight);
      const frame = chatWindowFrame({ x: 500, y: pillTop }, 5_000, short, side, bubblesUnder);
      const chat = content(frame, side.maxHeight, side.below);
      expect(contains(short, chat), `${pillTop}: ${JSON.stringify(chat)}`).toBe(true);
    }
    // Both sides are used over the sweep, and the room the pill leaves is used, not wasted.
    expect([...tops].sort()).toEqual([false, true]);
    const middle = chatSide(short.y + short.height / 2, bubblesUnder, short);
    expect(middle.maxHeight).toBeGreaterThan(config.chatMaxHeight / 2);
  });

  /** With room for the tallest chat on neither side, the side with more room wins, over the pill as
   * much as under it. */
  test.each([true, false])("without room for the tallest chat either side, it takes the roomier (bubbles under: %s)", (bubblesUnder) => {
    const short: Rect = { x: 0, y: 25, width: 1000, height: 540 };
    const room = config.chatMaxHeight - 20;
    const top = bubblesUnder ? 0 : config.agentBubbleGap + config.agentBubbleDiameter;
    // `room` over the pill and its bubbles, less under them; then `room` under them, less over.
    const low = short.y + config.chatPillGap + room + top;
    const lowSide = chatSide(low, bubblesUnder, short);
    expect(lowSide).toEqual({ below: false, maxHeight: room });
    const high = maxY(short) - room - config.chatPillGap - config.chatStripHeight + top;
    const highSide = chatSide(high, bubblesUnder, short);
    expect(highSide).toEqual({ below: true, maxHeight: room });
    // The other side had room too, only less: each time neither side fits the tallest.
    const under = maxY(short) - (low - top + config.chatStripHeight + config.chatPillGap);
    const over = high - top - config.chatPillGap - short.y;
    expect(under).toBeGreaterThan(0);
    expect(under).toBeLessThan(room);
    expect(over).toBeGreaterThan(0);
    expect(over).toBeLessThan(room);
  });

  /** A pill at a screen edge keeps the chat on screen; only its shadow margin may spill. */
  test.each([2, 998])("the chat window stays on screen with the pill at x %d", (x) => {
    const frame = chatWindowFrame({ x, y: 500 }, 120, display, { below: false, ...tallest }, true);
    expect(contains(display, content(frame, 120, false))).toBe(true);
  });
});
