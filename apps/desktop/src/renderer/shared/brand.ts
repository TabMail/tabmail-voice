// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { palette } from "../../core/palette.js";

/** A `#RRGGBB` color's red, green and blue (0–255). */
export function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** The overlay uses the TabMail icon's colors, blue → purple, but for agent mode's red-pink glow
 * and the waveform's and the retry's own colors (`palette`). */
const blue = channels(palette.brandBlue);
const purple = channels(palette.brandPurple);

/** A point on the blue → purple gradient (0 = blue, 1 = purple), at `alpha`, darkened by `shade`
 * (0 none … 1 black). */
export function brandColor(fraction: number, alpha = 1, shade = 0): string {
  const [r, g, b] = blue.map((start, index) => Math.round((start + ((purple[index] ?? start) - start) * fraction) * (1 - shade)));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const brandBlue = brandColor(0);
export const brandPurple = brandColor(1);
export const brandGradient = `linear-gradient(to right, ${brandBlue}, ${brandPurple})`;

/** How much the gradient darkens under white text, so that even its lightest (blue) end gives small
 * text the 4.5:1 contrast WCAG AA asks for. */
export const textShade = 0.2;
export const brandTextGradient = `linear-gradient(to right, ${brandColor(0, 1, textShade)}, ${brandColor(1, 1, textShade)})`;

/** `hex` (`#RRGGBB`, as `palette` writes it) at `alpha`. */
export function rgba(hex: string, alpha = 1): string {
  return `rgba(${channels(hex).join(", ")}, ${alpha})`;
}

/** A gray of `white` (0 black … 1 white), at `alpha`. */
export function gray(white: number, alpha = 1): string {
  const value = Math.round(white * 255);
  return `rgba(${value}, ${value}, ${value}, ${alpha})`;
}
