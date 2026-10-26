// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";

/**
 * Moves the waveform with speech, not the room: the bars follow the voice band (`LevelSampler`'s
 * second reading), from a gate `waveformGateDecibels` over the room's noise there, where room noise
 * reads as nothing, up to a peak envelope of the readings (up fast, down slowly), at least
 * `waveformMinimumRange` over the gate, so a quiet room never swings the bars full height.
 *
 * The room's noise is a floor of its own (down fast, up slowly), from `room` (the noise the last
 * dictation left) or else the first reading it takes, left without the first
 * `waveformVoiceWarmupReadings` readings and any of digital silence, where a start-up blip or a
 * reading part digital silence would hold it below the room. Until it has one (the first dictation
 * after launch, for its first third of a second) the bars rest.
 *
 * A voice is told against the same room: a voice from the first reading on is heard at once
 * instead of being taken for the room.
 */
export class LevelEnvelope {
  private peak: number | undefined;
  private count = 0;
  private peakCount = 0;
  private noise: number | undefined;
  private voiced = false;

  /** `room`: the room's noise the last dictation or spoken answer left (`room`), if any. */
  constructor(room?: number) {
    this.noise = room;
  }

  /** True once a voice-band reading stood `waveformVoiceAboveNoiseDecibels` above the room's noise
   * as it stood before that reading: a voice, by loudness alone (a loud noise counts too). Once
   * true, true for this envelope's life (one dictation, or one spoken answer). */
  get hasVoice(): boolean {
    return this.voiced;
  }

  /** The room's noise in the voice band as it stands, for the next envelope to start from. */
  get room(): number | undefined {
    return this.noise;
  }

  /** The waveform's level (0…1) for an interval's voice-band loudness (dB), which also tells a voice. */
  level(voiceDecibels: number): number {
    this.count += 1;
    if (voiceDecibels <= config.silenceDecibels) return 0;
    const room = this.noise;
    if (this.count > config.waveformVoiceWarmupReadings) {
      if (room === undefined) this.noise = voiceDecibels;
      else {
        if (voiceDecibels - room >= config.waveformVoiceAboveNoiseDecibels) this.voiced = true;
        this.noise = room + (voiceDecibels - room) * (voiceDecibels < room ? config.envelopeFastAlpha : config.envelopeSlowAlpha);
      }
    }
    this.peakCount += 1;
    const peak = this.peak ?? voiceDecibels;
    const alpha = Math.max(voiceDecibels > peak ? config.envelopeFastAlpha : config.envelopeSlowAlpha, 1 / this.peakCount);
    this.peak = peak + (voiceDecibels - peak) * alpha;
    if (room === undefined) return 0;
    const gate = room + config.waveformGateDecibels;
    const top = Math.max(this.peak, gate + config.waveformMinimumRange);
    return Math.max(0, Math.min(1, (voiceDecibels - gate) / (top - gate)));
  }
}
