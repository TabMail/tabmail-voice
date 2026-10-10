// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test, vi } from "vitest";
import { deferred } from "../support/stubs.js";
import type { BrowserWindow } from "electron";
import * as config from "../../src/core/config.js";
import type { Phase } from "../../src/core/dictation/controller.js";
import type { Rect } from "../../src/core/ui/overlayGeometry.js";
import { OverlayWindowController } from "../../src/main/overlayWindow.js";
import { shellPlacementArea } from "../../src/main/native/windows/overlayArea.js";
import { linuxFallbackAnchor } from "../../src/main/native/linux/overlayArea.js";

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

/** A closed chat window's page shrinks it into its pill meanwhile (real timers). */
const chatShrunk = () => new Promise<void>((resolve) => setTimeout(resolve, config.chatCloseDurationSeconds * 1000 + 20));

describe("OverlayWindowController", () => {
  test("a listening pill moves, hides and returns as shell coverage changes", async () => {
    let exclusions: Rect[] = [];
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window,
      async () => ({ x: 100, y: 300, width: 1, height: 20 }),
      (area) => shellPlacementArea(area, exclusions));
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(overlay.visible()).toBe(true));
    const original = { ...overlay.bounds() };

    exclusions = [{ x: 0, y: 0, width: 700, height: 900 }];
    controller.refreshPlacement();
    expect(overlay.visible()).toBe(true);
    expect(overlay.bounds().x).toBeGreaterThan(original.x);
    expect(pillOnScreen(overlay.bounds()).x).toBeGreaterThanOrEqual(724);
    expect(overlay.ignoresMouse()).toBe(true);

    exclusions = [workArea];
    controller.refreshPlacement();
    expect(overlay.visible()).toBe(false);

    exclusions = [];
    controller.refreshPlacement();
    expect(overlay.visible()).toBe(true);
    expect(overlay.bounds()).toEqual(original);
    expect(overlay.ignoresMouse()).toBe(true);
  });

  /** Where the overlay opens reaches its view: at a caret near the screen's bottom it opens upward
   * (so the hands-free tip goes above the pill), mid-screen downward, and each placing says so
   * (`onPlace`), for the view's state to be pushed afresh. */
  test("each placing tells the view which way the overlay opens", async () => {
    let caret: Rect = { x: 400, y: workArea.height - 20, width: 1, height: 16 };
    const controller = new OverlayWindowController(overlayWindow(), async () => caret);
    const placed: boolean[] = [];
    controller.onPlace = () => placed.push(controller.opensUpward);

    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(placed).toHaveLength(1));
    expect(controller.opensUpward).toBe(true);

    controller.update({ kind: "idle" });
    caret = { x: 400, y: 300, width: 1, height: 16 };
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
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
      await new Promise<void>(queueMicrotask);
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

  /** Where the pill is on screen, its top edge's center, in the overlay's canvas at `bounds`, or in
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
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(placed).toHaveLength(1));
    const canvas = overlay.bounds();

    controller.update({ kind: "running", tool: "answer" }, true);
    expect(overlay.opacity()).toBe(0);
    expect(overlay.opaqueFrames().filter((frame) => frame.width !== canvas.width)).toEqual([]);
    controller.fitChat(120);
    expect(overlay.opacity()).toBe(1);
    controller.fitChat(160);
    // At the chat's tallest throughout: the page grows the chat in it.
    expect(overlay.opaqueFrames().filter((frame) => frame.width !== canvas.width)).toEqual([overlay.bounds()]);

    controller.update({ kind: "idle" }, false);
    await chatShrunk();
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    controller.update({ kind: "running", tool: "answer" }, true);
    expect(overlay.opacity()).toBe(0);
    controller.update({ kind: "idle" }, false);
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    expect(overlay.visible()).toBe(true);
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
    await new Promise<void>(queueMicrotask);
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

    // By the bottom of the screen a row of bubbles has no room under the pill: they go over it, and
    // the place says so, for the paste history to open where the chat would (red-verified).
    caret.y = workArea.y + workArea.height - 20;
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(placed).toHaveLength(2));
    expect(controller.pillPlace.bubblesUnder).toBe(false);
  });

  /** The overlay takes the mouse, as the chat window, opened over the pill at the caret the request
   * was spoken over, only while the chat is open; the pill stays where it was as it opens and as it
   * fits the height the chat window measures, and closed it lets every click through again (the
   * pointer's moves still reaching the page, for a bubble's hover), and a chat's height measured
   * after it closed doesn't resize it. */
  test("the chat window takes the mouse only while it is open, and the pill stays put", async () => {
    const caret: Rect = { x: 400, y: 500, width: 1, height: 16 };
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => caret);
    const placed: unknown[] = [];
    controller.onPlace = () => placed.push(controller.chatPlacement);
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(placed).toHaveLength(1));
    expect(overlay.ignoresMouse()).toBe(true);
    const pill = pillOnScreen(overlay.bounds());

    controller.update({ kind: "running", tool: "answer" }, true);
    // Over the chat only, as the page says the pointer is.
    expect(overlay.ignoresMouse()).toBe(true);
    controller.pointerOver(true);
    expect(overlay.ignoresMouse()).toBe(false);
    controller.pointerOver(false);
    expect(overlay.ignoresMouse()).toBe(true);
    expect(overlay.forwardsMouse()).toBe(true);
    controller.pointerOver(true);
    expect(overlay.visible()).toBe(true);
    expect(overlay.bounds().width).toBe(config.chatWidth + 2 * config.chatShadowMargin);
    expect(placed).toEqual([null, { below: false, maxHeight: config.chatMaxHeight, bubblesUnder: true, pillX: expect.any(Number) as number }]);
    expect(pillOnScreen(overlay.bounds(), controller)).toEqual(pill);
    // Over the pill: the window's top well above it.
    expect(overlay.bounds().y).toBeLessThan(pill.y - config.chatMaxHeight);
    const opened = overlay.bounds();
    controller.fitChat(120);
    expect(overlay.bounds()).toEqual(opened);
    expect(pillOnScreen(overlay.bounds(), controller)).toEqual(pill);

    // The request's end, and a follow-up, leave it open where it is.
    const fitted = overlay.bounds();
    controller.update({ kind: "idle" }, true);
    controller.update({ kind: "arming" }, true);
    expect(overlay.bounds()).toEqual(fitted);
    expect(overlay.visible()).toBe(true);

    controller.update({ kind: "idle" }, false);
    // Shrinking into its pill, where it was, it lets every click through already.
    expect(controller.chatPlacement).not.toBeNull();
    expect(overlay.bounds()).toEqual(fitted);
    expect(overlay.ignoresMouse()).toBe(true);
    controller.pointerOver(true);
    expect(overlay.ignoresMouse()).toBe(true);
    await chatShrunk();
    expect(controller.chatPlacement).toBeNull();
    expect(overlay.ignoresMouse()).toBe(true);
    expect(overlay.forwardsMouse()).toBe(true);
    const closed = overlay.bounds();
    controller.fitChat(200);
    controller.pointerOver(true);
    expect(overlay.bounds()).toEqual(closed);
    expect(overlay.ignoresMouse()).toBe(true);
  });

  /** The page says the pointer is over `.chat, .bubble` on every move: over a pill bubble once the
   * chat has closed, the overlay must still let clicks through to the app under it. */
  test("a closed chat window never takes clicks, even over a bubble", async () => {
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null);
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "running", tool: "answer" }, true);
    // The pointer never went over the open chat window.
    expect(overlay.ignoresMouse()).toBe(true);
    controller.update({ kind: "idle" }, false);
    controller.update({ kind: "listening" });
    controller.pointerOver(true);
    expect(overlay.ignoresMouse()).toBe(true);
    expect(overlay.forwardsMouse()).toBe(true);
  });

  /** A chat window placed under a pointer that has not moved since takes its click: the page says
   * where the pointer is only as it moves. */
  test("a chat window opened under the resting pointer takes its click", () => {
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null);
    controller.update({ kind: "running", tool: "answer" }, true);
    expect(overlay.ignoresMouse()).toBe(true);
    const tallest = overlay.bounds();
    // The pointer the chat opened at: the pill's, under the chat.
    screenNow.pointer = { x: pointerAtRest.x, y: tallest.y + tallest.height - config.chatShadowMargin - 1 };
    try {
      controller.fitChat(120);
      expect(overlay.ignoresMouse()).toBe(false);
    } finally {
      screenNow.pointer = pointerAtRest;
    }

    // Elsewhere, clicks go through until the pointer moves over it.
    controller.update({ kind: "idle" }, false);
    controller.update({ kind: "running", tool: "answer" }, true);
    screenNow.pointer = { x: pointerAtRest.x, y: tallest.y + 1 };
    try {
      controller.fitChat(120);
      expect(overlay.ignoresMouse()).toBe(true);
    } finally {
      screenNow.pointer = pointerAtRest;
    }
  });

  /** Where a click-through window gets no pointer moves (Linux), the overlay at the chat's tallest
   * looks where the pointer is every `overlayPointerPollInterval`, and takes clicks only while it is
   * over the chat as measured, the edge by the pill staying put: the rest of the tallest frame lets
   * clicks through, as a window that size did. What the page says of the pointer changes nothing
   * there, and the overlay never takes a shape (that crashed Xwayland). Closed, it stops looking and
   * lets clicks through while its page shrinks it into its pill, and after. */
  test.each([
    ["over", 500],
    ["under", 40],
  ])("polling the pointer, the chat window %s the pill takes clicks only where it is", (_, y) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null, undefined, undefined, "poll");
    const tick = () => vi.advanceTimersByTime(config.overlayPointerPollInterval);
    screenNow.pointer = { x: 400, y };
    try {
      controller.update({ kind: "running", tool: "answer" }, true);
      const tallest = overlay.bounds();
      expect(tallest.height).toBe(2 * config.chatShadowMargin + config.chatMaxHeight + config.chatPillGap + config.chatStripHeight);
      const below = controller.chatPlacement?.below === true;
      expect(below).toBe(y < 100);
      expect(overlay.ignoresMouse()).toBe(true);
      expect(overlay.forwardsMouse()).toBe(true);
      // Unmeasured, there is no chat to be over yet.
      screenNow.pointer = { x: tallest.x + 1, y: tallest.y + 1 };
      tick();
      expect(overlay.ignoresMouse()).toBe(true);

      controller.fitChat(120);
      const height = tallest.height - config.chatMaxHeight + 120;
      const top = below ? tallest.y : tallest.y + tallest.height - height;
      expect(overlay.bounds()).toEqual(tallest);
      for (const [pointer, takes] of [
        [{ x: tallest.x + 1, y: top + 1 }, true],
        [{ x: tallest.x + 1, y: below ? top + height : top - 1 }, false],
        [{ x: tallest.x + tallest.width - 1, y: top + height - 1 }, true],
        [{ x: tallest.x + tallest.width, y: top + 1 }, false],
      ] as const) {
        screenNow.pointer = pointer;
        tick();
        expect(overlay.ignoresMouse()).toBe(!takes);
        expect(overlay.forwardsMouse()).toBe(true);
        // The page's word on the pointer is not taken over the poll.
        controller.pointerOver(!takes);
        expect(overlay.ignoresMouse()).toBe(!takes);
      }

      screenNow.pointer = { x: tallest.x + 1, y: top + 1 };
      tick();
      expect(overlay.ignoresMouse()).toBe(false);
      controller.update({ kind: "idle" }, false);
      expect(overlay.ignoresMouse()).toBe(true);
      // Closed, the poll stops as the chat shrinks: the pointer still over it takes no clicks.
      tick();
      expect(controller.chatPlacement).not.toBeNull();
      expect(overlay.ignoresMouse()).toBe(true);
      vi.advanceTimersByTime(config.chatCloseDurationSeconds * 1000 + config.overlayDismissDuration);
      expect(controller.chatPlacement).toBeNull();
      expect(overlay.ignoresMouse()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      screenNow.pointer = pointerAtRest;
      vi.useRealTimers();
    }
  });

  /** Polling the pointer, a follow-up as the chat window shrinks looks again: the pointer over it takes
   * clicks, as before it closed. */
  test("polling the pointer, a follow-up as the chat window shrinks takes clicks where it is", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null, undefined, undefined, "poll");
    const tick = () => vi.advanceTimersByTime(config.overlayPointerPollInterval);
    screenNow.pointer = { x: 400, y: 500 };
    try {
      controller.update({ kind: "running", tool: "answer" }, true);
      controller.fitChat(120);
      const tallest = overlay.bounds();
      screenNow.pointer = { x: tallest.x + 1, y: tallest.y + tallest.height - 1 };
      tick();
      expect(overlay.ignoresMouse()).toBe(false);

      controller.update({ kind: "idle" }, false);
      tick();
      expect(overlay.ignoresMouse()).toBe(true);
      controller.update({ kind: "arming" }, true);
      tick();
      expect(overlay.ignoresMouse()).toBe(false);
      vi.advanceTimersByTime(config.chatCloseDurationSeconds * 1000);
      expect(controller.chatPlacement).not.toBeNull();
      expect(overlay.ignoresMouse()).toBe(false);
    } finally {
      screenNow.pointer = pointerAtRest;
      vi.useRealTimers();
    }
  });

  /** Polling the pointer, the note measured again and again keeps one poll, which follows its last frame
   * and ends with it. */
  test("polling the pointer, a note laid out again keeps one poll, at its last frame, gone with the note", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null, undefined, undefined, "poll");
    const tick = () => vi.advanceTimersByTime(config.overlayPointerPollInterval);
    try {
      controller.update({ kind: "notPasted", message: "Click to copy.", text: "Synthetic note." });
      const bounds = overlay.bounds();
      screenNow.pointer = { x: bounds.x + 15, y: bounds.y + 25 };
      controller.fitNote({ x: 10, y: 20, width: 40, height: 30 });
      tick();
      expect(overlay.ignoresMouse()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      controller.fitNote({ x: 150, y: 20, width: 40, height: 30 });
      tick();
      expect(overlay.ignoresMouse()).toBe(true);
      screenNow.pointer = { x: bounds.x + 155, y: bounds.y + 25 };
      tick();
      expect(overlay.ignoresMouse()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      controller.update({ kind: "idle" });
      vi.advanceTimersByTime(config.overlayDismissDuration + config.overlayPointerPollInterval);
      expect(overlay.ignoresMouse()).toBe(true);
      expect(overlay.visible()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      screenNow.pointer = pointerAtRest;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  /** Polling the pointer, a chat window closed before it measured itself leaves no poll running. */
  test("polling the pointer, a chat window closed before it measured itself stops looking", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null, undefined, undefined, "poll");
    const tick = () => vi.advanceTimersByTime(config.overlayPointerPollInterval);
    screenNow.pointer = { x: 400, y: 500 };
    try {
      controller.update({ kind: "running", tool: "answer" }, true);
      const bounds = overlay.bounds();
      screenNow.pointer = { x: bounds.x + 1, y: bounds.y + bounds.height - 1 };
      tick();
      expect(overlay.ignoresMouse()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      controller.update({ kind: "idle" }, false);
      vi.advanceTimersByTime(config.overlayDismissDuration + config.overlayPointerPollInterval);
      expect(controller.chatPlacement).toBeNull();
      expect(overlay.ignoresMouse()).toBe(true);
      expect(overlay.visible()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      // A later, measured chat remains interactive, then also fully relinquishes the pointer.
      controller.update({ kind: "running", tool: "answer" }, true);
      controller.fitChat(120);
      const next = overlay.bounds();
      screenNow.pointer = { x: next.x + 1, y: next.y + next.height - 1 };
      tick();
      expect(overlay.ignoresMouse()).toBe(false);
      controller.update({ kind: "idle" }, false);
      vi.advanceTimersByTime(config.chatCloseDurationSeconds * 1000 + config.overlayDismissDuration);
      expect(overlay.ignoresMouse()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      screenNow.pointer = pointerAtRest;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  /** Polling the pointer, the chat window takes clicks over the height it last measured, growing or
   * shrinking, opened over the pill or under it. */
  test.each([["over", 500], ["under", 40]])("polling the pointer, a chat window opened %s the pill takes clicks over its latest height", (_, y) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null, undefined, undefined, "poll");
    const tick = () => vi.advanceTimersByTime(config.overlayPointerPollInterval);
    screenNow.pointer = { x: 400, y };
    try {
      controller.update({ kind: "running", tool: "answer" }, true);
      const tallest = overlay.bounds();
      const below = controller.chatPlacement?.below === true;
      const height120 = tallest.height - config.chatMaxHeight + 120;
      const edge120 = below ? tallest.y + height120 : tallest.y + tallest.height - height120;
      screenNow.pointer = { x: tallest.x + 1, y: below ? edge120 + 40 : edge120 - 40 };
      controller.fitChat(120);
      tick();
      expect(overlay.ignoresMouse()).toBe(true);
      controller.fitChat(240);
      tick();
      expect(overlay.ignoresMouse()).toBe(false);
      controller.fitChat(80);
      tick();
      expect(overlay.ignoresMouse()).toBe(true);
      const height80 = tallest.height - config.chatMaxHeight + 80;
      screenNow.pointer = { x: tallest.x + 1, y: below ? tallest.y + height80 - 1 : tallest.y + tallest.height - 1 };
      tick();
      expect(overlay.ignoresMouse()).toBe(false);
      expect(overlay.bounds()).toEqual(tallest);
      controller.update({ kind: "idle" }, false);
      vi.advanceTimersByTime(config.chatCloseDurationSeconds * 1000 + config.overlayDismissDuration);
      expect(overlay.ignoresMouse()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      screenNow.pointer = pointerAtRest;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  /** Where the page says where the pointer is, it alone decides the clicks: nothing polls. */
  test("where the page says where the pointer is, nothing polls", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null);
    screenNow.pointer = { x: 400, y: 500 };
    try {
      controller.update({ kind: "running", tool: "answer" }, true);
      controller.fitChat(120);
      const bounds = overlay.bounds();
      screenNow.pointer = { x: bounds.x + 1, y: bounds.y + bounds.height - 1 };
      controller.pointerOver(true);
      expect(overlay.ignoresMouse()).toBe(false);
      controller.pointerOver(false);
      expect(overlay.ignoresMouse()).toBe(true);
      vi.advanceTimersByTime(config.overlayPointerPollInterval);
      expect(overlay.ignoresMouse()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      controller.update({ kind: "idle" }, false);
      vi.advanceTimersByTime(config.chatCloseDurationSeconds * 1000 + config.overlayDismissDuration);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      screenNow.pointer = pointerAtRest;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  /** Hidden as the chat window closes, the overlay's last frame would still be the chat, which then
   * showed for a moment as the overlay next did (owner, 2026-10-04: "the previous answer briefly
   * blinks"). It stays up, transparent and click-through, while its page draws the chat away, and is
   * hidden after that; the next hold's pill shows opaque, at the pill's size. */
  test("a closed chat window is drawn away before the overlay hides", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const overlay = recordingWindow();
      const controller = new OverlayWindowController(overlay.window, async () => ({ x: 400, y: 500, width: 1, height: 16 }));
      controller.update({ kind: "running", tool: "answer" }, true);
      controller.fitChat(120);

      controller.update({ kind: "idle" }, false);
      // The page shrinks the chat into its pill first, in the chat's frame, opaque.
      expect(controller.chatPlacement).not.toBeNull();
      expect(overlay.opacity()).toBe(1);
      expect(overlay.ignoresMouse()).toBe(true);
      vi.advanceTimersByTime(config.chatCloseDurationSeconds * 1000 - 1);
      expect(controller.chatPlacement).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(controller.chatPlacement).toBeNull();
      expect(overlay.visible()).toBe(true);
      expect(overlay.opacity()).toBe(0);
      expect(overlay.ignoresMouse()).toBe(true);
      vi.advanceTimersByTime(config.overlayDismissDuration - 1);
      expect(overlay.visible()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(overlay.visible()).toBe(false);

      controller.update({ kind: "arming" });
      await new Promise<void>(queueMicrotask);
      controller.update({ kind: "listening" });
      expect(overlay.visible()).toBe(true);
      expect(overlay.opacity()).toBe(1);
      expect(overlay.bounds()).toMatchObject(config.overlayCanvasSize);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A follow-up as the chat window shrinks into its pill keeps it open, where it was, taking clicks
   * again. */
  test("a follow-up as the chat window shrinks keeps it open where it is", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const overlay = recordingWindow();
      const controller = new OverlayWindowController(overlay.window, async () => ({ x: 400, y: 500, width: 1, height: 16 }));
      controller.update({ kind: "running", tool: "answer" }, true);
      controller.fitChat(120);
      const open = overlay.bounds();

      controller.update({ kind: "idle" }, false);
      vi.advanceTimersByTime(config.chatCloseDurationSeconds * 500);
      controller.update({ kind: "arming" }, true);
      vi.advanceTimersByTime(config.chatCloseDurationSeconds * 1000);

      expect(controller.chatPlacement).not.toBeNull();
      expect(overlay.bounds()).toEqual(open);
      expect(overlay.opacity()).toBe(1);
      controller.pointerOver(true);
      expect(overlay.ignoresMouse()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A hold started just as the chat window closes doesn't hide the overlay before its page has drawn
   * the chat away either: it stays transparent until the pill shows. */
  test("a hold started as the chat window closes shows its pill without the chat", async () => {
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => ({ x: 400, y: 500, width: 1, height: 16 }));
    controller.update({ kind: "running", tool: "answer" }, true);
    controller.fitChat(120);
    const opaque = overlay.opaqueFrames().length;

    controller.update({ kind: "idle" }, false);
    controller.update({ kind: "arming" });
    // The chat shrinking into its pill first; then the hold, its window transparent.
    expect(controller.chatPlacement).not.toBeNull();
    await chatShrunk();
    expect(controller.chatPlacement).toBeNull();
    expect(overlay.visible()).toBe(true);
    expect(overlay.opacity()).toBe(0);
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    expect(overlay.opacity()).toBe(1);
    expect(overlay.opaqueFrames().slice(opaque)).toEqual([overlay.bounds()]);
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
    await new Promise<void>(queueMicrotask);
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
      await new Promise<void>(queueMicrotask);
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
      await new Promise<void>(queueMicrotask);
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
   * when the request is canceled leaves nothing once the pill's exit has played. */
  test.each<[string, Phase, boolean]>([
    ["fails", { kind: "failed", message: "Something went wrong. Try again." }, true],
    ["is canceled", { kind: "idle" }, false],
  ])("a tool's window dropped as its request %s gives way to the pill", async (_, end, showsPill) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const caret: Rect = { x: 400, y: 300, width: 1, height: 16 };
      const overlay = recordingWindow();
      const controller = new OverlayWindowController(overlay.window, async () => caret);
      controller.update({ kind: "arming" });
      await new Promise<void>(queueMicrotask);
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

  /** A text not pasted (ADR-DESK-042) says so where the user is now, at the mouse pointer, not at the
   * caret they left; a failure stays where the pill was. */
  test.each<[string, Phase, boolean]>([
    ["not-pasted", { kind: "notPasted", message: "Click to copy.", text: "Hello there." }, true],
    ["failed", { kind: "failed", message: "Failed." }, false],
  ])("a %s note shows at the pointer only when not pasted", async (_, end, atPointer) => {
    const caret: Rect = { x: 200, y: 200, width: 1, height: 16 };
    screenNow.pointer = { x: 1000, y: 600 };
    try {
      const overlay = recordingWindow();
      const controller = new OverlayWindowController(overlay.window, async () => caret);
      controller.update({ kind: "arming" });
      await new Promise<void>(queueMicrotask);
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

  /** At the pointer near the bottom of the display, the not-pasted note keeps room under the pill's
   * top for all of it, as tall as it gets (`noteMaxHeight`): it shows the text it copies, taller than
   * the pill and its tip, for which a failure there keeps room (owner, 2026-10-09). */
  test.each([1, 20, 60, 120])("the not-pasted note is all on screen with the pointer %i pt over the bottom", (above) => {
    const bottom = workArea.y + workArea.height;
    screenNow.pointer = { x: 700, y: bottom - above };
    try {
      const overlay = recordingWindow();
      const controller = new OverlayWindowController(overlay.window, async () => null);
      controller.update({ kind: "transcribing" });
      controller.update({ kind: "notPasted", message: "Click to copy.", text: "Hello there." });
      expect(pillOnScreen(overlay.bounds()).y + config.noteMaxHeight).toBeLessThanOrEqual(bottom);
    } finally {
      screenNow.pointer = pointerAtRest;
    }
  });

  /** The not-pasted note takes clicks where the pointer is over it (macOS, Windows), and the rest of
   * the overlay lets them through; clicked and refused by the clipboard, the note says so where it
   * was, and the overlay lets every click through again. */
  test("the not-pasted note takes clicks only under the pointer, until it goes", async () => {
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null);
    controller.update({ kind: "transcribing" });
    controller.update({ kind: "notPasted", message: "Click to copy.", text: "Hello there." });
    const atNote = overlay.bounds();
    expect(overlay.ignoresMouse()).toBe(true);
    expect(overlay.forwardsMouse()).toBe(true);

    controller.pointerOver(true);
    expect(overlay.ignoresMouse()).toBe(false);
    controller.pointerOver(false);
    expect(overlay.ignoresMouse()).toBe(true);
    expect(overlay.forwardsMouse()).toBe(true);
    // A measured frame is for the pointer poll (Linux) only: the page's word stands.
    controller.fitNote({ x: 10, y: 20, width: 180, height: 32 });
    expect(overlay.ignoresMouse()).toBe(true);
    controller.pointerOver(true);
    // The same note again (a state push) changes nothing.
    controller.update({ kind: "notPasted", message: "Click to copy.", text: "Hello there." });
    expect(overlay.ignoresMouse()).toBe(false);

    controller.update({ kind: "failed", message: "Couldn't copy." });
    expect(overlay.visible()).toBe(true);
    expect(overlay.bounds()).toEqual(atNote);
    expect(overlay.ignoresMouse()).toBe(true);
    expect(overlay.forwardsMouse()).toBe(true);
    // No longer a note: the pointer over it no longer takes clicks.
    controller.pointerOver(true);
    expect(overlay.ignoresMouse()).toBe(true);
  });

  /** Where the pointer is polled for (Linux), the note takes clicks only while the pointer is over its
   * measured frame, and the next hold stops the poll and lets clicks through. */
  test("polling the pointer, the not-pasted note takes clicks only where it is", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => null, undefined, undefined, "poll");
    const tick = () => vi.advanceTimersByTime(config.overlayPointerPollInterval);
    try {
      controller.update({ kind: "notPasted", message: "Click to copy.", text: "Hello there." });
      const bounds = overlay.bounds();
      // Unmeasured, nothing is polled for.
      screenNow.pointer = { x: bounds.x + 15, y: bounds.y + 25 };
      tick();
      expect(overlay.ignoresMouse()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      controller.fitNote({ x: 10.4, y: 20.6, width: 180.2, height: 32 });
      for (const [pointer, takes] of [
        [{ x: bounds.x + 10, y: bounds.y + 21 }, true],
        [{ x: bounds.x + 9, y: bounds.y + 21 }, false],
        [{ x: bounds.x + 189, y: bounds.y + 52 }, true],
        [{ x: bounds.x + 190, y: bounds.y + 52 }, false],
        [{ x: bounds.x + 100, y: bounds.y + 53 }, false],
      ] as const) {
        screenNow.pointer = pointer;
        tick();
        expect(overlay.ignoresMouse()).toBe(!takes);
        expect(overlay.forwardsMouse()).toBe(true);
      }

      screenNow.pointer = { x: bounds.x + 15, y: bounds.y + 25 };
      tick();
      expect(overlay.ignoresMouse()).toBe(false);
      controller.update({ kind: "arming" });
      expect(overlay.ignoresMouse()).toBe(true);
      tick();
      expect(overlay.ignoresMouse()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      // A note gone measures nothing.
      controller.fitNote({ x: 10, y: 20, width: 180, height: 32 });
      tick();
      expect(overlay.ignoresMouse()).toBe(true);
    } finally {
      screenNow.pointer = pointerAtRest;
      vi.useRealTimers();
    }
  });

  /** A caret found after the chat window opened doesn't move it back to where the pill would be. */
  test("a caret found after the chat opened leaves it where it opened", async () => {
    const caret = deferred<Rect | null>();
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, () => caret.promise);
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "idle" }, true);
    const opened = overlay.bounds();
    expect(opened.width).toBe(config.chatWidth + 2 * config.chatShadowMargin);

    caret.resolve({ x: 40, y: 40, width: 1, height: 20 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(overlay.bounds()).toEqual(opened);
  });
});

test("a shell exclusion region constrains the shared pill and interactive chat", async () => {
  const area = { x: 0, y: 0, width: 325, height: 900 };
  const overlay = recordingWindow();
  const controller = new OverlayWindowController(overlay.window, async () => ({ x: 750, y: 200, width: 1, height: 20 }), () => area);
  controller.update({ kind: "arming" });
  await new Promise<void>(queueMicrotask);
  controller.update({ kind: "listening" });
  await vi.waitFor(() => expect(overlay.visible()).toBe(true));
  expect(controller.pillPlace.workArea).toEqual(area);
  expect(controller.pillPlace.pill.x).toBe(162.5);
  controller.update({ kind: "running", tool: "answer" }, true);
  controller.fitChat(320);
  controller.pointerOver(true);
  expect(controller.chatPlacement?.width).toBe(325);
  expect(overlay.ignoresMouse()).toBe(false);
  const bounds = overlay.bounds();
  expect(bounds.x + config.chatShadowMargin).toBeGreaterThanOrEqual(area.x);
  expect(bounds.x + bounds.width - config.chatShadowMargin).toBeLessThanOrEqual(area.x + area.width);
});

test("no usable area never shows an overlay behind the shell", async () => {
  const overlay = recordingWindow();
  const locate = vi.fn(async () => ({ x: 750, y: 200, width: 1, height: 20 }));
  const controller = new OverlayWindowController(overlay.window, locate, () => null);
  controller.update({ kind: "arming" });
  await new Promise<void>(queueMicrotask);
  controller.update({ kind: "listening" });
  await vi.waitFor(() => expect(locate).toHaveResolved());
  expect(overlay.visible()).toBe(false);
  controller.update({ kind: "running", tool: "answer" }, true);
  expect(overlay.visible()).toBe(false);
});

test("placement refresh recovers chat after Search leaves no usable area", () => {
  let area: Rect | null = null;
  const overlay = recordingWindow();
  const controller = new OverlayWindowController(overlay.window, async () => null, () => area);
  controller.update({ kind: "idle" }, true);
  expect(overlay.visible()).toBe(false);
  area = { x: 0, y: 0, width: 325, height: 900 };
  controller.refreshPlacement();
  expect(overlay.visible()).toBe(true);
  expect(controller.chatPlacement?.width).toBe(325);
  area = { x: 900, y: 0, width: 300, height: 900 };
  controller.pointerOver(true);
  controller.refreshPlacement();
  controller.fitChat(200);
  expect(overlay.bounds().x + config.chatShadowMargin).toBeGreaterThanOrEqual(900);
  // Placed afresh, it lets clicks through until the page's next move says the pointer is over it.
  expect(overlay.ignoresMouse()).toBe(true);
  controller.pointerOver(true);
  expect(overlay.ignoresMouse()).toBe(false);
  area = null;
  controller.refreshPlacement();
  expect(overlay.visible()).toBe(false);
});

test("placement refresh does not reveal an idle or arming overlay", async () => {
  const overlay = recordingWindow();
  const controller = new OverlayWindowController(overlay.window, async () => null);
  controller.refreshPlacement();
  expect(overlay.visible()).toBe(false);
  controller.update({ kind: "arming" });
  await new Promise<void>(queueMicrotask);
  controller.refreshPlacement();
  expect(overlay.visible()).toBe(false);
});

test("repositioned chat remains opaque without another renderer size notification", () => {
  let area: Rect | null = { x: 0, y: 0, width: 325, height: 900 };
  const overlay = recordingWindow();
  const controller = new OverlayWindowController(overlay.window, async () => null, () => area);
  controller.update({ kind: "idle" }, true);
  controller.fitChat(200);
  area = { x: 900, y: 0, width: 325, height: 900 };
  controller.refreshPlacement();
  expect(overlay.opacity()).toBe(1);
  expect(overlay.visible()).toBe(true);
  area = null;
  controller.refreshPlacement();
  expect(overlay.visible()).toBe(false);
  area = { x: 0, y: 0, width: 325, height: 900 };
  controller.refreshPlacement();
  expect(overlay.visible()).toBe(true);
  expect(overlay.opacity()).toBe(1);
});


test("Linux fallback stays on the selected display when the pointer moves, and preserves a usable caret", async () => {
  const area = { x: -1440, y: 30, width: 1440, height: 870 };
  screenNow.workArea = area;
  try {
    const overlay = recordingWindow();
    let caret: Rect | null = null;
    const controller = new OverlayWindowController(overlay.window, async () => caret, undefined, linuxFallbackAnchor);
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(overlay.visible()).toBe(true));
    const first = controller.pillPlace;
    expect(first.pill.x).toBe(-719.5);
    controller.update({ kind: "idle" });
    screenNow.pointer = { x: -1300, y: 850 };
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(overlay.visible()).toBe(true));
    expect(controller.pillPlace).toEqual(first);
    controller.update({ kind: "idle" });
    caret = { x: -1200, y: 200, width: 1, height: 20 };
    controller.update({ kind: "arming" });
    await new Promise<void>(queueMicrotask);
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(controller.pillPlace.pill.x).toBe(-1199.5));
    expect(overlay.ignoresMouse()).toBe(true);
  } finally {
    screenNow.workArea = workArea;
    screenNow.pointer = pointerAtRest;
  }
});


test("listening reveals immediately despite a stalled caret, and a late caret cannot move it", async () => {
  const caret = deferred<Rect | null>();
  const overlay = recordingWindow();
  const controller = new OverlayWindowController(overlay.window, () => caret.promise);
  controller.update({ kind: "arming" });
  expect(overlay.visible()).toBe(false);
  controller.update({ kind: "listening" });
  expect(overlay.visible()).toBe(true);
  const shown = { ...overlay.bounds() };
  expect(controller.pillPlace.pill.x).toBe(pointerAtRest.x + 0.5);
  caret.resolve({ x: 40, y: 40, width: 1, height: 20 });
  await new Promise<void>(queueMicrotask);
  expect(overlay.bounds()).toEqual(shown);
  expect(overlay.visible()).toBe(true);
});

test("an old slow caret cannot overwrite a later hold's ready caret", async () => {
  const old = deferred<Rect | null>();
  const fresh = { x: 400, y: 300, width: 1, height: 20 };
  const locate = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(fresh);
  const overlay = recordingWindow();
  const controller = new OverlayWindowController(overlay.window, locate);
  controller.update({ kind: "arming" });
  controller.update({ kind: "listening" });
  controller.update({ kind: "idle" });
  controller.update({ kind: "arming" });
  await new Promise<void>(queueMicrotask);
  controller.update({ kind: "listening" });
  expect(controller.pillPlace.pill.x).toBe(fresh.x + 0.5);
  const shown = { ...overlay.bounds() };
  old.resolve({ x: 40, y: 40, width: 1, height: 20 });
  await new Promise<void>(queueMicrotask);
  expect(overlay.bounds()).toEqual(shown);
});

test("late caret cannot change saved placement or the chat opened from it", async () => {
  const caret = deferred<Rect | null>();
  const window = recordingWindow();
  const controller = new OverlayWindowController(window.window, () => caret.promise);
  controller.update({ kind: "arming" });
  controller.update({ kind: "listening" });
  expect(window.visible()).toBe(true);
  const place = controller.pillPlace;
  const onScreenX = window.bounds().x + window.bounds().width / 2;
  expect(place.pill.x).toBe(pointerAtRest.x + 0.5);
  caret.resolve({ x: 40, y: 40, width: 1, height: 20 });
  await new Promise<void>(queueMicrotask);
  await new Promise<void>(queueMicrotask);
  expect(controller.pillPlace).toEqual(place);
  controller.update({ kind: "running", tool: "answer" }, true);
  controller.fitChat(180);
  controller.pointerOver(true);
  expect(window.bounds().x + (controller.chatPlacement?.pillX ?? -10000)).toBe(onScreenX);
  expect(window.visible()).toBe(true);
  expect(window.ignoresMouse()).toBe(false);
});

test("stalled caret cannot suppress a later restriction or its recovery", () => {
  const caret = deferred<Rect | null>();
  let area: Rect | null = workArea;
  const window = recordingWindow();
  const controller = new OverlayWindowController(window.window, () => caret.promise, () => area);
  controller.update({ kind: "arming" });
  controller.update({ kind: "listening" });
  expect(window.visible()).toBe(true);
  const shown = { ...window.bounds() };
  area = null;
  controller.refreshPlacement();
  expect(window.visible()).toBe(false);
  area = workArea;
  controller.refreshPlacement();
  expect(window.visible()).toBe(true);
  expect(window.bounds()).toEqual(shown);
});

test("old completion cannot change the newer hold's saved placement", async () => {
  const old = deferred<Rect | null>();
  const fresh = { x: 400, y: 300, width: 1, height: 20 };
  const locate = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(fresh);
  const window = recordingWindow();
  const controller = new OverlayWindowController(window.window, locate);
  controller.update({ kind: "arming" });
  controller.update({ kind: "listening" });
  controller.update({ kind: "idle" });
  controller.update({ kind: "arming" });
  await new Promise<void>(queueMicrotask);
  controller.update({ kind: "listening" });
  const place = controller.pillPlace;
  expect(place.pill.x).toBe(fresh.x + 0.5);
  old.resolve({ x: 40, y: 40, width: 1, height: 20 });
  await new Promise<void>(queueMicrotask);
  await new Promise<void>(queueMicrotask);
  expect(controller.pillPlace).toEqual(place);
  controller.refreshPlacement();
  expect(controller.pillPlace).toEqual(place);
  expect(window.visible()).toBe(true);
});
