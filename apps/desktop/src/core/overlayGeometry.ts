// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "./config.js";

/** A rectangle in screen points, top-left origin, y growing down: as Electron's `screen` and the
 * helpers' Accessibility rects give it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const maxX = (rect: Rect): number => rect.x + rect.width;
export const maxY = (rect: Rect): number => rect.y + rect.height;
export const midX = (rect: Rect): number => rect.x + rect.width / 2;
export const midY = (rect: Rect): number => rect.y + rect.height / 2;

/**
 * Window origin that puts the pill's top edge just below the caret's line (the pill just above the
 * line when there's no room below), centred horizontally on the caret and kept inside the display's
 * work area with a tip under it. The canvas is larger than the pill (room for the swirl); the
 * one-line pill sits vertically centred in it and taller pills grow downward.
 */
export function overlayOrigin(anchor: Rect, canvas: Size, pillHeight: number, workArea: Rect): Point {
  const gap = config.overlayCaretGap;
  const pillTopInset = (canvas.height - pillHeight) / 2;
  let pillTop = maxY(anchor) + gap;
  if (opensUpward(anchor, pillHeight, workArea)) pillTop = anchor.y - gap - pillHeight;
  pillTop = Math.min(Math.max(pillTop, workArea.y), maxY(workArea) - heightUnderPillTop(pillHeight));
  let x = midX(anchor) - canvas.width / 2;
  x = Math.min(Math.max(x, workArea.x), maxX(workArea) - canvas.width);
  return { x, y: pillTop - pillTopInset };
}

/** Whether the pill goes above the caret's line, there being no room below for the listening pill
 * and a tip under it. */
export function opensUpward(anchor: Rect, pillHeight: number, workArea: Rect): boolean {
  return maxY(anchor) + config.overlayCaretGap + heightUnderPillTop(pillHeight) > maxY(workArea);
}

/** The listening pill and a tip under it, from the pill's top edge down. */
function heightUnderPillTop(pillHeight: number): number {
  return Math.max(pillHeight, config.listeningPillHeight) + config.tipFootprint;
}

/** Whether a row of agent mode's bubbles fits under the pill, with the tip under it
 * (`bubbleCentres`): not when the pill opened above the caret's line (`opensUpward`), where they
 * would cover it, nor when it sits too near the bottom of the work area. */
export function bubblesFitUnder(anchor: Rect, pillHeight: number, workArea: Rect): boolean {
  const row = config.agentBubbleGap + config.agentBubbleDiameter;
  return maxY(anchor) + config.overlayCaretGap + heightUnderPillTop(pillHeight) + row <= maxY(workArea);
}

/** Centres of agent mode's bubbles, of `sizes`, around a pill at `pill`, `agentBubbleGap` clear of it
 * and apart (owner, 2026-09-26: "many bubbles surround the pill"): a row of up to
 * `agentBubbleRowCapacity` centred over the pill, then one beside it on the left and one on the
 * right, then rows centred under it, or over the first row when they don't fit under it
 * (`underFits`, `bubblesFitUnder`). */
export function bubbleCentres(pill: Rect, sizes: Size[], underFits: boolean): Point[] {
  const gap = config.agentBubbleGap;
  const capacity = config.agentBubbleRowCapacity;
  const centres: Point[] = [];
  /** A row centred on the pill, its bottom edge at `edge` (above) or its top edge (under). */
  const place = (row: Size[], edge: number, above: boolean) => {
    const rowWidth = row.reduce((sum, size) => sum + size.width, 0) + gap * Math.max(row.length - 1, 0);
    let x = midX(pill) - rowWidth / 2;
    for (const size of row) {
      centres.push({ x: x + size.width / 2, y: above ? edge - size.height / 2 : edge + size.height / 2 });
      x += size.width + gap;
    }
  };
  const height = (row: Size[]) => Math.max(0, ...row.map((size) => size.height));

  const top = sizes.slice(0, capacity);
  place(top, pill.y - gap, true);
  const [left, right] = sizes.slice(capacity, capacity + 2);
  if (left) centres.push({ x: pill.x - gap - left.width / 2, y: midY(pill) });
  if (right) centres.push({ x: maxX(pill) + gap + right.width / 2, y: midY(pill) });
  let edge = underFits ? maxY(pill) + gap : pill.y - gap - height(top) - gap;
  for (let start = capacity + 2; start < sizes.length; start += capacity) {
    const row = sizes.slice(start, start + capacity);
    place(row, edge, !underFits);
    edge += underFits ? height(row) + gap : -(height(row) + gap);
  }
  return centres;
}

