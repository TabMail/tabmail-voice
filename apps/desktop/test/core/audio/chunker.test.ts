// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { type ChunkCut, Chunker } from "../../../src/core/audio/chunker.js";
import * as config from "../../../src/core/config.js";
import { pcm16, random, room as roomAudio, speech as speechAudio } from "../../support/speech.js";

const rate = config.recordingSampleRate;
const seconds = (samples: number) => samples / rate;

/** The audio as `AudioRecorder` hands it to the chunker: 16-bit PCM. */
function speech(duration: number, rand: () => number, amplitude?: number): Int16Array {
  return pcm16(speechAudio(duration, rand, amplitude));
}

function room(duration: number, rand: () => number): Int16Array {
  return pcm16(roomAudio(duration, rand));
}

function concat(...parts: Int16Array[]): Int16Array {
  const all = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

/** Feeds `audio` in the microphone's chunks, as the recorder does; returns every cut and the last. */
function chunk(audio: Int16Array, step = config.audioChunkFrames): { cuts: ChunkCut[]; last: ChunkCut | null } {
  const chunker = new Chunker();
  const cuts: ChunkCut[] = [];
  for (let offset = 0; offset < audio.length; offset += step) cuts.push(...chunker.append(audio.subarray(offset, offset + step)));
  return { cuts, last: chunker.finish(audio.length) };
}

/** What every cutting must hold: the chunks cover the recording in order from its first sample to
 * its last, each starting where the one before ended unless it overlaps it (and then within
 * `chunkMaxOverlap` of its end), each within `chunkMaxDuration`, so within what the backend
 * transcribes at once. */
function expectCovers(audio: Int16Array, cuts: readonly ChunkCut[], last: ChunkCut | null): void {
  if (last === null) {
    expect(cuts).toEqual([]);
    return;
  }
  const all = [...cuts, last];
  expect(all.map((cut) => cut.index)).toEqual(all.map((_, index) => index));
  expect(all[0]?.start).toBe(0);
  expect(last.end).toBe(audio.length);
  for (const [index, cut] of all.entries()) {
    expect(cut.end).toBeGreaterThan(cut.start);
    expect(seconds(cut.end - cut.start)).toBeLessThanOrEqual(config.chunkMaxDuration / 1000);
    const before = all[index - 1];
    if (before === undefined) continue;
    expect(cut.start).toBeGreaterThan(before.start);
    if (cut.overlapped) {
      expect(cut.start).toBeLessThan(before.end);
      expect(seconds(before.end - cut.start)).toBeLessThanOrEqual(config.chunkMaxOverlap / 1000 + 0.02);
    } else {
      expect(cut.start).toBe(before.end);
    }
  }
}

describe("Chunker", () => {
  test("a short dictation is never cut: one upload, as before chunking", () => {
    const rand = random(1);
    const audio = concat(speech(6, rand), room(2, rand), speech(5, rand));
    const { cuts, last } = chunk(audio);
    expect(cuts).toEqual([]);
    expect(last).toBeNull();
  });

  test("cuts in the middle of a one-second pause once a chunk holds ten seconds of speech", () => {
    const rand = random(2);
    const pauseStart = 12 * rate;
    const audio = concat(speech(12, rand), room(1.5, rand), speech(5, rand));
    const { cuts, last } = chunk(audio);
    expect(cuts).toHaveLength(1);
    const cut = cuts[0];
    if (cut === undefined) return;
    // Inside the pause: no word is split, and nothing overlaps.
    expect(cut.end).toBeGreaterThan(pauseStart);
    expect(cut.end).toBeLessThan(pauseStart + 1.5 * rate);
    // In the middle of the pause's first second, so half its quiet ends this chunk, half starts the next.
    expect(Math.abs(seconds(cut.end - pauseStart) - config.chunkPauseDuration / 2000)).toBeLessThan(0.2);
    expect(cut.overlapped).toBe(false);
    expect(cut.hasSpeech).toBe(true);
    expect(last).toMatchObject({ index: 1, start: cut.end, end: audio.length, overlapped: false, hasSpeech: true });
    expectCovers(audio, cuts, last);
  });

  test("a pause shorter than a second, or before ten seconds of speech, is not cut at", () => {
    const rand = random(3);
    // 0.7 s breaths, then a 2 s pause after only 6 s of speech, then 12 s of speech and a real pause.
    const audio = concat(speech(4, rand), room(0.7, rand), speech(2, rand), room(2, rand), speech(12, rand), room(1.5, rand), speech(3, rand));
    const { cuts, last } = chunk(audio);
    expect(cuts).toHaveLength(1);
    const firstPause = (4 + 0.7 + 2) * rate;
    expect(cuts[0]?.end).toBeGreaterThan(firstPause + 2 * rate + 12 * rate);
    expectCovers(audio, cuts, last);
  });

  /** With no pause at all, a chunk is cut at `chunkMaxDuration`, and the next starts about
   * `chunkOverlapSpeech` of speech earlier, so the cut's words are heard whole in one of them. */
  test("speech with no pause is cut at the maximum length, the next chunk overlapping it", () => {
    const rand = random(4);
    const audio = speech(130, rand);
    const { cuts, last } = chunk(audio);
    expect(cuts).toHaveLength(1);
    const cut = cuts[0];
    if (cut === undefined || last === null) return;
    expect(seconds(cut.end)).toBeGreaterThan((config.chunkMaxDuration - config.chunkForcedCutSearch) / 1000);
    expect(seconds(cut.end)).toBeLessThanOrEqual(config.chunkMaxDuration / 1000);
    expect(last.overlapped).toBe(true);
    const overlap = seconds(cut.end - last.start);
    expect(overlap).toBeGreaterThanOrEqual(config.chunkOverlapSpeech / 1000);
    expect(overlap).toBeLessThanOrEqual(config.chunkMaxOverlap / 1000);
    expectCovers(audio, cuts, last);
  });

  /** The overlap is measured in speech: the gaps between words that are too long to count as speech
   * (but too short to cut at) take it further back. */
  test("the overlap after a forced cut holds its speech, not just its length", () => {
    const rand = random(13);
    // One second of speech, then 0.6 s of quiet: longer than a gap within speech, shorter than a pause.
    const audio = concat(...Array.from({ length: 80 }, () => concat(speech(1, rand), room(0.6, rand))));
    const { cuts, last } = chunk(audio);
    const cut = cuts[0];
    expect(cut).toBeDefined();
    if (cut === undefined || last === null) return;
    expect(last.overlapped).toBe(true);
    // 15 s of this speech spans about 24 s.
    expect(seconds(cut.end - last.start)).toBeGreaterThan((config.chunkOverlapSpeech / 1000) * 1.4);
    expect(seconds(cut.end - last.start)).toBeLessThanOrEqual(config.chunkMaxOverlap / 1000);
  });

  /** The overlap's speech counts toward the next chunk's ten seconds: a pause soon after a forced cut
   * is cut at. */
  test("the next chunk counts the speech it overlaps, so a pause soon after a forced cut is cut at", () => {
    const rand = random(14);
    const audio = concat(speech(config.chunkMaxDuration / 1000 + 3, rand), room(1.5, rand), speech(4, rand));
    const { cuts, last } = chunk(audio);
    expect(cuts).toHaveLength(2);
    expect(cuts[1]?.overlapped).toBe(true);
    expect(last?.overlapped).toBe(false);
    expectCovers(audio, cuts, last);
  });

  /** A forced cut lands on the quietest moment near the end, a dip between syllables. */
  test("a forced cut lands on the quietest window of the chunk's last seconds", () => {
    const rand = random(5);
    const dipAt = config.chunkMaxDuration / 1000 - 2;
    // A 0.4 s dip (shorter than a pause) two seconds before the maximum length.
    const audio = concat(speech(dipAt, rand), room(0.4, rand), speech(20, rand));
    const { cuts } = chunk(audio);
    const end = cuts[0]?.end ?? 0;
    expect(seconds(end)).toBeGreaterThanOrEqual(dipAt);
    expect(seconds(end)).toBeLessThanOrEqual(dipAt + 0.4);
  });

  /** A long silence (hands-free, the user away) is still cut within the maximum length, its chunks
   * marked as holding no speech. */
  test("a long silence is cut within the maximum length, with no speech in it", () => {
    const rand = random(6);
    const audio = concat(speech(12, rand), room(1.5, rand), room(240, rand), speech(5, rand));
    const { cuts, last } = chunk(audio);
    expectCovers(audio, cuts, last);
    expect(cuts[0]?.hasSpeech).toBe(true);
    expect(cuts.slice(1).every((cut) => !cut.hasSpeech)).toBe(true);
    expect(last?.hasSpeech).toBe(true);
  });

  test("a recording of nothing but the room is cut within the maximum length too", () => {
    const rand = random(7);
    const audio = room(250, rand);
    const { cuts, last } = chunk(audio);
    expect(cuts.length).toBeGreaterThan(0);
    expectCovers(audio, cuts, last);
  });

  /** The same audio cuts the same way however the microphone splits it into packets. */
  test("cuts the same whatever the size of the packets fed", () => {
    const rand = random(8);
    const audio = concat(speech(12, rand), room(1.5, rand), speech(30, rand), room(1.2, rand), speech(11, rand), room(1.1, rand), speech(2, rand));
    const byPackets = chunk(audio);
    const bySamples = chunk(audio, 7);
    const whole = chunk(audio, audio.length);
    expect(bySamples).toEqual(byPackets);
    expect(whole).toEqual(byPackets);
    expect(byPackets.cuts).toHaveLength(3);
  });

  /** Seeded random dictations up to ten minutes, of speech, breaths, pauses and long silences at
   * random lengths and loudness: the chunks always cover the recording within the maximum length,
   * and a pause cut always falls in quiet. */
  test("random dictations are always covered within the maximum length", { timeout: 60_000 }, () => {
    for (let seed = 100; seed < 112; seed += 1) {
      const rand = random(seed);
      const parts: Int16Array[] = [];
      let total = 0;
      const target = (60 + rand() * 540) * rate;
      while (total < target) {
        const kind = rand();
        const part = kind < 0.6 ? speech(1 + rand() * (rand() < 0.1 ? 140 : 15), rand, 0.05 + rand() * 0.3) : kind < 0.85 ? room(0.2 + rand() * 0.8, rand) : room(1 + rand() * (rand() < 0.2 ? 60 : 3), rand);
        parts.push(part);
        total += part.length;
      }
      const audio = concat(...parts);
      const { cuts, last } = chunk(audio);
      expectCovers(audio, cuts, last);
    }
  });
});
