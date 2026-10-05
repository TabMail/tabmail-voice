// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ChunkCut, Chunker } from "./chunker.js";
import { FLACEncoder } from "./flac.js";
import * as config from "../config.js";

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

/** Scales 16-bit samples in place so the loudest sits at `config.normalizedPeakDecibels`, boosting
 * by at most `config.maxNormalizationGainDecibels` and never cutting (peak normalization, one gain
 * for the whole recording). Returns the gain applied (1 when none). */
export function normalizePeak(samples: Int16Array): number {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak === 0) return 1;
  const target = 0x7fff * 10 ** (config.normalizedPeakDecibels / 20);
  const gain = Math.min(target / peak, 10 ** (config.maxNormalizationGainDecibels / 20));
  if (gain <= 1) return 1;
  // Rounded half away from zero, as Swift's `rounded()` in the iOS app. No clamp needed: every
  // scaled sample is at most the target.
  for (let index = 0; index < samples.length; index += 1) {
    const scaled = (samples[index] ?? 0) * gain;
    samples[index] = Math.sign(scaled) * Math.round(Math.abs(scaled));
  }
  return gain;
}

export interface Recording {
  /** Little-endian 16-bit mono PCM samples: the whole recording, peak-normalized (`normalizePeak`)
   * when it is one upload, as captured when it was cut into chunks. */
  pcm: Uint8Array;
  /** The upload FLAC-encoded: the whole recording, or, when it was cut into chunks, the last chunk's
   * (`lastChunk`), each normalized on its own. */
  flac: Uint8Array;
  sampleRate: number;
  /** The gain `normalizePeak` applied to the upload (1 when none). */
  gain: number;
  /** Loudest chunk's level on the fixed 0…1 scale, as captured (before `gain`). */
  peakLevel: number;
  /** When the microphone delivered its first chunk (`performance.now()`), null if it never did. */
  firstChunkAt: number | null;
  /** True when recording hit the maximum duration and later audio was dropped. */
  truncated: boolean;
  /** The last chunk, from the last cut to the end, when the recording was cut into chunks
   * (ADR-DESK-049); null when it is one upload. */
  lastChunk: RecordedChunk | null;
}

/** A chunk of a long recording, ready to upload: its samples normalized on their own and
 * FLAC-encoded. */
export interface RecordedChunk extends ChunkCut {
  flac: Uint8Array;
  gain: number;
}

export function recordingDuration(recording: Recording): number {
  return recording.pcm.length / 2 / recording.sampleRate;
}

/** Accumulates one dictation as 16 kHz mono 16-bit PCM; `finish` peak-normalizes it and FLAC-encodes
 * it for the upload. Given `onChunk`, it cuts a long recording into chunks as it goes (`Chunker`,
 * ADR-DESK-049), handing each to `onChunk` as it is cut, and `finish` the last. */
export class AudioRecorder {
  private readonly maxFrames: number;
  private samples = new Int16Array(16_000);
  private frames = 0;
  private peakLevel = 0;
  private firstChunkAt: number | null = null;
  private truncated = false;
  /** `finish` was called: whatever is appended after is not the dictation's, and must cut no chunk
   * after the last. The capture stops delivering before the finish today, so this keeps "finish is
   * final" true for any capture source, as iOS's recorder must for its audio thread. */
  private finished = false;
  private readonly chunker: Chunker | null;

  constructor(
    readonly sampleRate: number = config.recordingSampleRate,
    /** Milliseconds. */
    maxDuration: number = config.maxRecordingDuration,
    private readonly onChunk?: (chunk: RecordedChunk) => void,
  ) {
    this.maxFrames = Math.floor((maxDuration / 1000) * sampleRate);
    this.chunker = onChunk ? new Chunker(sampleRate) : null;
  }

  append(samples: Float32Array, now: number = performance.now()): void {
    if (this.finished) return;
    this.firstChunkAt ??= now;
    if (this.truncated) return;
    this.peakLevel = Math.max(this.peakLevel, level(samples));
    const room = this.maxFrames - this.frames;
    const count = Math.min(samples.length, room);
    if (count < samples.length) this.truncated = true;
    if (count <= 0) return;
    if (this.frames + count > this.samples.length) {
      const grown = new Int16Array(Math.max(this.samples.length * 2, this.frames + count));
      grown.set(this.samples.subarray(0, this.frames));
      this.samples = grown;
    }
    const start = this.frames;
    for (let index = 0; index < count; index += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
      this.samples[start + index] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    }
    this.frames += count;
    if (!this.chunker || !this.onChunk) return;
    for (const cut of this.chunker.append(this.samples.subarray(start, this.frames))) this.onChunk(this.encoded(cut));
  }

  /** Everything recorded so far. One upload, it is peak-normalized as a whole: the whole recording's
   * loudest sample sets the gain, so it is encoded here rather than as it arrives (about 1.4 ms per
   * second of audio). Cut into chunks, only the last chunk is encoded here. */
  finish(): Recording {
    this.finished = true;
    const samples = this.samples.slice(0, this.frames);
    const last = this.chunker?.finish(this.frames) ?? null;
    if (last !== null) {
      const lastChunk = this.encoded(last);
      return { pcm: littleEndian(samples), flac: lastChunk.flac, sampleRate: this.sampleRate, gain: lastChunk.gain, peakLevel: this.peakLevel, firstChunkAt: this.firstChunkAt, truncated: this.truncated, lastChunk };
    }
    const gain = normalizePeak(samples);
    const encoder = new FLACEncoder(this.sampleRate);
    encoder.append(samples);
    return { pcm: littleEndian(samples), flac: encoder.finish(), sampleRate: this.sampleRate, gain, peakLevel: this.peakLevel, firstChunkAt: this.firstChunkAt, truncated: this.truncated, lastChunk: null };
  }

  /** A chunk's samples, peak-normalized on their own and FLAC-encoded. */
  private encoded(cut: ChunkCut): RecordedChunk {
    const samples = this.samples.slice(cut.start, cut.end);
    const gain = normalizePeak(samples);
    const encoder = new FLACEncoder(this.sampleRate);
    encoder.append(samples);
    return { ...cut, flac: encoder.finish(), gain };
  }
}

/** `samples` as little-endian 16-bit PCM. */
function littleEndian(samples: Int16Array): Uint8Array {
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return pcm;
}
