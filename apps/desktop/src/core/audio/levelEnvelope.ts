// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";

/**
 * Adapts the waveform to the range of sound coming in, so it follows the voice on any microphone:
 * two exponential-moving-average envelopes of the loudness (dB). The floor follows quieter readings
 * fast and louder ones slowly; the peak follows louder readings fast and quieter ones slowly. Each
 * reading shows where it sits between them.
 *
 * Warm-up: a moving average starts out anchored to its first readings (a start-up blip could hold
 * the floor down for seconds). Each weight is therefore at least 1/n for the n-th reading, making
 * the envelopes plain running averages while few readings exist; the window grows until the EMA's
 * own weight takes over (n = 1/alpha, ≈ 4 s for the slow side).
 */
export class LevelEnvelope {
  private floor: number | undefined;
  private peak: number | undefined;
  private count = 0;
  /** The room's noise for telling a voice: a floor of its own, left without the first
   * `waveformVoiceWarmupReadings` readings, where a start-up blip or a reading part digital silence
   * would hold it below the room. */
  private noise: number | undefined;
  private voiced = false;

  /** True once a reading stood `waveformVoiceAboveNoiseDecibels` above the room's noise as it stood
   * before that reading: a voice, by loudness alone (a loud noise counts too). Once true, true for
   * this envelope's life (one dictation, or one spoken answer). */
  get hasVoice(): boolean {
    return this.voiced;
  }

  level(decibels: number): number {
    this.count += 1;
    const sinceWarmup = this.count - config.waveformVoiceWarmupReadings;
    if (sinceWarmup > 0) {
      if (this.noise !== undefined && decibels - this.noise >= config.waveformVoiceAboveNoiseDecibels) this.voiced = true;
      this.noise = LevelEnvelope.follow(this.noise ?? decibels, decibels, true, sinceWarmup);
    }
    const floor = LevelEnvelope.follow(this.floor ?? decibels, decibels, true, this.count);
    const peak = LevelEnvelope.follow(this.peak ?? decibels, decibels, false, this.count);
    this.floor = floor;
    this.peak = peak;
    const top = Math.max(peak, floor + config.envelopeMinimumRange);
    return Math.max(0, Math.min(1, (decibels - floor) / (top - floor)));
  }

  private static follow(value: number, reading: number, fastWhenBelow: boolean, count: number): number {
    const fast = reading < value === fastWhenBelow;
    const alpha = Math.max(fast ? config.envelopeFastAlpha : config.envelopeSlowAlpha, 1 / count);
    return value + (reading - value) * alpha;
  }
}
