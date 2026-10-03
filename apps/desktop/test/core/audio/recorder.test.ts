// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { AudioRecorder, decibels, level, normalizePeak, recordingDuration } from "../../../src/core/audio/recorder.js";
import * as config from "../../../src/core/config.js";
import { LevelEnvelope } from "../../../src/core/audio/levelEnvelope.js";
import { encodeWAV, wavHeaderSize } from "../../../src/core/audio/wav.js";
import { decodeFLAC } from "../../support/flacDecoder.js";
import { tone } from "../../support/stubs.js";

/** The 16-bit samples of little-endian PCM. */
function samplesOf(pcm: Uint8Array): number[] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Array.from({ length: pcm.length / 2 }, (_, index) => view.getInt16(index * 2, true));
}

function peakOf(pcm: Uint8Array): number {
  return Math.max(...samplesOf(pcm).map(Math.abs));
}

/** Float samples as the recorder converts them to 16-bit. */
function asRecorded(samples: Float32Array): number[] {
  return Array.from(samples, (sample) => Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff) || 0); // no −0
}

/** The loudest sample `normalizePeak` aims for: −3 dBFS. */
const targetPeak = Math.round(0x7fff * 10 ** (config.normalizedPeakDecibels / 20));

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

  /** The upload is FLAC: it must be exactly the recording's samples. */
  test("FLAC-encodes exactly what it records", () => {
    const recorder = new AudioRecorder();
    feed(recorder, tone(1.3));
    const recording = recorder.finish();
    const decoded = decodeFLAC(recording.flac);
    expect(decoded.pcm).toEqual(recording.pcm);
    expect(decoded.sampleRate).toBe(16_000);
  });

  test("the FLAC stops at the maximum duration too", () => {
    const recorder = new AudioRecorder(16_000, 1_000);
    feed(recorder, tone(2));
    const recording = recorder.finish();
    expect(decodeFLAC(recording.flac).pcm).toEqual(recording.pcm);
    expect(recording.pcm.length).toBe(16_000 * 2);
  });

  test("an empty recording", () => {
    const recording = new AudioRecorder().finish();
    expect(recording.pcm.length).toBe(0);
    expect(decodeFLAC(recording.flac).totalSamples).toBe(0);
    expect(recording.peakLevel).toBe(0);
  });

  /** Quiet microphones: the upload's loudest sample sits at −3 dBFS whatever the microphone gave,
   * the whole recording scaled by one gain so its shape is unchanged. */
  test("uploads a quiet recording peak-normalized to −3 dBFS", () => {
    const quiet = tone(1, 0.05); // −26 dBFS
    const recorder = new AudioRecorder();
    feed(recorder, quiet);
    const recording = recorder.finish();

    expect(peakOf(decodeFLAC(recording.flac).pcm)).toBe(targetPeak);
    expect(decodeFLAC(recording.flac).pcm).toEqual(recording.pcm);
    expect(20 * Math.log10(recording.gain)).toBeCloseTo(-3 + 26, 0);
    const raw = asRecorded(quiet);
    samplesOf(recording.pcm).forEach((sample, index) => expect(Math.abs(sample - (raw[index] ?? 0) * recording.gain)).toBeLessThanOrEqual(0.5));
  });

  /** Near-silence is raised by at most 30 dB, not into full-scale noise. */
  test("boosts by at most the maximum gain", () => {
    const recorder = new AudioRecorder();
    feed(recorder, tone(1, 0.001)); // −60 dBFS
    const recording = recorder.finish();

    expect(20 * Math.log10(recording.gain)).toBeCloseTo(config.maxNormalizationGainDecibels, 6);
    expect(peakOf(recording.pcm)).toBeLessThan(targetPeak / 10);
    expect(decodeFLAC(recording.flac).pcm).toEqual(recording.pcm);
  });

  /** A recording already louder than −3 dBFS goes up as recorded: never cut. */
  test("leaves a loud recording as recorded", () => {
    const loud = tone(0.5, 0.9);
    const recorder = new AudioRecorder();
    feed(recorder, loud);
    const recording = recorder.finish();

    expect(recording.gain).toBe(1);
    expect(samplesOf(recording.pcm)).toEqual(asRecorded(loud));
  });

  test("leaves digital silence silent", () => {
    const recorder = new AudioRecorder();
    recorder.append(new Float32Array(1_000));
    const recording = recorder.finish();
    expect(recording.gain).toBe(1);
    expect(samplesOf(recording.pcm).every((sample) => sample === 0)).toBe(true);
  });

  /** Negative and positive samples scale alike (the loudest may be either sign). */
  test("normalizePeak scales both signs by one gain", () => {
    const samples = new Int16Array([0, 1_000, -2_000, 500]);
    const gain = normalizePeak(samples);
    expect(gain).toBeCloseTo(targetPeak / 2_000, 2);
    expect(Array.from(samples)).toEqual([0, Math.round(1_000 * gain), -targetPeak, Math.round(500 * gain)]);
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

  /** A voice is a reading `waveformVoiceAboveNoiseDecibels` over the room's noise, and stays heard;
   * one just under it is not (owner, 2026-10-02: the waveform turns crimson). */
  test("hears a voice above the room's noise", () => {
    const under = new LevelEnvelope();
    run(under, -45, 20);
    under.level(-45 + config.waveformVoiceAboveNoiseDecibels - 0.2);
    expect(under.hasVoice).toBe(false);

    const over = new LevelEnvelope();
    run(over, -45, 20);
    expect(over.hasVoice).toBe(false);
    over.level(-45 + config.waveformVoiceAboveNoiseDecibels + 0.2);
    expect(over.hasVoice).toBe(true);
    run(over, -45, 20);
    expect(over.hasVoice).toBe(true);
  });

  /** Room noise alone is no voice, even after a start-up blip (−70 dB) or a first reading that is
   * mostly digital silence, which would hold a floor below the room for a moment. */
  test("hears no voice in room noise after a start-up blip", () => {
    for (const start of [[-70, -70, -70], [-52]]) {
      const envelope = new LevelEnvelope();
      for (const reading of start) envelope.level(reading);
      run(envelope, -45, 30);
      expect(envelope.hasVoice).toBe(false);
    }
  });

  /** Speech from the first reading on is heard at its first pause and the word after it. */
  test("hears a voice that starts at once", () => {
    const envelope = new LevelEnvelope();
    run(envelope, -35, 8);
    run(envelope, -45, 2);
    expect(envelope.hasVoice).toBe(false);
    envelope.level(-35);
    expect(envelope.hasVoice).toBe(true);
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
