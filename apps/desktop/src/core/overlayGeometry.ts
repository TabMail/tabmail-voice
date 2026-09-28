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

/** Centres of agent mode's tool bubbles, of `sizes`, above a pill at `pill`: one row, centred over
 * the pill, `agentBubbleGap` clear of it and apart (owner, 2026-09-26: "appear on top … like a list
 * on top"). */
export function bubbleCentres(pill: Rect, sizes: Size[]): Point[] {
  const gap = config.agentBubbleGap;
  const rowWidth = sizes.reduce((sum, size) => sum + size.width, 0) + gap * Math.max(sizes.length - 1, 0);
  let x = midX(pill) - rowWidth / 2;
  return sizes.map((size) => {
    const centre = { x: x + size.width / 2, y: pill.y - gap - size.height / 2 };
    x += size.width + gap;
    return centre;
  });
}

/** Centre of a tip, of `size`: a tooltip centred `tipGap` under a pill at `pill` (owner,
 * 2026-09-26: "a tooltip that appears below the middle and disappears after a little"). It fades
 * after its display duration, so even an overlay opened above the caret's line covers that line only
 * briefly. */
export function hintCentre(pill: Rect, size: Size): Point {
  return { x: midX(pill), y: maxY(pill) + config.tipGap + size.height / 2 };
}
