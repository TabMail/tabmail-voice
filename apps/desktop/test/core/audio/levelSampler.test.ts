// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "vitest";
import { LevelSampler } from "../../../src/core/audio/levelSampler.js";
import { LevelEnvelope } from "../../../src/core/audio/levelEnvelope.js";
import * as config from "../../../src/core/config.js";

function waveform(samples: Float32Array, packetFrames: number): { readings: number[]; levels: number[] } {
  const meter = new LevelSampler();
  const envelope = new LevelEnvelope();
  const readings: number[] = [];
  const levels: number[] = [];
  let level = 0;
  for (let offset = 0; offset < samples.length; offset += packetFrames) {
    meter.append(samples.subarray(offset, offset + packetFrames), (reading, voiceReading) => {
      readings.push(reading);
      const next = envelope.level(reading, voiceReading);
      level += (next - level) * (next > level ? config.levelAttack : config.levelRelease);
      levels.push(level);
    });
  }
  return { readings, levels };
}

test("the same voice and silence produce identical waveform levels across native packet sizes", () => {
  const samples = new Float32Array(config.audioChunkFrames * 48 + 73);
  for (let index = 0; index < samples.length; index += 1) {
    const interval = Math.floor(index / config.audioChunkFrames);
    const amplitude = interval < 8 || interval >= 32 ? 0 : interval % 5 === 0 ? 0.1 : 0.008;
    samples[index] = amplitude * Math.sin(index * 0.17);
  }
  const reference = waveform(samples, config.audioChunkFrames);
  expect(reference.readings).toHaveLength(48);
  expect(reference.readings.slice(0, 8)).toEqual(Array<number>(8).fill(config.silenceDecibels));
  expect(Math.max(...reference.levels)).toBeGreaterThan(0.5);
  expect(reference.levels.at(-1)).toBeLessThan(0.02);
  for (const packetFrames of [1, 128, 160, 480, 4096, samples.length]) {
    expect(waveform(samples, packetFrames)).toEqual(reference);
  }
});

test("a new dictation cannot inherit the previous session's partial meter interval", () => {
  const old = new LevelSampler();
  old.append(new Float32Array(config.audioChunkFrames - 1).fill(1), () => { throw new Error("partial interval emitted"); });
  const next = new LevelSampler();
  const readings: number[] = [];
  next.append(new Float32Array(1), (reading) => readings.push(reading));
  expect(readings).toEqual([]);
  next.append(new Float32Array(config.audioChunkFrames - 1), (reading) => readings.push(reading));
  expect(readings).toEqual([config.silenceDecibels]);
});


test("meter intervals have exact boundaries and independent RMS", () => {
  const meter = new LevelSampler();
  const readings: number[] = [];
  const emit = (reading: number) => readings.push(reading);
  meter.append(new Float32Array(config.audioChunkFrames).fill(1), emit);
  expect(readings).toEqual([0]);
  meter.append(new Float32Array(config.audioChunkFrames - 1), emit);
  expect(readings).toEqual([0]);
  meter.append(new Float32Array(1), emit);
  expect(readings).toEqual([0, config.silenceDecibels]);
  meter.append(new Float32Array(config.audioChunkFrames).fill(0.5), emit);
  expect(readings).toHaveLength(3);
  expect(readings[2]).toBeCloseTo(20 * Math.log10(0.5), 10);
});

/** Each interval's voice band leaves out a room's mains hum: a quiet voice over a louder hum barely
 * moves the full band's reading but lifts the voice band's well past `waveformVoiceAboveNoiseDecibels`. */
test("the voice band leaves out a room's hum", () => {
  const rate = config.recordingSampleRate;
  const read = (voice: number) => {
    const meter = new LevelSampler();
    const samples = new Float32Array(config.audioChunkFrames * 6);
    for (let index = 0; index < samples.length; index += 1) samples[index] = 0.05 * Math.sin((2 * Math.PI * 50 * index) / rate) + voice * Math.sin((2 * Math.PI * 1_000 * index) / rate);
    const readings: [number, number][] = [];
    meter.append(samples, (reading, voiceReading) => readings.push([reading, voiceReading]));
    // The last interval: the filters settled.
    return readings.at(-1) ?? [0, 0];
  };
  const [hum, humVoice] = read(0);
  const [voice, voiceBand] = read(0.005);
  expect(voice - hum).toBeLessThan(0.5);
  expect(voiceBand - humVoice).toBeGreaterThan(config.waveformVoiceAboveNoiseDecibels);
});
