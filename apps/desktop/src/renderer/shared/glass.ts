// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { CSSProperties } from "react";
import * as config from "../../core/config.js";

/** The brand's purple glow around a surface of the glass. */
export const brandGlow = `0 0 ${config.pillGlowRadius}px var(--glow)`;

/** The glass's crisp shadow: a tight contact shadow at its edge under a wide, faint ambient one. */
export const glassShadow = [
  `0 0 ${config.glassContactEdgeRadius}px var(--contact)`,
  `0 ${config.glassContactOffsetY}px ${config.glassContactRadius}px var(--contact)`,
  `0 ${config.glassAmbientOffsetY}px ${config.glassAmbientRadius}px var(--ambient)`,
];

/** The glass every floating surface is made of, the overlay's and the paste history (owner,
 * 2026-10-09; the theme's `glass…`, `rim`, `contact` and `ambient`): its fill, the light on its top
 * edge and its inner hairline, its rim, `glow`, and its crisp shadow. A surface's border stays transparent
 * over the fill, so its size is as it was. */
export function glassStyle(glow: string): CSSProperties {
  const hairline = config.glassHairlineWidth;
  return {
    background: "var(--glass)",
    boxShadow: `inset 0 ${hairline}px 0 var(--glass-highlight), inset 0 0 0 ${hairline}px var(--glass-edge), 0 0 0 ${hairline}px var(--rim), ${glow}, ${glassShadow.join(", ")}`,
  };
}
