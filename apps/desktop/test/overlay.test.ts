// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { connectors } from "../src/core/agent/connectors.js";
import { agentTools } from "../src/core/agent/tools.js";
import * as config from "../src/core/config.js";
import type { Phase } from "../src/core/dictationController.js";
import { type MenuState, showsDictationButton, statusLine } from "../src/core/menuModel.js";
import { bubbleCentres, bubblesFitUnder, chatFrame, chatOpensUpward, hintCentre, hintCentreOver, maxX, maxY, midX, opensUpward, overlayOrigin, type Point, type Rect, type Size, tipGoesAbove, underBubbles } from "../src/core/overlayGeometry.js";
import { type DictationTip, tipDetails, tipKeycap, tipLines, tipParts } from "../src/core/tips.js";

const canvas = { width: 200, height: 60 };
const pillHeight = 30;
const display: Rect = { x: 0, y: 0, width: 1000, height: 800 };

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < maxX(b) && b.x < maxX(a) && a.y < maxY(b) && b.y < maxY(a);
}

/** How far apart two rects are: the widest gap between them along either axis (negative when they overlap). */
function apart(a: Rect, b: Rect): number {
  return Math.max(b.x - maxX(a), a.x - maxX(b), b.y - maxY(a), a.y - maxY(b));
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

  /** Agent mode's bubbles and a tip under the pill, in the overlay's canvas, for the listening pill
   * and the circle it shrinks to, with no bubbles (dictation) up to as many as are ever offered (the
   * tools but one, as Edit and Compose never show together, and every connector): a row centred over
   * the pill fills first, then one bubble beside it on the left and one on the right, then rows under
   * it, or, with no room under it, over the first row, so none covers a caret's line under a pill
   * that opened above it. None overlaps the pill, another bubble or the tip, which goes under the pill
   * and any bubbles under it; everything, the tip's shadow included, stays inside the canvas. With them
   * all, five over, two beside and five under (or a second five over). Past that many (a connector
   * yet to come) the rows keep stacking without overlapping, though the canvas has no room for them. */
  test.each([true, false])("bubbles surround the pill and the tip goes under them (under fits: %s)", (underFits) => {
    const area = rect(0, 0, config.overlayCanvasSize.width, config.overlayCanvasSize.height);
    const bubble: Size = { width: config.agentBubbleDiameter, height: config.agentBubbleDiameter };
    const shadow = config.tipShadowRadius + config.tipShadowOffsetY;
    const capacity = config.agentBubbleRowCapacity;
    const most = agentTools.length - 1 + connectors.length;
    let under = 0;
    for (const size of [{ width: 120, height: config.listeningPillHeight }, { width: config.pillHeight, height: config.pillHeight }]) {
      const pill = rect(midX(area) - size.width / 2, (area.height - config.pillHeight) / 2, size.width, size.height);
      for (let count = 0; count <= most + 2 * capacity; count += 1) {
        const frames = bubbleCentres(pill, Array<Size>(count).fill(bubble), underFits).map((centre) => framed(centre, bubble));
        expect(frames).toHaveLength(count);
        const fits = count <= most;
        const tipFrame = framed(hintCentre(underBubbles(pill, frames), tip), tip);
        expect(tipFrame.y).toBeGreaterThanOrEqual(maxY(pill));
        expect(Math.abs(midX(tipFrame) - midX(pill))).toBeLessThan(0.001);
        if (fits) expect(contains(area, rect(tipFrame.x - shadow, tipFrame.y - shadow, tipFrame.width + 2 * shadow, tipFrame.height + 2 * shadow)), `tip outside the canvas (${count})`).toBe(true);
        frames.forEach((frame, index) => {
          expect(intersects(frame, pill), `bubble ${index} of ${count} overlaps the pill`).toBe(false);
          expect(apart(frame, pill), `bubble ${index} of ${count} too near the pill`).toBeGreaterThanOrEqual(config.agentBubbleGap - 0.001);
          expect(intersects(frame, tipFrame), `bubble ${index} of ${count} overlaps the tip`).toBe(false);
          if (fits) expect(contains(area, frame), `bubble ${index} of ${count} outside the canvas`).toBe(true);
          for (const other of frames.slice(index + 1)) {
            expect(intersects(frame, other), `bubbles overlap (${count})`).toBe(false);
            expect(apart(frame, other), `bubbles too near each other (${count})`).toBeGreaterThanOrEqual(config.agentBubbleGap - 0.001);
          }
          if (index < capacity) {
            expect(maxY(frame), `bubble ${index} of ${count} is not over the pill`).toBeLessThanOrEqual(pill.y);
          } else if (index < capacity + 2) {
            expect(Math.abs(frame.y + frame.height / 2 - (pill.y + pill.height / 2)), `bubble ${index} of ${count} is not beside the pill`).toBeLessThan(0.001);
            if (index === capacity) expect(maxX(frame), `bubble ${index} of ${count} is not on the left`).toBeLessThanOrEqual(pill.x);
            else expect(frame.x, `bubble ${index} of ${count} is not on the right`).toBeGreaterThanOrEqual(maxX(pill));
          } else if (underFits) {
            under += 1;
            expect(frame.y, `bubble ${index} of ${count} is not under the pill`).toBeGreaterThanOrEqual(maxY(pill));
          } else {
            expect(maxY(frame), `bubble ${index} of ${count} is not over the first row`).toBeLessThanOrEqual(frames[0]?.y ?? -Infinity);
          }
        });
        // The first row as it always was: centred over the pill, level.
        const row = frames.slice(0, capacity);
        const first = row[0];
        const last = row.at(-1);
        if (first && last) {
          expect(Math.abs((first.x + maxX(last)) / 2 - midX(pill)), `row not centred over the pill (${count})`).toBeLessThan(0.001);
          for (const frame of row) expect(frame.y).toBe(first.y);
        }
        if (count === most) {
          const over = frames.filter((frame) => maxY(frame) <= pill.y).length;
          const beside = frames.filter((frame) => frame.y < maxY(pill) && maxY(frame) > pill.y).length;
          expect([over, beside, count - over - beside], `with every bubble (${count})`).toEqual(underFits ? [5, 2, 5] : [10, 2, 0]);
        }
      }
    }
    // Some went under the pill when they fit: the tip went under them.
    expect(under > 0).toBe(underFits);
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
      for (let count = 0; count <= agentTools.length - 1 + connectors.length; count += 1) {
        const bubbles = bubbleCentres(pill, Array<Size>(count).fill(bubble), false).map((centre) => framed(centre, bubble));
        const tipFrame = framed(hintCentreOver(pill, bubbles, tip), tip);
        expect(maxY(tipFrame), `not over the pill (${count} bubbles)`).toBeLessThanOrEqual(pill.y);
        expect(Math.abs(midX(tipFrame) - midX(pill))).toBeLessThan(0.001);
        for (const frame of bubbles) expect(maxY(tipFrame), `not over the bubbles (${count})`).toBeLessThanOrEqual(frame.y);
        expect(contains(area, rect(tipFrame.x - shadow, tipFrame.y - shadow, tipFrame.width + 2 * shadow, tipFrame.height + 2 * shadow)), `leaves the canvas over ${count} bubbles`).toBe(true);
      }
    }
  });

  /** The tip's room beside the pill is its gap, arrow and box, in `tipLineCount` lines. */
  test("the tip takes the room left for it", () => {
    expect(config.tipFootprint).toBe(config.tipGap + tip.height);
    for (const name of allTips) {
      for (const hotkey of ["rightOption", "function"] as const) expect(tipLines(name, hotkey)).toHaveLength(config.tipLineCount);
    }
  });
});

