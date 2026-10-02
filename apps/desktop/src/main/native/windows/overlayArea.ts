// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { maxX, maxY, type Rect } from "../../../core/ui/overlayGeometry.js";

/** Remaining rectangles outside shell surfaces. Keep overlapping strips so chat can use their
 * full width or height; a partition would unnecessarily cut away usable space. */
export function shellFreeAreas(workArea: Rect, exclusions: readonly Rect[], gap: number): Rect[] {
  let areas = [workArea];
  for (const excluded of exclusions) {
    const block = { x: excluded.x - gap, y: excluded.y - gap, width: excluded.width + 2 * gap, height: excluded.height + 2 * gap };
    areas = areas.flatMap((area) => {
      const left = Math.max(area.x, block.x), top = Math.max(area.y, block.y);
      const right = Math.min(maxX(area), maxX(block)), bottom = Math.min(maxY(area), maxY(block));
      if (left >= right || top >= bottom) return [area];
      return [
        { x: area.x, y: area.y, width: left - area.x, height: area.height },
        { x: right, y: area.y, width: maxX(area) - right, height: area.height },
        { x: area.x, y: area.y, width: area.width, height: top - area.y },
        { x: area.x, y: bottom, width: area.width, height: maxY(area) - bottom },
      ].filter((rect) => rect.width > 0 && rect.height > 0);
    });
    areas = areas.filter((area, index) => !areas.some((other, otherIndex) =>
      otherIndex !== index && other.x <= area.x && other.y <= area.y && maxX(other) >= maxX(area) && maxY(other) >= maxY(area)
      && (other.width * other.height > area.width * area.height || otherIndex < index)));
  }
  return areas;
}

/** Prefer room for the full chat height; narrow side strips are usable by the responsive renderer.
 * Return null if the shell covers the whole display, rather than claiming an occluded area is safe. */
export function shellPlacementArea(workArea: Rect, exclusions: readonly Rect[]): Rect | null {
  const areas = shellFreeAreas(workArea, exclusions, 24);
  const usable = areas.filter((area) => area.width >= 240 && area.height >= 120);
  return usable.sort((a, b) =>
    Math.min(b.width, 440) * Math.min(b.height, 420) - Math.min(a.width, 440) * Math.min(a.height, 420))[0] ?? null;
}
