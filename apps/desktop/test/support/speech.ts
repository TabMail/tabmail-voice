// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../src/core/config.js";

/** Synthetic dictation audio for the long-dictation tests (ADR-DESK-048): 16 kHz mono floats, as the
 * microphone delivers them. */

const rate = config.recordingSampleRate;

/** A seeded random source (mulberry32), so every run hears the same audio. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Speech-like sound: a tone whose loudness rises and falls four times a second, as syllables do,
 * over the room's noise. Its dips between syllables are short, never a pause. */
export function speech(seconds: number, rand: () => number, amplitude = 0.25): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / rate;
    const syllable = 0.15 + 0.85 * Math.abs(Math.sin(2 * Math.PI * 2 * t));
    samples[i] = amplitude * syllable * Math.sin(2 * Math.PI * 220 * t) + (rand() - 0.5) * 0.004;
  }
  return samples;
}

/** The room alone: faint noise. */
export function room(seconds: number, rand: () => number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i += 1) samples[i] = (rand() - 0.5) * 0.004;
  return samples;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const all = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

/** `samples` as 16-bit PCM, as `AudioRecorder` stores them. */
export function pcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return pcm;
}
