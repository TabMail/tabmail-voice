// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type BrowserWindow, screen } from "electron";
import * as config from "../core/config.js";
import type { Phase } from "../core/dictationController.js";
import { errorName, log } from "../core/log.js";
import { bubblesFitUnder, chatSide, chatWindowFrame, opensUpward, overlayOrigin, type Point, pillPosition, type Rect } from "../core/overlayGeometry.js";
import type { ChatPlacement } from "../shared/ipc.js";

/**
 * Shows the overlay window, anchored at the text cursor, as the dictation goes: hidden while the
 * hold is arming (the caret is looked up then, so the overlay appears there the moment the hold is
 * revealed), shown from listening on, and hidden once the exit animation has played. While the chat
 * window is open the overlay grows to show it over the pill, which stays where it was, and takes the
 * mouse. The window never takes focus, so the target field keeps it and receives the paste.
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
  /** Where the chat window opened, while it shows: by the pill (its top edge's centre), which stays
   * there for follow-ups, its bubbles under it or over it as they were, on the side of them with room
   * (`chatSide`). */
  private chat: { pill: Point; workArea: Rect; side: { below: boolean; maxHeight: number }; bubblesUnder: boolean } | null = null;
  /** The chat window opened and its page hasn't measured it yet: the overlay is transparent meanwhile,
   * so the page's last layout never shows in the chat's frame (the pill a frame away from where it is). */
  private chatUnmeasured = false;
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

  /** Where the pill of the hold under way shows, or would: at the caret the request was spoken over,
   * or the pointer without one (`pillPosition`, its top edge's centre), with its display's work area
   * and whether agent mode's bubbles go under it. The paste history opens by it, as the chat window
   * does (ADR-DESK-043). */
  get pillPlace(): { pill: Point; workArea: Rect; bubblesUnder: boolean } {
    const anchor = this.anchor ?? this.pointer();
    const workArea = this.workArea(anchor);
    return { pill: pillPosition(anchor, workArea), workArea, bubblesUnder: bubblesFitUnder(anchor, config.pillHeight, workArea) };
  }

  /** Where the chat window shows, while it does. */
  get chatPlacement(): ChatPlacement | null {
    const chat = this.chat;
    if (chat === null) return null;
    // In the window as placed, its origin rounded.
    return { ...chat.side, bubblesUnder: chat.bubblesUnder, pillX: chat.pill.x - Math.round(this.chatFrame(chat.side.maxHeight).x) };
  }

  /** Shows the overlay for `phase`, and the chat window over its pill while it is open (`chatOpen`),
   * where it opened: a follow-up's pill shows under it. */
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
      case "copied":
        // Not pasted where the user spoke: the note goes where the user is now, at the mouse
        // pointer (ADR-DESK-042).
        this.cancelHide();
        this.lookupGeneration += 1;
        this.lookupPending = false;
        this.showWhenLocated = false;
        this.anchor = this.pointer();
        this.show();
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
    this.window.setBounds(rounded(this.chatFrame(height)));
    if (!this.chatUnmeasured) return;
    this.chatUnmeasured = false;
    this.window.setOpacity(1);
  }

  /** Opens the chat window over the pill, which stays where it is, at the caret the request was
   * spoken over, or the pointer where it was then without one (`pillPosition`, as `position` placed
   * it). A caret lookup still under way is dropped: the window stays where it opened. */
  private showChat(): void {
    this.lookupGeneration += 1;
    this.lookupPending = false;
    this.showWhenLocated = false;
    const anchor = this.anchor ?? this.pointer();
    const workArea = this.workArea(anchor);
    // Rounded as `position` placed the canvas, so the pill doesn't move by a fraction of a point.
    const origin = overlayOrigin(anchor, config.overlayCanvasSize, config.pillHeight, workArea);
    const pill = pillPosition(anchor, workArea);
    const shift = { x: Math.round(origin.x) - origin.x, y: Math.round(origin.y) - origin.y };
    const bubblesUnder = bubblesFitUnder(anchor, config.pillHeight, workArea);
    this.chat = { pill: { x: pill.x + shift.x, y: pill.y + shift.y }, workArea, side: chatSide(pill.y, bubblesUnder, workArea), bubblesUnder };
    this.chatUnmeasured = true;
    this.window.setOpacity(0);
    this.window.setIgnoreMouseEvents(false);
    this.window.setBounds(rounded(this.chatFrame(this.chat.side.maxHeight)));
    this.window.showInactive();
    this.onPlace?.();
  }

  private chatFrame(height: number): Rect {
    const chat = this.chat;
    if (chat === null) throw new Error("no chat window");
    return chatWindowFrame(chat.pill, height, chat.workArea, chat.side, chat.bubblesUnder);
  }

  private hideChat(): void {
    this.chat = null;
    if (this.chatUnmeasured) {
      this.chatUnmeasured = false;
      this.window.setOpacity(1);
    }
    // Click-through again, the pointer's moves still reaching the page (a bubble's hover).
    this.window.setIgnoreMouseEvents(true, { forward: true });
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
    // Where it was placed, for the chat window to open there even if the pointer moves meanwhile.
    this.anchor = anchor;
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
