// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { Rect } from "../src/core/overlayGeometry.js";
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
});
