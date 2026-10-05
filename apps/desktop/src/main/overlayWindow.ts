// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type BrowserWindow, screen } from "electron";
import * as config from "../core/config.js";
import type { Phase } from "../core/dictation/controller.js";
import { errorName, log } from "../core/log.js";
import { bubblesFitUnder, chatSide, chatWindowFrame, opensUpward, overlayOrigin, type Point, pillPosition, type Rect } from "../core/ui/overlayGeometry.js";
import type { ChatPlacement } from "../shared/ipc.js";

/** Presentation operations used by the shared placement controller. A platform may present the
 * same renderer through a native window without duplicating caret or chat placement logic. */
export type OverlaySurface = Pick<BrowserWindow,
  "hide" | "isVisible" | "setBounds" | "getBounds" | "setOpacity" | "setIgnoreMouseEvents" | "setShape" | "showInactive"
>;

/** How the overlay, at the chat window's tallest size while it shows, takes clicks only on the chat:
 * by the page saying when the pointer is over it (`chatPointer`), where the window can let clicks
 * through while still passing the pointer's moves to the page (macOS, Windows); or cut to the chat's
 * shape (`setShape`), where it can't (Linux). */
export type ChatHitTest = "pointer" | "shape";

/**
 * Shows the overlay window, anchored at the text cursor, as the dictation goes: hidden while the
 * hold is arming (the caret is looked up then), shown from listening on using the caret if ready
 * or the fallback position otherwise, and hidden once the exit animation has played. While the chat
 * window is open the overlay grows to show it over the pill, which stays where it was, and takes the
 * mouse over it. The window never takes focus, so the target field keeps it and receives the paste.
 */
export class OverlayWindowController {
  private anchor: Rect | null = null;
  private requestedChat = false;
  private requestedPill = false;
  private lookupGeneration = 0;
  private lookupPending = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** The overlay last opened above the caret's line (`opensUpward`), which the view places its tip
   * by (`tipGoesAbove`). */
  private placedUpward = false;
  /** A row of agent mode's bubbles fit under the pill where it was last placed (`bubblesFitUnder`). */
  private placedBubblesFitUnder = true;
  /** Where the chat window opened, while it shows: by the pill (its top edge's center), which stays
   * there for follow-ups, its bubbles under it or over it as they were, on the side of them with room
   * (`chatSide`). */
  private chat: { pill: Point; workArea: Rect; side: { below: boolean; maxHeight: number }; bubblesUnder: boolean } | null = null;
  /** The chat window opened and its page hasn't measured it yet: the overlay is transparent meanwhile,
   * so the page's last layout never shows in the chat's frame (the pill a frame away from where it is). */
  private chatUnmeasured = false;
  /** The chat window closed and the overlay stays up, transparent and click-through, until it is
   * hidden or shown again: hidden at once, its last frame would still be the chat, which would then
   * show for a moment as the overlay next did (owner, 2026-10-04: "the previous answer briefly
   * blinks"). Meanwhile the page draws it closed. */
  private chatClosing = false;
  /** The overlay takes clicks: the pointer is over the chat window (`ChatHitTest` "pointer"). */
  private chatTakesClicks = false;
  private measuredChatHeight: number | null = null;
  /** The overlay was placed afresh: its view's state changed. */
  onPlace: (() => void) | undefined;

  constructor(
    private readonly window: OverlaySurface,
    /** The caret's rect in the app in front, in top-left screen points; null when it has none. */
    private readonly locateCaret: () => Promise<Rect | null>,
    /** Optional platform restriction, such as regions outside Windows Start/Search. */
    private readonly placementArea?: (workArea: Rect) => Rect | null,
    /** A platform's safe position when global caret coordinates are unavailable. */
    private readonly fallbackAnchor?: (workArea: Rect) => Rect,
    private readonly chatHitTest: ChatHitTest = "pointer",
  ) {}

  get opensUpward(): boolean {
    return this.placedUpward;
  }

  get bubblesFitUnder(): boolean {
    return this.placedBubblesFitUnder;
  }

