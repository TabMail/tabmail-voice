// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import { deepStrictEqual } from "node:assert";
import { describe, expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { FLACEncoder } from "../../../src/core/audio/flac.js";
import { decodeFLAC } from "../../support/flacDecoder.js";

/** A deterministic pseudo-random sequence (a linear congruential generator), so noise is repeatable. */
function noise(count: number, amplitude: number, seed = 1): Int16Array {
  const samples = new Int16Array(count);
  let state = seed;
  for (let index = 0; index < count; index += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    samples[index] = Math.round((state / 2 ** 31 - 0.5) * 2 * amplitude);
  }
  return samples;
}

/** Speech-like: a gliding tone with a little noise, and a stretch of digital silence. */
function speechLike(count: number): Int16Array {
  const samples = new Int16Array(count);
  const hiss = noise(count, 100);
  for (let index = 0; index < count; index += 1) {
    const silent = index % 20_000 < 3_000;
    samples[index] = silent ? 0 : Math.round(9_000 * Math.sin((2 * Math.PI * (180 + index / 400) * index) / 16_000)) + hiss[index]!;
  }
  return samples;
}

/** A pure tone, which a high predictor order codes best. */
function tone(count: number): Int16Array {
  return Int16Array.from({ length: count }, (_, index) => Math.round(9_000 * Math.sin((2 * Math.PI * 440 * index) / 16_000)));
}

/** Quiet audio with a full-scale burst in the middle and a step near the end: the burst's partition
 * needs the largest Rice parameter, while the quiet rest keeps a predictor cheaper than verbatim. */
function burstAndStep(count: number): Int16Array {
  const samples = noise(count, 30, 5);
  const burst = Math.floor(count / 2);
  for (let index = burst; index < Math.min(count, burst + 64); index += 1) samples[index] = index % 2 === 0 ? 32_767 : -32_768;
  for (let index = Math.floor((count * 3) / 4); index < count; index += 1) samples[index] = samples[index]! + 12_000;
  return samples;
}

/** The encoded size of the stream header ("fLaC" and the STREAMINFO block), and a generous bound on a
 * frame's own header and footer. */
const streamHeaderBytes = 42;
const frameOverheadBytes = 16;

function pcmOf(samples: Int16Array): Uint8Array {
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return pcm;
}

function encode(samples: Int16Array, sampleRate = 16_000, chunk = samples.length || 1): Uint8Array {
  const encoder = new FLACEncoder(sampleRate);
  for (let offset = 0; offset < samples.length; offset += chunk) encoder.append(samples.subarray(offset, offset + chunk));
  return encoder.finish();
}

describe("FLACEncoder", () => {
  /** Lossless: whatever the signal, the stream decodes to exactly the samples given. */
  test.each([
    ["speech-like", speechLike(3 * config.flacBlockSize + 17)],
    ["digital silence", new Int16Array(2 * config.flacBlockSize)],
    ["loud noise", noise(config.flacBlockSize + 100, 32_000)],
    ["full-scale square wave", Int16Array.from({ length: 5_000 }, (_, index) => (index % 2 === 0 ? 32_767 : -32_768))],
    ["one sample", new Int16Array([-5])],
    ["a block exactly", noise(config.flacBlockSize, 2_000, 7)],
    ["a block and one", noise(config.flacBlockSize + 1, 2_000, 9)],
  ])("%s decodes to the same samples", (_, samples) => {
    const decoded = decodeFLAC(encode(samples));
    expect(decoded.pcm).toEqual(pcmOf(samples));
    expect(decoded.totalSamples).toBe(samples.length);
    expect(decoded.sampleRate).toBe(16_000);
  });

  /** A recording can end on any sample, so the last frame can be any length: every short one, and a
   * few odd longer ones, alone and after a full block, over noise, a tone and a burst with a step
   * (each takes a different coding path). */
  test.each([
    ["noise", (count: number) => noise(count, 2_000, 11)],
    ["a tone", tone],
    ["quiet audio with a full-scale burst and a step", burstAndStep],
  ])("%s decodes to the same samples, whatever length the last frame is", (_, signal) => {
    const tails = [...Array.from({ length: 40 }, (_, index) => index + 1), 127, 255, 1_001];
    for (const tail of tails) {
      for (const count of [tail, config.flacBlockSize + tail]) {
        const samples = signal(count);
        expect(decodeFLAC(encode(samples)).pcm, `${count} samples`).toEqual(pcmOf(samples));
      }
    }
  });

  /** Silence is a constant subframe: a few bytes a frame, not a sample's worth each. */
  test("digital silence costs a few bytes a frame", () => {
    const frames = 5;
    expect(encode(new Int16Array(frames * config.flacBlockSize)).length).toBeLessThanOrEqual(streamHeaderBytes + frames * frameOverheadBytes);
  });

  /** A frame no predictor shrinks is sent verbatim, so no stream is much larger than its PCM (the
   * upload's size limit rests on this, ADR-DESK-039). */
  test.each([
    ["full-scale noise", noise(3 * config.flacBlockSize + 5, 32_767, 3)],
    ["a full-scale square wave", Int16Array.from({ length: 3 * config.flacBlockSize + 5 }, (_, index) => (index % 2 === 0 ? 32_767 : -32_768))],
  ])("%s is no larger than its PCM and a frame's overhead", (_, samples) => {
    const frames = Math.ceil(samples.length / config.flacBlockSize);
    expect(encode(samples).length).toBeLessThanOrEqual(samples.length * 2 + streamHeaderBytes + frames * frameOverheadBytes);
  });

  test("an empty recording is a valid stream of no samples", () => {
    const decoded = decodeFLAC(encode(new Int16Array(0)));
    expect([decoded.totalSamples, decoded.frames, decoded.pcm.length]).toEqual([0, 0, 0]);
  });

  /** Each frame is encoded as soon as its samples are appended: the stream must not depend on how
   * the samples were split across appends. */
  test("the stream is the same however the samples arrive", () => {
    const samples = speechLike(2 * config.flacBlockSize + 999);
    const whole = encode(samples);
    for (const chunk of [1, 1_365, config.flacBlockSize, config.flacBlockSize + 1]) expect(encode(samples, 16_000, chunk)).toEqual(whole);
  });

  test("frames are full blocks but the last", () => {
    const decoded = decodeFLAC(encode(speechLike(3 * config.flacBlockSize + 17)));
    expect(decoded.frames).toBe(4);
    expect([decoded.minBlockSize, decoded.maxBlockSize]).toEqual([config.flacBlockSize, config.flacBlockSize]);
  });

  /** Frame numbers past 127 take the coded number's two-byte form; a two-minute dictation has ~470 frames. */
  test("numbers frames past the one-byte range", () => {
    const samples = noise(130 * config.flacBlockSize, 1_000, 3);
    const decoded = decodeFLAC(encode(samples));
    expect(decoded.frames).toBe(130);
    // Native typed-array comparison checks every byte without enumerating PCM properties.
    deepStrictEqual(decoded.pcm, pcmOf(samples));
  });

  /** The frame header names common rates outright and codes others in kHz, Hz or tens of Hz. */
  test.each([8_000, 16_000, 44_100, 48_000, 22_000, 11_025, 100_000, 100_001])("carries a %i Hz sample rate", (rate) => {
    const decoded = decodeFLAC(encode(noise(500, 1_000), rate));
    expect(decoded.sampleRate).toBe(rate);
  });

  /** The point of it: speech-like audio uploads at well under WAV's size. */
  test("compresses speech-like audio to under 60% of its PCM", () => {
    const samples = speechLike(10 * 16_000);
    expect(encode(samples).length).toBeLessThan(0.6 * samples.length * 2);
  });

  /** Pins the exact bytes of a stream the reference decoder accepted (`flac -t`, and `flac -d` gave back
   * the same samples) when this encoder was written, so a change to the bitstream is noticed. */
  test("writes the stream the reference decoder was checked against", () => {
    const stream = encode(speechLike(3 * config.flacBlockSize + 17));
    expect(createHash("sha256").update(stream).digest("hex")).toBe("46f96d77b49e3f3f2f89b186ea28a3ded006994e259e28dd6f0ef6291ac3b862");
  });
});
