// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { brandColour, brandTextGradient, textShade } from "../../src/renderer/brand.js";

/** WCAG's contrast ratio of an `rgba(r, g, b, 1)` colour against white. */
function contrastWithWhite(colour: string): number {
  const channels = (colour.match(/\d+/g) ?? []).slice(0, 3).map((value) => {
    const c = Number(value) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

describe("brand colours", () => {
  /** White 13 px text (the chosen section, the default button) sits on the text gradient: every
   * point of it holds WCAG AA's 4.5:1, where the plain gradient's blue end doesn't. */
  test("white text on the text gradient keeps small-text contrast along its whole length", () => {
    for (let step = 0; step <= 10; step += 1) expect(contrastWithWhite(brandColour(step / 10, 1, textShade))).toBeGreaterThanOrEqual(4.5);
    expect(contrastWithWhite(brandColour(0))).toBeLessThan(4.5);
    expect(brandTextGradient).toBe(`linear-gradient(to right, ${brandColour(0, 1, textShade)}, ${brandColour(1, 1, textShade)})`);
  });
});