/** Centre of the hovered bubble's tooltip, of `size`: centred over the bubble at `bubble`
 * (`bubbleTooltipGap` clear of it), or under it when there is no room over it in a canvas of `canvas`,
 * moved sideways to stay inside the canvas. */
export function bubbleTooltipCentre(bubble: Rect, size: Size, canvas: Size): Point {
  const gap = config.bubbleTooltipGap;
  const over = bubble.y - gap - size.height >= 0;
  const x = Math.min(Math.max(midX(bubble), size.width / 2), canvas.width - size.width / 2);
  return { x, y: over ? bubble.y - gap - size.height / 2 : maxY(bubble) + gap + size.height / 2 };
}

/** A bubble at `bubble` grown to `scale` upward from its bottom edge, as the page draws it
 * (`transform-origin: bottom center`). */
export function grownBubble(bubble: Rect, scale: number): Rect {
  const width = bubble.width * scale;
  const height = bubble.height * scale;
  return { x: midX(bubble) - width / 2, y: maxY(bubble) - height, width, height };
}

/** The pill with any bubbles under it: what a tip under the pill goes under (`hintCentre`). */
export function underBubbles(pill: Rect, bubbles: Rect[]): Rect {
  const bottom = bubbles.reduce((most, bubble) => Math.max(most, maxY(bubble)), maxY(pill));
  return { ...pill, height: bottom - pill.y };
}

/** Centre of a tip, of `size`: a tooltip centred `tipGap` under a pill at `pill` (and any bubbles
 * under it, `underBubbles`) (owner,
 * 2026-09-26: "a tooltip that appears below the middle and disappears after a little"). A tip that
 * fades after its display duration covers the caret's line only briefly, even in an overlay opened
 * above that line; one that stays up goes over the pill there (`tipGoesAbove`). */
export function hintCentre(pill: Rect, size: Size): Point {
  return { x: midX(pill), y: maxY(pill) + config.tipGap + size.height / 2 };
}

/** Centre of a tip, of `size`, over the pill instead: a tooltip centred `tipGap` over a pill at
 * `pill`, or over agent mode's bubbles at `bubbles` when they show. */
export function hintCentreOver(pill: Rect, bubbles: Rect[], size: Size): Point {
  const top = bubbles.reduce((least, bubble) => Math.min(least, bubble.y), pill.y);
  return { x: midX(pill), y: top - config.tipGap - size.height / 2 };
}

/** Whether a tip goes over the pill: when it stays up while listening (no display duration, as
 * the hands-free tip) and the overlay opened above the caret's line, so it never covers that line
 * for the whole dictation (owner, 2026-09-27: "above pill when opening up"). */
export function tipGoesAbove(displayDuration: number | null, opensUpward: boolean): boolean {
  return opensUpward && displayDuration === null;
}

/** Whether the chat window opens above the caret's line: there is no room below it for the window at
 * its tallest (so it never flips as it grows). */
export function chatOpensUpward(anchor: Rect, workArea: Rect): boolean {
  return maxY(anchor) + config.overlayCaretGap + config.chatMaxHeight > maxY(workArea);
}

/** The overlay window's frame for a chat window `contentHeight` tall (at most `chatMaxHeight`), with
 * its shadow margin: the chat's top edge where the pill's was, just below the caret's line, or its
 * bottom edge just above the line when it opens upward (`chatOpensUpward`); centred on the caret,
 * the chat itself kept inside the work area. */
export function chatFrame(anchor: Rect, contentHeight: number, workArea: Rect): Rect {
  const margin = config.chatShadowMargin;
  const gap = config.overlayCaretGap;
  const width = config.chatWidth + 2 * margin;
  const height = Math.min(contentHeight, config.chatMaxHeight) + 2 * margin;
  let y = chatOpensUpward(anchor, workArea) ? anchor.y - gap + margin - height : maxY(anchor) + gap - margin;
  y = Math.min(Math.max(y, workArea.y - margin), maxY(workArea) + margin - height);
  let x = midX(anchor) - width / 2;
  x = Math.min(Math.max(x, workArea.x - margin), maxX(workArea) + margin - width);
  return { x, y, width, height };
}
