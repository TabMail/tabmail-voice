// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type BrowserWindow, screen } from "electron";
import * as config from "../core/config.js";
import type { Phase } from "../core/dictationController.js";
import { errorName, log } from "../core/log.js";
import { bubblesFitUnder, chatFrame, chatOpensUpward, opensUpward, overlayOrigin, type Rect } from "../core/overlayGeometry.js";

/**
 * Shows the overlay window, anchored at the text cursor, as the dictation goes: hidden while the
 * hold is arming (the caret is looked up then, so the overlay appears there the moment the hold is
 * revealed), shown from listening on, and hidden once the exit animation has played. While the chat
 * window is open the overlay shows it instead, where the pill was, and takes the mouse. The window
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
  /** The overlay last opened above the caret's line (`opensUpward`), which the view places its tip
   * by (`tipGoesAbove`). */
  private placedUpward = false;
  /** A row of agent mode's bubbles fit under the pill where it was last placed (`bubblesFitUnder`). */
  private placedBubblesFitUnder = true;
  /** Where the chat window opened, while it shows: it stays there for follow-ups. */
  private chat: { anchor: Rect; workArea: Rect; opensUpward: boolean } | null = null;
  /** The overlay was placed afresh: its view's state changed. */
  onPlace: (() => void) | undefined;

  constructor(
    private readonly window: BrowserWindow,
    /** The caret's rect in the app in front, in top-left screen points; null when it has none. */
    private readonly locateCaret: () => Promise<Rect | null>,
  ) {}

  get opensUpward(): boolean {
    return this.placedUpward;
  }

  get bubblesFitUnder(): boolean {
    return this.placedBubblesFitUnder;
  }

  /** The chat window opened above the caret's line (`chatOpensUpward`). */
  get chatOpensUpward(): boolean {
    return this.chat?.opensUpward ?? false;
  }

  /** Shows the overlay for `phase`, or the chat window while it is open (`chatOpen`): a follow-up's
   * status shows inside it, and it stays where it opened. */
  update(phase: Phase, chatOpen = false): void {
    if (chatOpen) {
      this.cancelHide();
      if (this.chat === null) this.showChat();
      return;
    }
    if (this.chat !== null) this.hideChat();
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

  /** The chat window measured itself: the overlay takes its height, so no empty part of the window
   * catches clicks. */
  fitChat(height: number): void {
    if (this.chat === null) return;
    this.window.setBounds(rounded(chatFrame(this.chat.anchor, height, this.chat.workArea)));
  }

  /** Grows the chat window out of the pill, at the caret the answered request was spoken over. A
   * caret lookup still under way is dropped: the window stays where it opened. */
  private showChat(): void {
    this.lookupGeneration += 1;
    this.lookupPending = false;
    this.showWhenLocated = false;
    const anchor = this.anchor ?? this.pointer();
    const workArea = this.workArea(anchor);
    this.chat = { anchor, workArea, opensUpward: chatOpensUpward(anchor, workArea) };
    this.window.setIgnoreMouseEvents(false);
    this.window.setBounds(rounded(chatFrame(anchor, config.chatMaxHeight, workArea)));
    this.window.showInactive();
    this.onPlace?.();
  }

  private hideChat(): void {
    this.chat = null;
    this.window.setIgnoreMouseEvents(true);
    this.window.hide();
    this.window.setBounds({ ...this.window.getBounds(), ...config.overlayCanvasSize });
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
    // Without a caret (the app doesn't expose one), gather at the mouse pointer.
    const anchor = this.anchor ?? this.pointer();
    const workArea = this.workArea(anchor);
    const origin = overlayOrigin(anchor, config.overlayCanvasSize, config.pillHeight, workArea);
    this.window.setBounds({ x: Math.round(origin.x), y: Math.round(origin.y), ...config.overlayCanvasSize });
    this.placedUpward = opensUpward(anchor, config.pillHeight, workArea);
    this.placedBubblesFitUnder = bubblesFitUnder(anchor, config.pillHeight, workArea);
    this.onPlace?.();
  }

  private pointer(): Rect {
    const mouse = screen.getCursorScreenPoint();
    return { x: mouse.x, y: mouse.y, width: 1, height: 1 };
  }

  /** The work area of the display `anchor` is on. */
  private workArea(anchor: Rect): Rect {
    return screen.getDisplayNearestPoint({ x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height / 2) }).workArea;
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}

function rounded(frame: Rect): Rect {
  return { x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height) };
}