  /** Where the pill of the hold under way shows, or would: at the caret the request was spoken over,
   * or the pointer without one (`pillPosition`, its top edge's center), with its display's work area
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
    return { ...chat.side, ...(chat.workArea.width < config.chatWidth ? { width: chat.workArea.width } : {}), bubblesUnder: chat.bubblesUnder, pillX: chat.pill.x - Math.round(this.chatFrame(chat.side.maxHeight).x) };
  }

  /** Shows the overlay for `phase`, and the chat window over its pill while it is open (`chatOpen`),
   * where it opened: a follow-up's pill shows under it. */
  update(phase: Phase, chatOpen = false): void {
    this.requestedChat = chatOpen;
    this.requestedPill = phase.kind !== "idle" && phase.kind !== "arming";
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
        return;
      case "copied":
        // Not pasted where the user spoke: the note goes where the user is now, at the mouse
        // pointer (ADR-DESK-042).
        this.cancelHide();
        this.lookupGeneration += 1;
        this.lookupPending = false;
        this.anchor = this.pointer();
        this.show();
        return;
      case "arming":
        // A new hold during the previous exit animation: start clean, at the new caret. A chat
        // window just closed stays up, transparent, while its page draws it closed.
        this.cancelHide();
        if (!this.chatClosing) this.window.hide();
        this.lookUpCaret();
        return;
      default:
        if (this.window.isVisible() && !this.chatClosing) return;
        if (this.lookupPending) {
          // The reveal must not wait for accessibility. Keep this hold at its fallback
          // position rather than jumping when a late caret lookup eventually finishes.
          this.lookupGeneration += 1;
          this.lookupPending = false;
        }
        this.show();
    }
  }

  /** Recompute after a platform exclusion or display changes, including recovery when a shell
   * surface previously left no usable space. Never reveals an idle or still-arming hold. */
  refreshPlacement(): void {
    if (this.requestedChat) {
      if (this.chat !== null) this.hideChat();
      this.showChat();
      // A move with unchanged content dimensions need not trigger ResizeObserver again.
      // Reuse the last measured height; a changed width will send a fresh measurement.
      if (this.measuredChatHeight !== null) this.fitChat(this.measuredChatHeight);
    } else if (this.requestedPill && !this.lookupPending) {
      this.show();
    }
  }

  /** The chat window measured itself: only that much of the overlay catches clicks. The overlay stays
   * at the chat's tallest size meanwhile, the page growing the chat in it: resized as the chat grew,
   * it showed each frame a moment out of place, before the page drew the next (owner, 2026-10-04:
   * "the animation is super clunky"). */
  fitChat(height: number): void {
    if (this.chat === null) return;
    this.measuredChatHeight = height;
    if (this.chatHitTest === "shape") this.window.setShape([this.chatShape(height)]);
    if (!this.chatUnmeasured) return;
    this.chatUnmeasured = false;
    this.window.setOpacity(1);
    // Placed under a pointer that has not moved since: it takes clicks there already.
    const pointer = screen.getCursorScreenPoint();
    const frame = this.chatFrame(height);
    if (pointer.x >= frame.x && pointer.x < frame.x + frame.width && pointer.y >= frame.y && pointer.y < frame.y + frame.height) this.chatPointer(true);
  }

  /** The pointer went over the chat window, or off it (`ChatHitTest`): the overlay takes clicks only
   * over it, letting the rest through to the app under it. */
  chatPointer(over: boolean): void {
    if (this.chat === null || this.chatHitTest !== "pointer" || over === this.chatTakesClicks) return;
    this.chatTakesClicks = over;
    this.window.setIgnoreMouseEvents(!over, { forward: true });
  }

  /** Opens the chat window over the pill, which stays where it is, at the caret the request was
   * spoken over, or the pointer where it was then without one (`pillPosition`, as `position` placed
   * it). A caret lookup still under way is dropped: the window stays where it opened. */
  private showChat(): void {
    this.lookupGeneration += 1;
    this.lookupPending = false;
    const anchor = this.anchor ?? this.pointer();
    if (!this.hasPlacementArea(anchor)) { this.window.hide(); return; }
    const workArea = this.workArea(anchor);
    // Rounded as `position` placed the canvas, so the pill doesn't move by a fraction of a point.
    const origin = overlayOrigin(anchor, config.overlayCanvasSize, config.pillHeight, workArea);
    const pill = pillPosition(anchor, workArea);
    const shift = { x: Math.round(origin.x) - origin.x, y: Math.round(origin.y) - origin.y };
    const bubblesUnder = bubblesFitUnder(anchor, config.pillHeight, workArea);
    this.chat = { pill: { x: pill.x + shift.x, y: pill.y + shift.y }, workArea, side: chatSide(pill.y, bubblesUnder, workArea), bubblesUnder };
    this.chatClosing = false;
    this.chatUnmeasured = true;
    this.window.setOpacity(0);
    if (this.chatHitTest === "shape") {
      this.window.setShape([this.chatShape(0)]);
      this.window.setIgnoreMouseEvents(false);
    } else {
      // Clicks only once the pointer is over the chat, which the page says as it moves.
      this.chatTakesClicks = false;
      this.window.setIgnoreMouseEvents(true, { forward: true });
    }
    this.window.setBounds(rounded(this.chatFrame(this.chat.side.maxHeight)));
    this.window.showInactive();
    this.onPlace?.();
  }

  private chatFrame(height: number): Rect {
    const chat = this.chat;
    if (chat === null) throw new Error("no chat window");
    return chatWindowFrame(chat.pill, height, chat.workArea, chat.side, chat.bubblesUnder);
  }

  /** The chat window `height` tall, with its shadow and the pill's strip, in the overlay at the chat's
   * tallest size. */
  private chatShape(height: number): Rect {
    const side = this.chat?.side;
    if (side === undefined) throw new Error("no chat window");
    const tallest = rounded(this.chatFrame(side.maxHeight));
    const frame = rounded(this.chatFrame(height));
    return { x: frame.x - tallest.x, y: frame.y - tallest.y, width: frame.width, height: frame.height };
  }

  private hideChat(): void {
    this.chat = null;
    this.chatUnmeasured = false;
    this.chatClosing = true;
    this.window.setOpacity(0);
    // The whole window again (an empty list), click-through, the pointer's moves still reaching the
    // page (a bubble's hover).
    if (this.chatHitTest === "shape") this.window.setShape([]);
    this.window.setIgnoreMouseEvents(true, { forward: true });
  }

  private show(): void {
    if (!this.hasPlacementArea(this.anchor ?? this.pointer())) { this.window.hide(); return; }
    this.position();
    if (this.chatClosing) {
      this.chatClosing = false;
      this.window.setOpacity(1);
    }
    this.window.showInactive();
  }

  private lookUpCaret(): void {
    this.lookupGeneration += 1;
    const current = this.lookupGeneration;
    this.anchor = null;
    this.lookupPending = true;
    void this.locateCaret()
      .catch((error: unknown) => {
        log.debug(`OverlayWindowController: caret lookup failed: ${errorName(error)}`);
        return null;
      })
      .then((caret) => {
        if (this.lookupGeneration !== current) return;
        this.anchor = caret;
        this.lookupPending = false;
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
    if (this.fallbackAnchor) return this.fallbackAnchor(screen.getDisplayNearestPoint(mouse).workArea);
    return { x: mouse.x, y: mouse.y, width: 1, height: 1 };
  }

  private hasPlacementArea(anchor: Rect): boolean {
    const area = screen.getDisplayNearestPoint({ x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height / 2) }).workArea;
    return this.placementArea === undefined || this.placementArea(area) !== null;
  }

  /** The work area of the display `anchor` is on. */
  private workArea(anchor: Rect): Rect {
    const display = screen.getDisplayNearestPoint({ x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height / 2) }).workArea;
    return this.placementArea?.(display) ?? display;
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}

function rounded(frame: Rect): Rect {
  return { x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height) };
}
