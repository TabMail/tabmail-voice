// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";

/** One second-order Butterworth section (RBJ's cookbook), high- or low-pass at `hertz`. */
class Biquad {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(kind: "high" | "low", hertz: number) {
    const omega = (2 * Math.PI * hertz) / config.recordingSampleRate;
    const cos = Math.cos(omega);
    const alpha = Math.sin(omega) / Math.SQRT2;
    const a0 = 1 + alpha;
    const edge = kind === "high" ? (1 + cos) / 2 : (1 - cos) / 2;
    this.b0 = edge / a0;
    this.b1 = (kind === "high" ? -2 * edge : 2 * edge) / a0;
    this.b2 = edge / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  next(sample: number): number {
    const output = this.b0 * sample + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = sample;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }
}

/** Keeps the voice band, `voiceBandLowHertz`–`voiceBandHighHertz`, of a stream of samples, so a
 * room's hum and rumble (below it) don't count as a voice. One per stream: it carries its state
 * from packet to packet. */
export class VoiceBand {
  private readonly high = new Biquad("high", config.voiceBandLowHertz);
  private readonly low = new Biquad("low", config.voiceBandHighHertz);

  next(sample: number): number {
    return this.low.next(this.high.next(sample));
  }
}