describe("the chat window's place", () => {
  const margin = config.chatShadowMargin;

  /** The chat itself: the overlay window's frame inside its shadow margin. */
  function content(frame: Rect): Rect {
    return rect(frame.x + margin, frame.y + margin, frame.width - 2 * margin, frame.height - 2 * margin);
  }

  /** Below the caret's line when there is room for the tallest window, its top edge where the pill's
   * was; centred on the caret. */
  test("the chat window opens below the caret", () => {
    const caret = rect(500, 180, 1, 20);

    const frame = chatFrame(caret, 120, display);

    expect(chatOpensUpward(caret, display)).toBe(false);
    expect(content(frame).y).toBe(maxY(caret) + config.overlayCaretGap);
    expect(frame.height).toBe(120 + 2 * margin);
    expect(frame.width).toBe(config.chatWidth + 2 * margin);
    expect(midX(frame)).toBe(midX(caret));
  });

  /** Too near the bottom for the tallest window, it opens upward, its bottom edge just above the
   * caret's line, so a growing conversation never moves it off the line; exactly enough room below
   * keeps it there. */
  test("the chat window opens above a caret near the bottom", () => {
    const caret = rect(500, 680, 1, 20);

    const frame = chatFrame(caret, 120, display);

    expect(chatOpensUpward(caret, display)).toBe(true);
    expect(maxY(content(frame))).toBe(caret.y - config.overlayCaretGap);
    const lowest = rect(500, maxY(display) - config.chatMaxHeight - config.overlayCaretGap - 20, 1, 20);
    expect(chatOpensUpward(lowest, display)).toBe(false);
    expect(chatOpensUpward({ ...lowest, y: lowest.y + 1 }, display)).toBe(true);
  });

  /** A long conversation scrolls inside the window rather than growing it past its maximum height. */
  test("the chat window is at most its maximum height", () => {
    expect(chatFrame(rect(500, 180, 1, 20), 5_000, display).height).toBe(config.chatMaxHeight + 2 * margin);
  });

  /** A caret at a screen edge keeps the chat on screen; only its shadow margin may spill. */
  test.each([2, 998])("the chat window stays on screen with the caret at x %d", (x) => {
    expect(contains(display, content(chatFrame(rect(x, 180, 1, 20), 120, display)))).toBe(true);
  });

  /** With no caret the window opens at the pointer, which can be in the menu bar, above the work
   * area: the chat still starts inside it. */
  test("the chat window at the pointer in the menu bar stays on screen", () => {
    const workArea = rect(0, 25, 1000, 775);
    expect(contains(workArea, content(chatFrame(rect(500, 10, 1, 1), 120, workArea)))).toBe(true);
  });
});

