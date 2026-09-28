// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test, vi } from "vitest";
import { deferred } from "./support.js";
import type { BrowserWindow } from "electron";
import * as config from "../src/core/config.js";
import { chatFrame, type Rect } from "../src/core/overlayGeometry.js";
import { OverlayWindowController } from "../src/main/overlayWindow.js";

/** One display, and the mouse pointer in its middle. */
const workArea = { x: 0, y: 0, width: 1440, height: 900 };
vi.mock("electron", () => ({
  screen: {
    getCursorScreenPoint: () => ({ x: 720, y: 450 }),
    getDisplayNearestPoint: () => ({ workArea }),
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
  } as unknown as BrowserWindow;
}

/** An overlay window that keeps its bounds and whether it lets the mouse through. */
function recordingWindow(): { window: BrowserWindow; bounds: () => Rect; ignoresMouse: () => boolean; visible: () => boolean } {
  let visible = false;
  let ignoresMouse = true;
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
    },
    getBounds: () => bounds,
    setIgnoreMouseEvents: (ignore: boolean) => {
      ignoresMouse = ignore;
    },
  } as unknown as BrowserWindow;
  return { window, bounds: () => bounds, ignoresMouse: () => ignoresMouse, visible: () => visible };
}

function rounded(frame: Rect): Rect {
  return { x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height) };
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

  /** The overlay takes the mouse, as the chat window, grown out of the pill at the caret the request
   * was spoken over, only while the chat is open; it fits the height the chat window measures, and
   * closed it lets every click through again, at the pill's size, hidden. */
  test("the chat window takes the mouse only while it is open", async () => {
    const caret: Rect = { x: 400, y: 300, width: 1, height: 16 };
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => caret);
    const placed: boolean[] = [];
    controller.onPlace = () => placed.push(controller.chatOpensUpward);
    controller.update({ kind: "arming" });
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(placed).toHaveLength(1));
    expect(overlay.ignoresMouse()).toBe(true);

    controller.update({ kind: "running", tool: "answer" }, true);
    expect(overlay.ignoresMouse()).toBe(false);
    expect(overlay.visible()).toBe(true);
    expect(overlay.bounds()).toEqual(rounded(chatFrame(caret, config.chatMaxHeight, workArea)));
    expect(overlay.bounds().width).toBe(config.chatWidth + 2 * config.chatShadowMargin);
    expect(placed).toEqual([false, false]);
    controller.fitChat(120);
    expect(overlay.bounds()).toEqual(rounded(chatFrame(caret, 120, workArea)));

    // The request's end, and a follow-up, leave it open where it is.
    controller.update({ kind: "idle" }, true);
    controller.update({ kind: "arming" }, true);
    expect(overlay.bounds()).toEqual(rounded(chatFrame(caret, 120, workArea)));
    expect(overlay.visible()).toBe(true);

    controller.update({ kind: "idle" }, false);
    expect(overlay.ignoresMouse()).toBe(true);
    expect(overlay.visible()).toBe(false);
    expect(overlay.bounds()).toMatchObject(config.overlayCanvasSize);
    controller.fitChat(200);
    expect(overlay.bounds()).toMatchObject(config.overlayCanvasSize);
  });

  /** At a caret near the screen's bottom the chat window opens upward, and says so. */
  test("near the bottom the chat window opens upward", async () => {
    const caret: Rect = { x: 400, y: workArea.height - 40, width: 1, height: 16 };
    const overlay = recordingWindow();
    const controller = new OverlayWindowController(overlay.window, async () => caret);
    controller.update({ kind: "arming" });
    controller.update({ kind: "listening" });
    await vi.waitFor(() => expect(overlay.visible()).toBe(true));

    controller.update({ kind: "running", tool: "answer" }, true);

    expect(controller.chatOpensUpward).toBe(true);
    expect(overlay.bounds().y + overlay.bounds().height).toBeLessThanOrEqual(workArea.height + config.chatShadowMargin);
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
