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
  "hide" | "isVisible" | "setBounds" | "getBounds" | "setOpacity" | "setIgnoreMouseEvents" | "showInactive"
>;

/** How the overlay, at the chat window's tallest size while it shows, takes clicks on the chat (and,
 * while it shows, on the note for a text not pasted): only over it, by the page saying when the
 * pointer is over it (`pointerOver`), where the window can let clicks through while still passing the
 * pointer's moves to the page (macOS, Windows); or over its whole frame while either shows, where it
 * can't (Linux). There the app, an X11 client, never learns where the pointer is over a Wayland
 * window, so it can't look either; and cutting the window to the chat's shape (`setShape`) crashed
 * Xwayland on Ubuntu, and every X11 window with it, the app among them (2026-10-09). */
export type ChatHitTest = "pointer" | "frame";

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
   * so the page's last layout never shows in the chat's frame (the pill a frame away from where it is).
   * Linux has no window opacity (Electron: `setOpacity` "does nothing"); the page's own redraw does it. */
  private chatUnmeasured = false;
  /** The chat window closed and the overlay stays up, transparent and click-through, until it is
   * hidden or shown again: hidden at once, its last frame would still be the chat, which would then
   * show for a moment as the overlay next did (owner, 2026-10-04: "the previous answer briefly
   * blinks"). Meanwhile the page draws it closed (on Linux, with no window opacity, only that). */
  private chatClosing = false;
  /** The chat window closed and its page shrinks it into its pill (`chatCloseDurationSeconds`): the
   * overlay keeps the chat's frame, letting clicks through, until it has, then follows `phase`. */
  private chatShrinkTimer: ReturnType<typeof setTimeout> | null = null;
  private phase: Phase = { kind: "idle" };
  /** The overlay takes clicks: the pointer is over the chat window, or the note (`ChatHitTest`
   * "pointer"); or either shows (`ChatHitTest` "frame"). */
  private takesClicks = false;
  /** The note for a text not pasted shows, and copies it when clicked (ADR-DESK-042). */
  private note = false;
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
    this.phase = phase;
    if (this.note && phase.kind !== "notPasted") this.endNote();
    if (chatOpen) {
      this.cancelChatShrink();
      this.cancelHide();
      if (this.chat === null) this.showChat();
      return;
    }
    if (this.chat !== null) {
      // Never shown yet (not measured, the overlay transparent): nothing to shrink.
      if (!this.chatUnmeasured) return this.shrinkChat();
      this.hideChat();
    }
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
      case "notPasted":
        // Not pasted where the user spoke: the note goes where the user is now, at the mouse
        // pointer (ADR-DESK-042), and takes clicks once the page says where it is, or at once.
        if (this.note) return;
        this.cancelHide();
        this.lookupGeneration += 1;
        this.lookupPending = false;
        this.anchor = this.pointer();
        this.note = true;
        this.takesClicks = false;
        if (this.chatHitTest === "frame") this.takeClicks(true);
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
    // Placed once the closing chat has shrunk.
    if (this.chatShrinkTimer !== null) return;
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
    if (this.chat === null || this.chatShrinkTimer !== null) return;
    this.measuredChatHeight = height;
    if (!this.chatUnmeasured) return;
    this.chatUnmeasured = false;
    this.window.setOpacity(1);
    // Placed under a pointer that has not moved since: it takes clicks there already.
    const pointer = screen.getCursorScreenPoint();
    const frame = this.chatFrame(height);
    if (pointer.x >= frame.x && pointer.x < frame.x + frame.width && pointer.y >= frame.y && pointer.y < frame.y + frame.height) this.pointerOver(true);
  }

  /** The pointer went over the chat window or the note, or off it (`ChatHitTest`): the overlay takes
   * clicks only over it, letting the rest through to the app under it. */
  pointerOver(over: boolean): void {
    if ((this.chat === null && !this.note) || this.chatShrinkTimer !== null || this.chatHitTest !== "pointer") return;
    this.takeClicks(over);
  }

  private takeClicks(over: boolean): void {
    if (over === this.takesClicks) return;
    this.takesClicks = over;
    this.window.setIgnoreMouseEvents(!over, { forward: true });
  }

  /** The note went: the whole overlay lets clicks through again. */
  private endNote(): void {
    this.note = false;
    this.takesClicks = false;
    this.window.setIgnoreMouseEvents(true, { forward: true });
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
    // Clicks only once the pointer is over the chat, which the page says as it moves; or over the frame.
    this.takesClicks = false;
    this.window.setIgnoreMouseEvents(true, { forward: true });
    if (this.chatHitTest === "frame") this.takeClicks(true);
    this.window.setBounds(rounded(this.chatFrame(this.chat.side.maxHeight)));
    this.window.showInactive();
    this.onPlace?.();
  }

  private chatFrame(height: number): Rect {
    const chat = this.chat;
    if (chat === null) throw new Error("no chat window");
    return chatWindowFrame(chat.pill, height, chat.workArea, chat.side, chat.bubblesUnder);
  }

  /** The chat window closed: its page shrinks it into its pill, letting clicks through meanwhile, and
   * then the overlay leaves its frame and follows the phase of that moment. Once, however often told. */
  private shrinkChat(): void {
    if (this.chatShrinkTimer !== null) return;
    this.takesClicks = false;
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.chatShrinkTimer = setTimeout(() => {
      this.chatShrinkTimer = null;
      this.hideChat();
      this.update(this.phase, false);
      this.onPlace?.();
    }, config.chatCloseDurationSeconds * 1000);
  }

  private cancelChatShrink(): void {
    if (this.chatShrinkTimer === null) return;
    clearTimeout(this.chatShrinkTimer);
    this.chatShrinkTimer = null;
    // Reopened as it shrank (a follow-up): it takes clicks again over its frame.
    if (this.chat !== null && this.chatHitTest === "frame") this.takeClicks(true);
  }

  private hideChat(): void {
    this.chat = null;
    this.chatUnmeasured = false;
    this.chatClosing = true;
    this.window.setOpacity(0);
    this.takesClicks = false;
    // Click-through, the pointer's moves still reaching the page (a bubble's hover).
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
    // The not-pasted note keeps room under the pill's top for all of it, as tall as it gets.
    const origin = overlayOrigin(anchor, config.overlayCanvasSize, config.pillHeight, workArea, this.note ? config.noteMaxHeight : undefined);
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
