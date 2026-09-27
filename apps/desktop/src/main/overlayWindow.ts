// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type BrowserWindow, screen } from "electron";
import * as config from "../core/config.js";
import type { Phase } from "../core/dictationController.js";
import { errorName, log } from "../core/log.js";
import { overlayOrigin, type Rect } from "../core/overlayGeometry.js";

/**
 * Shows the overlay window, anchored at the text cursor, as the dictation goes: hidden while the
 * hold is arming (the caret is looked up then, so the overlay appears there the moment the hold is
 * revealed), shown from listening on, and hidden once the exit animation has played. The window
 * never takes focus, so the target field keeps it and receives the paste.
 */
export class OverlayWindowController {
  private anchor: Rect | null = null;
  private lookupGeneration = 0;
  private lookupPending = false;
  /** The hold was revealed before the caret lookup finished: show once it does, so the overlay
   * never flashes at the mouse pointer and then jumps. */
  private showWhenLocated = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly window: BrowserWindow,
    /** The caret's rect in the app in front, in top-left screen points; null when it has none. */
    private readonly locateCaret: () => Promise<Rect | null>,
  ) {}

  update(phase: Phase): void {
    switch (phase.kind) {
      case "idle":
        this.cancelHide();
        this.hideTimer = setTimeout(() => {
          this.hideTimer = null;
          this.window.hide();
        }, config.overlayDismissDuration);
        this.anchor = null;
        this.lookupGeneration += 1;
        this.lookupPending = false;
        this.showWhenLocated = false;
        return;
      case "arming":
        // A new hold during the previous exit animation: start clean, at the new caret.
        this.cancelHide();
        this.window.hide();
        this.lookUpCaret();
        return;
      default:
        if (this.window.isVisible()) return;
        if (this.lookupPending) {
          this.showWhenLocated = true;
          return;
        }
        this.show();
    }
  }

  private show(): void {
    this.showWhenLocated = false;
    this.position();
    this.window.showInactive();
  }

  private lookUpCaret(): void {
    this.lookupGeneration += 1;
    const current = this.lookupGeneration;
    this.anchor = null;
    this.lookupPending = true;
    this.showWhenLocated = false;
    void this.locateCaret()
      .catch((error: unknown) => {
        log.debug(`OverlayWindowController: caret lookup failed: ${errorName(error)}`);
        return null;
      })
      .then((caret) => {
        if (this.lookupGeneration !== current) return;
        this.anchor = caret;
        this.lookupPending = false;
        if (this.showWhenLocated) this.show();
        else if (this.window.isVisible()) this.position();
      });
  }

  private position(): void {
    const mouse = screen.getCursorScreenPoint();
    // Without a caret (the app doesn't expose one), gather at the mouse pointer.
    const anchor = this.anchor ?? { x: mouse.x, y: mouse.y, width: 1, height: 1 };
    const display = screen.getDisplayNearestPoint({ x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height / 2) });
    const origin = overlayOrigin(anchor, config.overlayCanvasSize, config.pillHeight, display.workArea);
    this.window.setBounds({ x: Math.round(origin.x), y: Math.round(origin.y), ...config.overlayCanvasSize });
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}
