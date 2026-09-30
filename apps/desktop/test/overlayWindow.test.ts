// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test, vi } from "vitest";
import { deferred } from "./support.js";
import type { BrowserWindow } from "electron";
import * as config from "../src/core/config.js";
import type { Phase } from "../src/core/dictationController.js";
import type { Rect } from "../src/core/overlayGeometry.js";
import { OverlayWindowController } from "../src/main/overlayWindow.js";

/** One display, and the mouse pointer in its middle; a test may move the pointer or use another
 * display, and puts them back. */
const workArea = { x: 0, y: 0, width: 1440, height: 900 };
const pointerAtRest = { x: 720, y: 450 };
const screenNow = { pointer: pointerAtRest, workArea };
vi.mock("electron", () => ({
  screen: {
    getCursorScreenPoint: () => screenNow.pointer,
    getDisplayNearestPoint: () => ({ workArea: screenNow.workArea }),
  },
}));

/** The overlay window as far as the controller uses it. */
function overlayWindow(): BrowserWindow {
  let visible = false;
  return {
    isVisible: () => visible,
    showInactive: () => {
      visible = true;
    },
    hide: () => {
      visible = false;
    },
    setBounds() {},
    setOpacity() {},
  } as unknown as BrowserWindow;
}

/** An overlay window that keeps its bounds and whether it lets the mouse through. */
function recordingWindow(): { window: BrowserWindow; bounds: () => Rect; ignoresMouse: () => boolean; forwardsMouse: () => boolean; visible: () => boolean; opacity: () => number; opaqueFrames: () => Rect[] } {
  let visible = false;
  let opacity = 1;
  /** Every frame the window took while it showed at full opacity. */
  const opaqueFrames: Rect[] = [];
  let ignoresMouse = true;
  let forwardsMouse = true;
  let bounds: Rect = { x: 0, y: 0, ...config.overlayCanvasSize };
  const window = {
    isVisible: () => visible,
    showInactive: () => {
      visible = true;
    },
    hide: () => {
      visible = false;
    },
    setBounds: (rect: Rect) => {
      bounds = rect;
      if (opacity === 1) opaqueFrames.push(rect);
    },
    setOpacity: (value: number) => {
      if (value === 1 && opacity !== 1) opaqueFrames.push(bounds);
      opacity = value;
    },
    getBounds: () => bounds,
    setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) => {
      ignoresMouse = ignore;
      forwardsMouse = options?.forward === true;
    },
  } as unknown as BrowserWindow;
  return { window, bounds: () => bounds, ignoresMouse: () => ignoresMouse, forwardsMouse: () => forwardsMouse, visible: () => visible, opacity: () => opacity, opaqueFrames: () => opaqueFrames };
}

