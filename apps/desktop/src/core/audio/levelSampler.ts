// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { decibels } from "./recorder.js";

/** Measures equal intervals of audio regardless of the native device's packet size. The shared
 * envelope and attack/release weights are tuned for this cadence. Recording still receives every
 * original sample, including a final partial interval; only the live meter is buffered here. */
export class LevelSampler {
  private readonly window = new Float32Array(config.audioChunkFrames);
  private filled = 0;

  append(samples: Float32Array, report: (decibels: number) => void): void {
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(samples.length - offset, this.window.length - this.filled);
      this.window.set(samples.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.window.length) {
        this.filled = 0;
        report(decibels(this.window));
      }
    }
  }
}