describe("tips", () => {
  /** The double-tap tip names the key the user holds. */
  test("the double-tap tip names the hotkey", () => {
    expect(tipKeycap("doubleTap", "rightOption")).toBe("right ⌥");
    expect(tipKeycap("doubleTap", "function")).toBe("fn");
    expect(tipKeycap("switchMode", "function")).toBe("space");
  });

  test("the tips say what the key does", () => {
    const words = (lines: ReturnType<typeof tipLines>) => lines.flat().map((part) => ("words" in part ? part.words : part.key)).join(" ").toLowerCase();
    expect(words(tipLines("switchMode", "rightOption"))).toBe("press space to switch between dictation and agent mode");
    expect(words(tipLines("doubleTap", "function"))).toBe("double-tap fn to dictate without holding");
    expect(words(tipLines("handsFree", "function"))).toBe("tap fn to finish dictating, or tap esc to cancel");
  });

  /** A configured line's `[key]` is a keycap and `[hotkey]` the dictation key's; the rest is words,
   * an unclosed bracket included. */
  test("configured lines become words and keycaps", () => {
    expect(tipParts("Tap [hotkey] to finish", "function")).toEqual([{ words: "Tap" }, { key: "fn" }, { words: "to finish" }]);
    expect(tipParts("[space] then [hotkey]", "rightOption")).toEqual([{ key: "space" }, { words: "then" }, { key: "right ⌥" }]);
    expect(tipParts("dictating, or", "function")).toEqual([{ words: "dictating, or" }]);
    expect(tipParts("press [esc", "function")).toEqual([{ words: "press [esc" }]);
    expect(tipLines("handsFree", "function")).toEqual([[{ words: "Tap" }, { key: "fn" }, { words: "to finish" }], [{ words: "dictating, or" }], [{ words: "tap" }, { key: "esc" }, { words: "to cancel" }]]);
  });
});

describe("menu", () => {
  /** The menu's Start Dictation shows only in debug mode; a Stop for a recording in progress shows
   * whatever the mode, so it can always be stopped. */
  test.each<[boolean, Phase, boolean]>([
    [true, { kind: "idle" }, true],
    [false, { kind: "idle" }, false],
    [false, { kind: "arming" }, false],
    [false, { kind: "transcribing" }, false],
    [false, { kind: "failed", message: "x" }, false],
    [false, { kind: "listening" }, true],
    [true, { kind: "listening" }, true],
  ])("debug mode %s, phase %j: shows the dictation button %s", (debugMode, phase, shows) => {
    expect(showsDictationButton(debugMode, phase)).toBe(shows);
  });

  test("the status line says what is missing, else how to dictate", () => {
    const ready: MenuState = { hasConsented: true, isSignedIn: true, microphoneGranted: true, accessibilityTrusted: true, hotkey: "function", debugMode: false, phase: { kind: "idle" } };
    expect(statusLine(ready)).toBe("Hold Fn / Globe (🌐) to dictate");
    expect(statusLine({ ...ready, hasConsented: false })).toBe("Setup needed");
    expect(statusLine({ ...ready, isSignedIn: false })).toBe("Sign in to start dictating");
    expect(statusLine({ ...ready, microphoneGranted: false })).toBe("Setup needed");
    expect(statusLine({ ...ready, accessibilityTrusted: false })).toBe("Setup needed");
  });
});