describe("OverlayWindowController", () => {
  /** Where the overlay opens reaches its view: at a caret near the screen's bottom it opens upward
   * (so the hands-free tip goes above the pill), mid-screen downward, and each placing says so
   * (`onPlace`), for the view's state to be pushed afresh. */
  test("each placing tells the view which way the overlay opens", async () => {
    let caret: Rect = { x: 400, y: workArea.height - 20, width: 1, height: 16 };
    const controller = new OverlayWindowController(overlayWindow(), async () => caret);
    const placed: boolean[] = [];
    controller.onPlace = () => placed.push(controller.opensUpward);

    controller.update({ kind: "arming" });
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(placed).toHaveLength(1));
    expect(controller.opensUpward).toBe(true);

    controller.update({ kind: "idle" });
    caret = { x: 400, y: 300, width: 1, height: 16 };
    controller.update({ kind: "arming" });
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(placed).toHaveLength(2));

    expect(placed).toEqual([true, false]);
    expect(controller.opensUpward).toBe(false);
  });

  /** Where the overlay opens decides whether agent mode's bubbles go under the pill: mid-screen they
   * do; a caret with room under it for the pill and the tip but not a row of bubbles too keeps the pill
   * under it and puts them over it; at the bottom the overlay opens upward and they go over it too. */
  test("each placing tells the view whether the bubbles fit under the pill", async () => {
    const room = config.overlayCaretGap + Math.max(config.pillHeight, config.listeningPillHeight) + config.tipFootprint;
    const bottom = workArea.y + workArea.height;
    const carets: Rect[] = [
      { x: 400, y: 300, width: 1, height: 16 },
      { x: 400, y: bottom - room - 16, width: 1, height: 16 },
      { x: 400, y: bottom - 20, width: 1, height: 16 },
    ];
    let caret = carets[0] as Rect;
    const controller = new OverlayWindowController(overlayWindow(), async () => caret);
    const placed: [boolean, boolean][] = [];
    controller.onPlace = () => placed.push([controller.opensUpward, controller.bubblesFitUnder]);

    for (const next of carets) {
      caret = next;
      controller.update({ kind: "arming" });
      controller.update({ kind: "listening" });
      await vi.waitFor(() => expect(placed).toHaveLength(carets.indexOf(next) + 1));
      controller.update({ kind: "idle" });
    }

    expect(placed).toEqual([
      [false, true],
      [false, false],
      [true, false],
    ]);
  });

  /** Where the pill is on screen, its top edge's centre, in the overlay's canvas at `bounds`, or in
   * the chat window at `bounds` as `controller` places it (its bubbles `row` over it, or none). */
  function pillOnScreen(bounds: Rect, controller?: OverlayWindowController): { x: number; y: number } {
    const placement = controller?.chatPlacement;
    if (!placement) return { x: bounds.x + bounds.width / 2, y: bounds.y + (bounds.height - config.pillHeight) / 2 };
    const margin = config.chatShadowMargin;
    const overBubbles = placement.bubblesUnder ? 0 : config.agentBubbleGap + config.agentBubbleDiameter;
    const y = placement.below ? bounds.y + margin + overBubbles : bounds.y + bounds.height - margin - config.chatStripHeight + overBubbles;
    return { x: bounds.x + placement.pillX, y };
  }

  /** Opening the chat window moves and grows the overlay before its page has laid the chat out: it
   * stays transparent until the page has measured the chat, so the pill never shows a frame away from
   * where it is (red-verified); closed before that, it is not left transparent. */
  test("the chat window shows only once measured", async () => {
    const caret: Rect = { x: 400, y: 500, width: 1, height: 16 };
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => caret);
    const placed: unknown[] = [];
    controller.onPlace = () => placed.push(controller.chatPlacement);
    controller.update({ kind: "arming" });
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(placed).toHaveLength(1));
    const canvas = overlay.bounds();

    controller.update({ kind: "running", tool: "answer" }, true);
    expect(overlay.opacity()).toBe(0);
    expect(overlay.opaqueFrames().filter((frame) => frame.width !== canvas.width)).toEqual([]);
    controller.fitChat(120);
    expect(overlay.opacity()).toBe(1);
    const fitted = overlay.bounds();
    controller.fitChat(160);
    expect(overlay.opaqueFrames().filter((frame) => frame.width !== canvas.width)).toEqual([fitted, overlay.bounds()]);

    controller.update({ kind: "idle" }, false);
    controller.update({ kind: "arming" });
    controller.update({ kind: "listening" });
    controller.update({ kind: "running", tool: "answer" }, true);
    expect(overlay.opacity()).toBe(0);
    controller.update({ kind: "idle" }, false);
    expect(overlay.opacity()).toBe(1);
  });

  /** Where the pill of the hold under way is, for the paste history to open by (ADR-DESK-043): at
   * the caret, as placed; the pointer's once the hold is over, or before its caret is found. */
  test("the pill's place is the caret's while a hold shows, else the pointer's", async () => {
    const caret: Rect = { x: 400, y: 500, width: 1, height: 16 };
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => caret);
    const placed: unknown[] = [];
    controller.onPlace = () => placed.push(controller.chatPlacement);
    const atPointer = controller.pillPlace;
    expect(atPointer.workArea).toEqual(workArea);

    controller.update({ kind: "arming" });
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(placed).toHaveLength(1));
    const pill = pillOnScreen(overlay.bounds());
    const place = controller.pillPlace;
    // The window's origin is rounded: within a point.
    expect(Math.abs(place.pill.x - pill.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(place.pill.y - pill.y)).toBeLessThanOrEqual(1);
    expect(place.pill).not.toEqual(atPointer.pill);
    expect(place.bubblesUnder).toBe(true);

    controller.update({ kind: "idle" });
    expect(controller.pillPlace).toEqual(atPointer);
  });

  /** The overlay takes the mouse, as the chat window, opened over the pill at the caret the request
   * was spoken over, only while the chat is open; the pill stays where it was as it opens and as it
   * fits the height the chat window measures, and closed it lets every click through again (the
   * pointer's moves still reaching the page, for a bubble's hover), at the pill's size, hidden. */
  test("the chat window takes the mouse only while it is open, and the pill stays put", async () => {
    const caret: Rect = { x: 400, y: 500, width: 1, height: 16 };
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => caret);
    const placed: unknown[] = [];
    controller.onPlace = () => placed.push(controller.chatPlacement);
    controller.update({ kind: "arming" });
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(placed).toHaveLength(1));
    expect(overlay.ignoresMouse()).toBe(true);
    const pill = pillOnScreen(overlay.bounds());

    controller.update({ kind: "running", tool: "answer" }, true);
    expect(overlay.ignoresMouse()).toBe(false);
    expect(overlay.visible()).toBe(true);
    expect(overlay.bounds().width).toBe(config.chatWidth + 2 * config.chatShadowMargin);
    expect(placed).toEqual([null, { below: false, maxHeight: config.chatMaxHeight, bubblesUnder: true, pillX: expect.any(Number) as number }]);
    expect(pillOnScreen(overlay.bounds(), controller)).toEqual(pill);
    // Over the pill: the window's top well above it.
    expect(overlay.bounds().y).toBeLessThan(pill.y - config.chatMaxHeight);
    const opened = overlay.bounds();
    controller.fitChat(120);
    expect(overlay.bounds().height).toBe(opened.height - config.chatMaxHeight + 120);
    expect(pillOnScreen(overlay.bounds(), controller)).toEqual(pill);

    // The request's end, and a follow-up, leave it open where it is.
    const fitted = overlay.bounds();
    controller.update({ kind: "idle" }, true);
    controller.update({ kind: "arming" }, true);
    expect(overlay.bounds()).toEqual(fitted);
    expect(overlay.visible()).toBe(true);

    controller.update({ kind: "idle" }, false);
    expect(controller.chatPlacement).toBeNull();
    expect(overlay.ignoresMouse()).toBe(true);
    expect(overlay.forwardsMouse()).toBe(true);
    expect(overlay.visible()).toBe(false);
    expect(overlay.bounds()).toMatchObject(config.overlayCanvasSize);
    controller.fitChat(200);
    expect(overlay.bounds()).toMatchObject(config.overlayCanvasSize);
  });

  /** At a caret near the screen's top there is no room over the pill: the chat window opens under it
   * and its bubbles, the pill staying put as it grows. Near the bottom, where the bubbles went over
   * the pill, it opens over them. Either way it stays on screen. */
  test.each([
    ["top", 40, { below: true, bubblesUnder: true }],
    ["bottom", workArea.height - 40, { below: false, bubblesUnder: false }],
  ])("near the %s the chat window keeps clear of the pill and its bubbles", async (_, y, placement) => {
    const caret: Rect = { x: 400, y, width: 1, height: 16 };
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => caret);
    controller.update({ kind: "arming" });
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(overlay.visible()).toBe(true));
    const pill = pillOnScreen(overlay.bounds());

    controller.update({ kind: "running", tool: "answer" }, true);

    expect(controller.chatPlacement).toMatchObject(placement);
    for (const height of [config.chatMaxHeight, 120]) {
      controller.fitChat(height);
      expect(pillOnScreen(overlay.bounds(), controller)).toEqual(pill);
      const margin = config.chatShadowMargin;
      expect(overlay.bounds().y + margin).toBeGreaterThanOrEqual(workArea.y);
      expect(overlay.bounds().y + overlay.bounds().height - margin).toBeLessThanOrEqual(workArea.height);
    }
  });

  /** In an app with no caret the pill shows at the pointer, and the chat window opens there, over the
   * pill, even if the pointer has moved on while the answer ran. */
  test("without a caret the chat window opens where the pill is, not at the pointer", async () => {
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null);
    try {
      controller.update({ kind: "arming" });
      controller.update({ kind: "listening" });
      await vi.waitFor(() => expect(overlay.visible()).toBe(true));
      const pill = pillOnScreen(overlay.bounds());
      screenNow.pointer = { x: 300, y: 700 };

      controller.update({ kind: "running", tool: "answer" }, true);

      expect(pillOnScreen(overlay.bounds(), controller)).toEqual(pill);
    } finally {
      screenNow.pointer = pointerAtRest;
    }
  });

  /** On a screen too short for the tallest chat window over or under the pill, it opens on the side
   * with more room, no taller than that room, so all of it is on screen: its newest lines, and a
   * question's buttons. The pill stays put. */
  test.each([200, 260, 300])("on a short screen the chat window stays on it, at a caret at %d", async (y) => {
    const short: Rect = { x: 0, y: 25, width: 1024, height: 540 };
    screenNow.workArea = short;
    try {
      const caret: Rect = { x: 400, y, width: 1, height: 16 };
      const overlay = recordingWindow();
      const controller = new OverlayWindowController(overlay.window, async () => caret);
      controller.update({ kind: "arming" });
      controller.update({ kind: "listening" });
      await vi.waitFor(() => expect(overlay.visible()).toBe(true));
      const pill = pillOnScreen(overlay.bounds());

      controller.update({ kind: "running", tool: "answer" }, true);

      const placement = controller.chatPlacement;
      expect(placement?.maxHeight).toBeLessThan(config.chatMaxHeight);
      for (const height of [config.chatMaxHeight, 120]) {
        controller.fitChat(height);
        expect(pillOnScreen(overlay.bounds(), controller)).toEqual(pill);
        const margin = config.chatShadowMargin;
        expect(overlay.bounds().y + margin, `${height}`).toBeGreaterThanOrEqual(short.y);
        expect(overlay.bounds().y + overlay.bounds().height - margin, `${height}`).toBeLessThanOrEqual(short.y + short.height);
      }
    } finally {
      screenNow.workArea = workArea;
    }
  });

  /** A window a tool opened, dropped when its request fails (`DictationController.teardown`), gives
   * way to the pill saying what failed, where the pill was and letting clicks through; one dropped
   * when the request is cancelled leaves nothing once the pill's exit has played. */
  test.each<[string, Phase, boolean]>([
    ["fails", { kind: "failed", message: "Something went wrong. Try again." }, true],
    ["is cancelled", { kind: "idle" }, false],
  ])("a tool's window dropped as its request %s gives way to the pill", async (_, end, showsPill) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const caret: Rect = { x: 400, y: 300, width: 1, height: 16 };
      const overlay = recordingWindow();
      const controller = new OverlayWindowController(overlay.window, async () => caret);
      controller.update({ kind: "arming" });
      controller.update({ kind: "listening" });
      await vi.waitFor(() => expect(overlay.visible()).toBe(true));
      const pill = overlay.bounds();
      controller.update({ kind: "running", tool: "answer" });
      controller.update({ kind: "running", tool: "answer" }, true);
      expect(overlay.bounds().width).toBe(config.chatWidth + 2 * config.chatShadowMargin);

      controller.update({ kind: "running", tool: "answer" });
      controller.update(end);
      vi.advanceTimersByTime(config.overlayDismissDuration);

      expect(overlay.visible()).toBe(showsPill);
      expect(overlay.ignoresMouse()).toBe(true);
      expect(overlay.forwardsMouse()).toBe(true);
      if (showsPill) expect(overlay.bounds()).toEqual(pill);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A text copied instead of pasted (ADR-DESK-042) says so where the user is now, at the mouse
   * pointer, not at the caret they left; a failure stays where the pill was. */
  test.each<[string, Phase, boolean]>([
    ["copied", { kind: "copied", message: "Copied." }, true],
    ["failed", { kind: "failed", message: "Failed." }, false],
  ])("a %s note shows at the pointer only when copied", async (_, end, atPointer) => {
    const caret: Rect = { x: 200, y: 200, width: 1, height: 16 };
    screenNow.pointer = { x: 1000, y: 600 };
    try {
      const overlay = recordingWindow();
      const controller = new OverlayWindowController(overlay.window, async () => caret);
      controller.update({ kind: "arming" });
      controller.update({ kind: "listening" });
      await vi.waitFor(() => expect(overlay.visible()).toBe(true));
      const atCaret = overlay.bounds();
      controller.update({ kind: "transcribing" });

      controller.update(end);

      expect(overlay.visible()).toBe(true);
      const pill = pillOnScreen(overlay.bounds());
      if (atPointer) {
        expect(Math.abs(pill.x - screenNow.pointer.x)).toBeLessThanOrEqual(1);
        expect(pill.y).toBeGreaterThan(screenNow.pointer.y);
      } else {
        expect(overlay.bounds()).toEqual(atCaret);
      }
    } finally {
      screenNow.pointer = pointerAtRest;
    }
  });

  /** A caret found after the chat window opened doesn't move it back to where the pill would be. */
  test("a caret found after the chat opened leaves it where it opened", async () => {
    const caret = deferred<Rect | null>();
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, () => caret.promise);
    controller.update({ kind: "arming" });
    controller.update({ kind: "idle" }, true);
    const opened = overlay.bounds();
    expect(opened.width).toBe(config.chatWidth + 2 * config.chatShadowMargin);

    caret.resolve({ x: 40, y: 40, width: 1, height: 20 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(overlay.bounds()).toEqual(opened);
  });
});
