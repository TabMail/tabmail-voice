// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../src/core/config.js";
import type { Phase } from "../src/core/dictationController.js";
import { type MenuState, showsDictationButton, statusLine } from "../src/core/menuModel.js";
import { bubbleCentres, hintCentre, hintCentreOver, maxX, maxY, midX, opensUpward, overlayOrigin, type Point, type Rect, type Size, tipGoesAbove } from "../src/core/overlayGeometry.js";
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

  /** Agent mode's bubbles and a tip, in the overlay's canvas: the bubbles in one row centred above the
   * pill, clear of it and of each other; the tip centred under the pill; nothing overlaps and
   * everything, the tip's shadow included, stays inside the canvas. For the listening pill and the
   * circle it shrinks to, with no bubbles (dictation) and as many as are ever offered. */
  test("bubbles sit in a row above the pill and the tip under it", () => {
    const area = rect(0, 0, config.overlayCanvasSize.width, config.overlayCanvasSize.height);
    const bubble: Size = { width: config.agentBubbleDiameter, height: config.agentBubbleDiameter };
    const shadow = config.tipShadowRadius + config.tipShadowOffsetY;
    for (const size of [{ width: 120, height: config.listeningPillHeight }, { width: config.pillHeight, height: config.pillHeight }]) {
      const pill = rect(midX(area) - size.width / 2, (area.height - config.pillHeight) / 2, size.width, size.height);
      const tipFrame = framed(hintCentre(pill, tip), tip);
      expect(tipFrame.y).toBeGreaterThanOrEqual(maxY(pill));
      expect(Math.abs(midX(tipFrame) - midX(pill))).toBeLessThan(0.001);
      expect(contains(area, rect(tipFrame.x - shadow, tipFrame.y - shadow, tipFrame.width + 2 * shadow, tipFrame.height + 2 * shadow))).toBe(true);
      // Edit and Compose are never offered together: at most two bubbles.
      for (let count = 0; count <= 2; count += 1) {
        const frames = bubbleCentres(pill, Array<Size>(count).fill(bubble)).map((centre) => framed(centre, bubble));
        expect(frames).toHaveLength(count);
        frames.forEach((frame, index) => {
          expect(maxY(frame)).toBeLessThanOrEqual(pill.y);
          expect(intersects(frame, tipFrame)).toBe(false);
          expect(contains(area, frame)).toBe(true);
          for (const other of frames.slice(index + 1)) expect(intersects(frame, other)).toBe(false);
        });
        const [first] = frames;
        const last = frames.at(-1);
        if (first && last) expect(Math.abs((first.x + maxX(last)) / 2 - midX(pill))).toBeLessThan(0.001);
      }
    }
  });

  /** Only a tip that stays up while listening goes over the pill, and only in an overlay opened
   * above the caret's line: the hands-free tip (owner, 2026-09-27). Timed tips stay under the pill. */
  test.each(allTips.flatMap((name) => [false, true].map((upward) => [name, upward] as const)))("only the hands-free tip goes over the pill, only when opened upward (%s, %s)", (name, upward) => {
    expect(tipGoesAbove(tipDetails[name].displayDuration, upward)).toBe(upward && name === "handsFree");
  });

  /** A tip over the pill: centred over it, clear of the pill and of agent mode's bubbles above it,
   * overlapping neither, and inside the canvas with its shadow. For the listening pill and the circle
   * it shrinks to, with no bubbles and as many as are ever offered. */
  test("a tip over the pill clears the bubbles and stays in the canvas", () => {
    const area = rect(0, 0, config.overlayCanvasSize.width, config.overlayCanvasSize.height);
    const bubble: Size = { width: config.agentBubbleDiameter, height: config.agentBubbleDiameter };
    const shadow = config.tipShadowRadius + config.tipShadowOffsetY;
    for (const size of [{ width: 120, height: config.listeningPillHeight }, { width: config.pillHeight, height: config.pillHeight }]) {
      const pill = rect(midX(area) - size.width / 2, (area.height - config.pillHeight) / 2, size.width, size.height);
      for (let count = 0; count <= 2; count += 1) {
        const bubbles = bubbleCentres(pill, Array<Size>(count).fill(bubble)).map((centre) => framed(centre, bubble));
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
