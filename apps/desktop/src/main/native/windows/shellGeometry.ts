// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Rect } from "../../../core/ui/overlayGeometry.js";

/** Arming and shell events can overlap. Only the newest requested snapshot may publish. */
export class ShellGeometry {
  bounds: readonly Rect[] = [];
  private generation = 0;

  constructor(private readonly query: () => Promise<Rect[]>) {}

  async refresh(): Promise<boolean> {
    const generation = ++this.generation;
    const next = await this.query();
    if (generation !== this.generation || JSON.stringify(next) === JSON.stringify(this.bounds)) return false;
    this.bounds = next;
    return true;
  }
}
