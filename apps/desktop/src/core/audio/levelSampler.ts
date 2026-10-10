// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { decibels } from "./recorder.js";
import { VoiceBand } from "./voiceBand.js";

/** Measures equal intervals of audio regardless of the native device's packet size. The shared
 * envelope and attack/release weights are tuned for this cadence. Recording still receives every
 * original sample, including a final partial interval; only the live meter is buffered here. Each
 * interval reports its loudness and its voice band's (`VoiceBand`), which tells a voice. */
export class LevelSampler {
  private readonly window = new Float32Array(config.audioChunkFrames);
  private readonly voiceWindow = new Float32Array(config.audioChunkFrames);
  private readonly voiceBand = new VoiceBand();
  private filled = 0;

  append(samples: Float32Array, report: (decibels: number, voiceDecibels: number) => void): void {
    for (const sample of samples) {
      this.window[this.filled] = sample;
      this.voiceWindow[this.filled] = this.voiceBand.next(sample);
      this.filled += 1;
      if (this.filled === this.window.length) {
        this.filled = 0;
        report(decibels(this.window), decibels(this.voiceWindow));
      }
    }
  }
}
