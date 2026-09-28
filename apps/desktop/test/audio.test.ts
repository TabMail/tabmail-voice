// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { AudioRecorder, decibels, level, recordingDuration } from "../src/core/audio.js";
import * as config from "../src/core/config.js";
import { LevelEnvelope } from "../src/core/levelEnvelope.js";
import { encodeWAV, wavHeaderSize } from "../src/core/wav.js";
import { tone } from "./support.js";

function feed(recorder: AudioRecorder, samples: Float32Array, chunk = config.audioChunkFrames): void {
  for (let offset = 0; offset < samples.length; offset += chunk) recorder.append(samples.subarray(offset, offset + chunk));
}

describe("AudioRecorder", () => {
  test("records 16 kHz mono 16-bit PCM", () => {
    const recorder = new AudioRecorder();
    feed(recorder, tone(1));
    const recording = recorder.finish();

    expect(recording.sampleRate).toBe(16_000);
    expect(recordingDuration(recording)).toBe(1);
    expect(recording.pcm.length).toBe(32_000);
    expect(recording.truncated).toBe(false);
  });

  /** Full scale maps to the 16-bit extremes, little-endian, and louder than full scale clips. */
  test("converts samples to little-endian 16-bit, clipping past full scale", () => {
    const recorder = new AudioRecorder();
    recorder.append(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    const view = new DataView(recorder.finish().pcm.buffer);
    const samples = [0, 2, 4, 6, 8, 10].map((offset) => view.getInt16(offset, true));
    expect(samples).toEqual([0, 32_767, -32_768, 32_767, -32_768, 16_384]);
  });

  test("records when the first audio arrived", () => {
    expect(new AudioRecorder().finish().firstChunkAt).toBeNull();

    const recorder = new AudioRecorder();
    recorder.append(tone(0.1), 42);
    recorder.append(tone(0.1), 99);
    expect(recorder.finish().firstChunkAt).toBe(42);
  });

  /** Audio past the cap is dropped (and flagged), keeping recordings within what the backend transcribes. */
  test("stops at the maximum duration", () => {
    const recorder = new AudioRecorder(16_000, 1_000);
    feed(recorder, tone(2));
    const recording = recorder.finish();
    expect(recording.truncated).toBe(true);
    expect(recording.pcm.length).toBe(16_000 * 2);
  });

  /** The backend transcribes at most 120 s of audio: a dictation left running is cut there, not
   * sent to fail. */
  test("by default keeps no more than the 120 s the backend transcribes", () => {
    const backendMaxSeconds = 120;
    const recorder = new AudioRecorder();
    feed(recorder, tone(backendMaxSeconds + 1));
    const recording = recorder.finish();
    expect(recording.truncated).toBe(true);
    expect(recording.pcm.length).toBe(16_000 * 2 * backendMaxSeconds);
  });

  test("an empty recording", () => {
    const recording = new AudioRecorder().finish();
    expect(recording.pcm.length).toBe(0);
    expect(recording.peakLevel).toBe(0);
  });

  test("keeps the loudest chunk's level", () => {
    const recorder = new AudioRecorder();
    recorder.append(tone(0.1, 0.001));
    recorder.append(tone(0.1, 0.5));
    recorder.append(tone(0.1, 0.001));
    expect(recorder.finish().peakLevel).toBe(1);
  });
});

describe("loudness", () => {
  test("digital silence reads as the silence floor", () => {
    expect(decibels(new Float32Array(100))).toBe(config.silenceDecibels);
    expect(decibels(new Float32Array())).toBe(config.silenceDecibels);
  });

  /** A sine's RMS is its amplitude over √2: 0.5 → about −9 dBFS. */
  test("a tone reads at its RMS in dBFS", () => {
    expect(decibels(tone(1, 0.5))).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 2);
  });

  test("the fixed level scale runs from quiet to loud", () => {
    const at = (dB: number) => new Float32Array(1_000).fill(10 ** (dB / 20));
    expect(level(at(config.levelQuietDecibels - 5))).toBe(0);
    expect(level(at((config.levelQuietDecibels + config.levelLoudDecibels) / 2))).toBeCloseTo(0.5, 5);
    expect(level(at(config.levelLoudDecibels + 5))).toBe(1);
  });
});

/** Levels measured on a quiet display microphone: room noise ≈ −45 dB, short utterances peak
 * ≈ −42.5 dB, longer speech −35 to −40 dB. */
describe("LevelEnvelope", () => {
  function run(envelope: LevelEnvelope, dB: number, times: number): number {
    let result = 0;
    for (let index = 0; index < times; index += 1) result = envelope.level(dB);
    return result;
  }

  /** Speech only 2.5 dB over the room (a short, quiet dictation) must still move the waveform. */
  test("quiet mic speech barely above the room moves", () => {
    const envelope = new LevelEnvelope();
    run(envelope, -45, 30);
    expect(envelope.level(-42.5)).toBeGreaterThan(0.4);
  });

  /** Adapts to the range coming in: after speech, the loud end sits near the speech, so louder
   * syllables read higher than softer ones instead of all pinning at full. */
  test("adapts to the incoming range", () => {
    const envelope = new LevelEnvelope();
    for (let index = 0; index < 10; index += 1) {
      run(envelope, -60, 3);
      run(envelope, -20, 3);
    }
    const loud = envelope.level(-20);
    const medium = envelope.level(-35);
    expect(loud).toBeGreaterThan(0.9);
    expect(medium).toBeGreaterThan(0.2);
    expect(medium).toBeLessThan(loud - 0.2);
  });

  /** Warm-up: a start-up blip (−70 dB) must not anchor the floor, so within the first second of
   * room noise (−45) and speech (−38) the two already read clearly apart. */
  test("settles within the first second", () => {
    const envelope = new LevelEnvelope();
    run(envelope, -70, 3);
    for (let index = 0; index < 6; index += 1) {
      envelope.level(-45);
      envelope.level(-38);
    }
    expect(envelope.level(-45)).toBeLessThan(0.4);
    expect(envelope.level(-38)).toBeGreaterThan(0.6);
  });

  /** A steady hum settles low rather than holding the bars up. */
  test("steady sound settles low", () => {
    expect(run(new LevelEnvelope(), -45, 60)).toBeLessThan(0.1);
  });
});

describe("WAV", () => {
  test("writes a canonical PCM header", () => {
    const pcm = new Uint8Array(320).fill(7);
    const wav = encodeWAV(pcm, 16_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const text = (start: number) => new TextDecoder().decode(wav.subarray(start, start + 4));

    expect(wav.length).toBe(wavHeaderSize + pcm.length);
    expect(text(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(text(8)).toBe("WAVE");
    expect(text(12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000); // sample rate
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(text(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });
});
