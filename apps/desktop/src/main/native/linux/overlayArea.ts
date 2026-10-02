// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Rect } from "../../../core/ui/overlayGeometry.js";

/** Wayland providers may supply surface-local coordinates labelled as screen coordinates.
 * Use the current display's work area until a provider can establish global coordinates (#89).
 * The shared geometry still clamps the pill and chooses room for chat above or below it. */
export function linuxFallbackAnchor(area: Rect): Rect {
  return { x: area.x + area.width / 2, y: area.y + area.height * 0.7, width: 1, height: 1 };
}
