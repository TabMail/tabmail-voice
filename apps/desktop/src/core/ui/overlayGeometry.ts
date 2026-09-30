// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";

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
 * line when there's no room below), centered horizontally on the caret and kept inside the display's
 * work area with a tip under it. The canvas is larger than the pill (room for the swirl); the
 * one-line pill sits vertically centered in it and taller pills grow downward.
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
 * (`bubbleCenters`): not when the pill opened above the caret's line (`opensUpward`), where they
 * would cover it, nor when it sits too near the bottom of the work area. */
export function bubblesFitUnder(anchor: Rect, pillHeight: number, workArea: Rect): boolean {
  const row = config.agentBubbleGap + config.agentBubbleDiameter;
  return maxY(anchor) + config.overlayCaretGap + heightUnderPillTop(pillHeight) + row <= maxY(workArea);
}

/** Centers of agent mode's `count` bubbles, in one row under the pill at `pill`, `agentBubbleGap`
 * clear of it and `agentBubbleSpacing` apart (owner, 2026-09-28: "tools appear below the pill … only show like three or so,
 * and it just fades away to the right"): the first `agentBubbleRowVisibleCount` centered under the
 * pill, the rest going on to the right (`bubbleRowOpacity`). Over the pill instead when a row
 * doesn't fit under it (`underFits`, `bubblesFitUnder`), so it never covers the caret's line. */
export function bubbleRow(pill: Rect, count: number, underFits: boolean): Point[] {
  const diameter = config.agentBubbleDiameter;
  const step = diameter + config.agentBubbleSpacing;
  const visibleWidth = config.agentBubbleRowVisibleCount * step - config.agentBubbleSpacing;
  const left = midX(pill) - visibleWidth / 2 + diameter / 2;
  const y = underFits ? maxY(pill) + config.agentBubbleGap + diameter / 2 : pill.y - config.agentBubbleGap - diameter / 2;
  return Array.from({ length: count }, (_, index) => ({ x: left + index * step, y }));
}

/** How much of the row's bubble at `index` shows: all of the first `agentBubbleRowVisibleCount`, then
 * less and less for the next `agentBubbleRowFadeCount`, which fade away to the right; none after. */
export function bubbleRowOpacity(index: number): number {
  const faded = index - config.agentBubbleRowVisibleCount + 1;
  if (faded <= 0) return 1;
  return Math.max(0, 1 - faded / (config.agentBubbleRowFadeCount + 1));
}

/** Center of the hovered bubble's tooltip, of `size`: centered over the bubble at `bubble`
 * (`bubbleTooltipGap` clear of it), or under it when there is no room over it in a canvas of `canvas`,
 * moved sideways to stay inside the canvas. */
export function bubbleTooltipCenter(bubble: Rect, size: Size, canvas: Size): Point {
  const gap = config.bubbleTooltipGap;
  const over = bubble.y - gap - size.height >= 0;
  const x = Math.min(Math.max(midX(bubble), size.width / 2), canvas.width - size.width / 2);
  return { x, y: over ? bubble.y - gap - size.height / 2 : maxY(bubble) + gap + size.height / 2 };
}

/** A bubble at `bubble` grown to `scale` about its center, as the page draws it (`transform-origin:
 * center`), so it grows as far toward the pill as away from it, whichever side of it it is. */
export function grownBubble(bubble: Rect, scale: number): Rect {
  const width = bubble.width * scale;
  const height = bubble.height * scale;
  return { x: midX(bubble) - width / 2, y: bubble.y + bubble.height / 2 - height / 2, width, height };
}

/** The pill with any bubbles under it: what a tip under the pill goes under (`hintCenter`). */
export function underBubbles(pill: Rect, bubbles: Rect[]): Rect {
  const bottom = bubbles.reduce((most, bubble) => Math.max(most, maxY(bubble)), maxY(pill));
  return { ...pill, height: bottom - pill.y };
}

/** Center of a tip, of `size`: a tooltip centered `tipGap` under a pill at `pill` (and any bubbles
 * under it, `underBubbles`) (owner,
 * 2026-09-26: "a tooltip that appears below the middle and disappears after a little"). A tip that
 * fades after its display duration covers the caret's line only briefly, even in an overlay opened
 * above that line; one that stays up goes over the pill there (`tipGoesAbove`). */
export function hintCenter(pill: Rect, size: Size): Point {
  return { x: midX(pill), y: maxY(pill) + config.tipGap + size.height / 2 };
}

/** Center of a tip, of `size`, over the pill instead: a tooltip centered `tipGap` over a pill at
 * `pill`, or over agent mode's bubbles at `bubbles` when they show. */
