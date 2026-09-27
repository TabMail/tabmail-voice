// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The overlay uses only the TabMail icon's colours: blue → purple. */
const blue = [0, 0x91, 0xff] as const;
const purple = [0x7b, 0, 0xff] as const;

/** A point on the blue → purple gradient (0 = blue, 1 = purple), at `alpha`. */
export function brandColour(fraction: number, alpha = 1): string {
  const [r, g, b] = blue.map((start, index) => Math.round(start + ((purple[index] ?? start) - start) * fraction));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const brandBlue = brandColour(0);
export const brandPurple = brandColour(1);
export const brandGradient = `linear-gradient(to right, ${brandBlue}, ${brandPurple})`;

/** A grey of `white` (0 black … 1 white), at `alpha`. */
export function grey(white: number, alpha = 1): string {
  const value = Math.round(white * 255);
  return `rgba(${value}, ${value}, ${value}, ${alpha})`;
}
