// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { FLACEncoder } from "./flac.js";
import * as config from "./config.js";

/** What dictation needs from a microphone. On macOS the helper captures it (`AVAudioEngine`, as the
 * Swift app does); elsewhere the audio window (`getUserMedia` into an AudioWorklet), both resampled to
 * `config.recordingSampleRate` mono; tests substitute one that records nothing. The microphone is on only between `start` and `stop` (released after every dictation). */
export interface AudioCapture {
  /** Does the slow, microphone-off part of starting ahead of the first dictation. */
  prepare(): void;
  /** Starts the microphone. `onChunk` gets each chunk of mono float samples at
   * `config.recordingSampleRate`; `completion` runs once, with the error if the microphone could
   * not start; `onLost` runs if the microphone, once started, stops by itself before `stop` (the
   * macOS helper that runs it exited). */
  start(onChunk: (samples: Float32Array) => void, completion: (error: Error | null) => void, onLost: () => void): void;
  stop(): void;
}

/** RMS loudness of a chunk in dBFS (`config.silenceDecibels` for digital silence). */
export function decibels(samples: Float32Array): number {
  if (samples.length === 0) return config.silenceDecibels;
  let sumOfSquares = 0;
  for (const sample of samples) sumOfSquares += sample * sample;
  const rms = Math.sqrt(sumOfSquares / samples.length);
  if (rms <= 0) return config.silenceDecibels;
  return Math.max(20 * Math.log10(rms), config.silenceDecibels);
}

/** Level (0…1) of a chunk's loudness on a fixed scale, for the recording's peak-level diagnostics
 * (the waveform adapts instead: `LevelEnvelope`). */
export function level(samples: Float32Array): number {
  const quiet = config.levelQuietDecibels;
  return Math.max(0, Math.min(1, (decibels(samples) - quiet) / (config.levelLoudDecibels - quiet)));
}

export interface Recording {
  /** Little-endian 16-bit mono PCM samples. */
  pcm: Uint8Array;
  /** The same samples FLAC-encoded, the upload. */
  flac: Uint8Array;
  sampleRate: number;
  /** Loudest chunk's level on the fixed 0…1 scale. */
  peakLevel: number;
  /** When the microphone delivered its first chunk (`performance.now()`), null if it never did. */
  firstChunkAt: number | null;
  /** True when recording hit the maximum duration and later audio was dropped. */
  truncated: boolean;
}

export function recordingDuration(recording: Recording): number {
  return recording.pcm.length / 2 / recording.sampleRate;
}

/** Accumulates one dictation as 16 kHz mono 16-bit PCM, FLAC-encoding it as it arrives for the upload. */
export class AudioRecorder {
  private readonly maxFrames: number;
  private readonly chunks: Int16Array[] = [];
  private frames = 0;
  private peakLevel = 0;
  private firstChunkAt: number | null = null;
  private truncated = false;
  private readonly encoder: FLACEncoder;

  constructor(
    readonly sampleRate: number = config.recordingSampleRate,
    /** Milliseconds. */
    maxDuration: number = config.maxRecordingDuration,
  ) {
    this.maxFrames = Math.floor((maxDuration / 1000) * sampleRate);
    this.encoder = new FLACEncoder(sampleRate);
  }

  append(samples: Float32Array, now: number = performance.now()): void {
    this.firstChunkAt ??= now;
    if (this.truncated) return;
    this.peakLevel = Math.max(this.peakLevel, level(samples));
    const room = this.maxFrames - this.frames;
    const count = Math.min(samples.length, room);
    if (count < samples.length) this.truncated = true;
    if (count <= 0) return;
    const pcm = new Int16Array(count);
    for (let index = 0; index < count; index += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
      pcm[index] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    }
    this.chunks.push(pcm);
    this.encoder.append(pcm);
    this.frames += count;
  }

  /** Everything recorded so far. */
  finish(): Recording {
    const pcm = new Uint8Array(this.frames * 2);
    const view = new DataView(pcm.buffer);
    let offset = 0;
    for (const chunk of this.chunks) {
      for (const sample of chunk) {
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }
    return { pcm, flac: this.encoder.finish(), sampleRate: this.sampleRate, peakLevel: this.peakLevel, firstChunkAt: this.firstChunkAt, truncated: this.truncated };
  }
}