export function hintCenterOver(pill: Rect, bubbles: Rect[], size: Size): Point {
  const top = bubbles.reduce((least, bubble) => Math.min(least, bubble.y), pill.y);
  return { x: midX(pill), y: top - config.tipGap - size.height / 2 };
}

/** Whether a tip goes over the pill: when it stays up while listening (no display duration, as
 * the hands-free tip) and the overlay opened above the caret's line, so it never covers that line
 * for the whole dictation (owner, 2026-09-27: "above pill when opening up"). */
export function tipGoesAbove(displayDuration: number | null, opensUpward: boolean): boolean {
  return opensUpward && displayDuration === null;
}

/** Where the pill sits on screen for a caret at `anchor`, as `overlayOrigin` places the overlay: its
 * center's x, and its top edge's y. */
export function pillPosition(anchor: Rect, workArea: Rect): Point {
  const canvas = config.overlayCanvasSize;
  const origin = overlayOrigin(anchor, canvas, config.pillHeight, workArea);
  return { x: origin.x + canvas.width / 2, y: origin.y + (canvas.height - config.pillHeight) / 2 };
}

/** The top edge of the pill and its bubbles (`chatStripHeight`), with the pill's top edge at
 * `pillTop`: the bubbles' row's when they go over the pill (`bubblesUnder` false, `bubbleRow`). */
function chatStripTop(pillTop: number, bubblesUnder: boolean): number {
  return bubblesUnder ? pillTop : pillTop - config.agentBubbleGap - config.agentBubbleDiameter;
}

/** Where the chat window goes: over the pill and its bubbles (owner, 2026-09-28: "the answer box
 * appear above the chat bubble"), or under them (`below`), and how tall it may grow there
 * (`maxHeight`). Over them when there is room there for it at its tallest (`tallest`, the chat's
 * `chatMaxHeight` unless the paste history's), the pill's top edge at `pillTop`; under them when there
 * is room there instead; otherwise on the side with more room, no taller than that room, so it stays
 * on screen and scrolls. Decided once, as it opens, so it never flips as it grows. */
export function chatSide(pillTop: number, bubblesUnder: boolean, workArea: Rect, tallest: number = config.chatMaxHeight): { below: boolean; maxHeight: number } {
  const stripTop = chatStripTop(pillTop, bubblesUnder);
  const over = stripTop - config.chatPillGap - workArea.y;
  const under = maxY(workArea) - (stripTop + config.chatStripHeight + config.chatPillGap);
  const below = over < tallest && under > over;
  return { below, maxHeight: Math.min(tallest, Math.floor(below ? under : over)) };
}

/** The overlay window's frame while the chat window shows, `contentHeight` tall (at most `side`'s
 * `maxHeight`), with the pill, its top edge's center at `pill`, where it was: the chat `chatPillGap`
 * over the pill and its bubbles (`chatStripHeight`, the bubbles under the pill or over it,
 * `bubblesUnder`), or under them (`side.below`, `chatSide`), with the shadow's margin around them
 * all; centered on the pill, kept inside the work area. The window keeps the edge on the pill's side
 * as the chat grows, so the pill never moves. */
export function chatWindowFrame(pill: Point, contentHeight: number, workArea: Rect, side: { below: boolean; maxHeight: number }, bubblesUnder: boolean): Rect {
  const margin = config.chatShadowMargin;
  const width = config.chatWidth + 2 * margin;
  const below = side.below;
  const height = 2 * margin + Math.min(contentHeight, side.maxHeight) + config.chatPillGap + config.chatStripHeight;
  const stripTop = chatStripTop(pill.y, bubblesUnder);
  const y = below ? stripTop - margin : stripTop + config.chatStripHeight + margin - height;
  let x = pill.x - width / 2;
  x = Math.min(Math.max(x, workArea.x - margin), maxX(workArea) + margin - width);
  return { x, y, width, height };
}

/** Where the paste history window goes (ADR-DESK-043), `size` big: where the chat window would
 * (owner, 2026-09-30: "like the answer tool"), `chatPillGap` over the pill and its bubbles, or under
 * them where there is more room (`chatSide`), no taller than the room on that side; centered on the
 * pill (its top edge's center at `pill`), kept inside the work area. The edge on the pill's side stays
 * put as the list measures itself. */
export function historyWindowFrame(pill: Point, size: Size, workArea: Rect, bubblesUnder: boolean): Rect {
  const side = chatSide(pill.y, bubblesUnder, workArea, size.height);
  const height = Math.min(size.height, side.maxHeight);
  const stripTop = chatStripTop(pill.y, bubblesUnder);
  const y = side.below ? stripTop + config.chatStripHeight + config.chatPillGap : stripTop - config.chatPillGap - height;
  const x = Math.min(Math.max(pill.x - size.width / 2, workArea.x), maxX(workArea) - size.width);
  return { x, y, width: size.width, height };
}
