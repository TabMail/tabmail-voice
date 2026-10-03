// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";

/** A part of a recording sent on its own (ADR-DESK-048): samples `start` to `end` (exclusive). */
export interface ChunkCut {
  /** Its place in the recording, from 0. */
  index: number;
  start: number;
  end: number;
  /** True when it starts inside the chunk before it: that chunk was cut with no pause to cut at, so
   * both hold the same `chunkOverlapSpeech` of speech, which the join removes once
   * (`joinChunkTexts`). */
  overlapped: boolean;
}

/** Decibels of digital silence, and the histogram's range: −100…0 dB in `binsPerDecibel` steps. */
const silenceDecibels = -100;
const binsPerDecibel = 2;
const binCount = -silenceDecibels * binsPerDecibel + 1;

/**
 * Where a long recording is cut into chunks, as it is recorded (ADR-DESK-048). It reads the loudness
 * of each `chunkFrameDuration` frame against the recording's own levels, never a fixed one: the
 * quiet end of its frames (`chunkFloorPercentile`) is the room, the loud end
 * (`chunkSpeechPercentile`) the voice, and a frame below `chunkPauseLevel` of the way from one to
 * the other is quiet, and a run of quiet frames shorter than `chunkSpeechGap` (between syllables and
 * words) counts as speech, as louder frames no longer than `chunkPauseBlip` inside a quiet stretch (the
 * room's noise) count as quiet. On quiet microphones speech stands only a few dB above the room (ADR-DESK-005),
 * which only levels taken from the recording itself can tell apart.
 *
 * - **A pause:** once a chunk holds `chunkMinimumSpeech` of speech, it is cut in the middle of the
 *   next `chunkPauseDuration` of quiet. No word crosses a pause, so nothing overlaps. Speech much
 *   softer than what came before, with few frames at the room's level, can read as quiet: a cut
 *   there may split a word or two (found in review, 2026-10-03; the chunk is still sent).
 * - **No pause:** a chunk that reaches `chunkMaxDuration` is cut anyway, at the quietest
 *   `chunkForcedCutWindow` of its last `chunkForcedCutSearch`, and the next chunk starts
 *   `chunkOverlapSpeech` of speech earlier (at most `chunkMaxOverlap` earlier), so the words the
 *   cut garbles are heard whole in one of the two.
 *
 * A recording never cut is one upload, as before chunking.
 */
export class Chunker {
  private readonly frameLength: number;
  private readonly pauseFrames: number;
  private readonly minimumSpeechFrames: number;
  private readonly maxSamples: number;
  private readonly overlapSpeechFrames: number;
  private readonly maxOverlapFrames: number;
  private readonly forcedSearchFrames: number;
  private readonly forcedWindowFrames: number;
  private readonly gapFrames: number;
  private readonly blipFrames: number;
  /** Each whole frame's loudness (dB), from the start of the recording. */
  private decibels = new Float32Array(1_024);
  private frames = 0;
  private readonly histogram = new Uint32Array(binCount);
  /** Samples of the frame not yet whole, and how many. */
  private readonly pending: Int16Array;
  private pendingCount = 0;
  /** The current chunk: its first sample, whether it overlaps the one before, and its speech frames. */
  private chunkStart = 0;
  private chunkOverlapped = false;
  private speechFrames = 0;
  /** The quiet stretch the chunk ends on so far, with any blips inside it, and the louder frames
   * since its last quiet one: a blip yet, or speech once longer than `chunkPauseBlip`. */
  private quietRun = 0;
  private loudRun = 0;
  private cuts = 0;

  constructor(readonly sampleRate: number = config.recordingSampleRate) {
    const frames = (duration: number) => Math.max(1, Math.round(duration / config.chunkFrameDuration));
    this.frameLength = Math.round((sampleRate * config.chunkFrameDuration) / 1000);
    this.pending = new Int16Array(this.frameLength);
    this.pauseFrames = frames(config.chunkPauseDuration);
    this.minimumSpeechFrames = frames(config.chunkMinimumSpeech);
    this.maxSamples = Math.round((sampleRate * config.chunkMaxDuration) / 1000);
    this.overlapSpeechFrames = frames(config.chunkOverlapSpeech);
    this.maxOverlapFrames = frames(config.chunkMaxOverlap);
    this.forcedSearchFrames = frames(config.chunkForcedCutSearch);
    this.forcedWindowFrames = frames(config.chunkForcedCutWindow);
    this.gapFrames = frames(config.chunkSpeechGap);
    this.blipFrames = frames(config.chunkPauseBlip);
  }

  /** Reads the next samples of the recording (16-bit, as captured, before any normalization) and
   * returns the chunks they complete, in order: usually none. */
  append(samples: Int16Array): ChunkCut[] {
    const cuts: ChunkCut[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(this.frameLength - this.pendingCount, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + count), this.pendingCount);
      this.pendingCount += count;
      offset += count;
      if (this.pendingCount < this.frameLength) break;
      this.pendingCount = 0;
      const cut = this.frame(frameDecibels(this.pending));
      if (cut !== null) cuts.push(cut);
    }
    return cuts;
  }

  /** The last chunk, from the last cut to `totalSamples`, the end of the recording; null when the
   * recording was never cut (one upload, as before chunking). */
  finish(totalSamples: number): ChunkCut | null {
    if (this.cuts === 0) return null;
    // The frame not yet whole is part of the last chunk; its loudness is not needed.
    return { index: this.cuts, start: this.chunkStart, end: totalSamples, overlapped: this.chunkOverlapped };
  }

  /** Takes the next whole frame; returns the chunk it completes, if any. */
  private frame(decibels: number): ChunkCut | null {
    if (this.frames === this.decibels.length) {
      const grown = new Float32Array(this.decibels.length * 2);
      grown.set(this.decibels);
      this.decibels = grown;
    }
    const index = this.frames;
    this.decibels[index] = decibels;
    this.frames += 1;
    this.histogram[binOf(decibels)] = (this.histogram[binOf(decibels)] ?? 0) + 1;

    const quiet = decibels < this.pauseLevel();
    this.count(quiet);
    const frameEnd = this.frames * this.frameLength;
    if (quiet && this.quietRun >= this.pauseFrames && this.speechFrames >= this.minimumSpeechFrames) {
      // The middle of the pause so far: half its quiet ends this chunk, half starts the next.
      return this.cut(frameEnd - Math.floor(this.pauseFrames / 2) * this.frameLength, null);
    }
    if (frameEnd - this.chunkStart >= this.maxSamples) return this.forcedCut();
    return null;
  }

  /** No pause came: the chunk ends at the quietest window of its last frames, and the next starts
   * `chunkOverlapSpeech` of speech before that. */
  private forcedCut(): ChunkCut {
    const firstFrame = Math.max(Math.ceil(this.chunkStart / this.frameLength), this.frames - this.forcedSearchFrames);
    let best = this.frames - this.forcedWindowFrames;
    let bestPower = Number.POSITIVE_INFINITY;
    for (let start = firstFrame; start + this.forcedWindowFrames <= this.frames; start += 1) {
      let power = 0;
      for (let frame = start; frame < start + this.forcedWindowFrames; frame += 1) power += 10 ** ((this.decibels[frame] ?? silenceDecibels) / 10);
      if (power < bestPower) {
        bestPower = power;
        best = start;
      }
    }
    const end = (best + Math.floor(this.forcedWindowFrames / 2)) * this.frameLength;
    // Back from the cut, over frames the current levels call speech, to `chunkOverlapSpeech` of it,
    // never past `chunkMaxOverlap` nor to the chunk's own start.
    const level = this.pauseLevel();
    const earliest = Math.max(Math.floor(end / this.frameLength) - this.maxOverlapFrames, Math.floor(this.chunkStart / this.frameLength) + 1);
    let frame = Math.floor(end / this.frameLength);
    let speech = 0;
    let gap = 0;
    while (frame > earliest && speech < this.overlapSpeechFrames) {
      frame -= 1;
      if ((this.decibels[frame] ?? silenceDecibels) < level) {
        gap += 1;
        continue;
      }
      if (gap < this.gapFrames) speech += gap;
      gap = 0;
      speech += 1;
    }
    return this.cut(end, frame * this.frameLength);
  }

  /** Ends the current chunk at sample `end`; the next starts at `nextStart`, or at `end` when null
   * (no overlap). */
  private cut(end: number, nextStart: number | null): ChunkCut {
    const chunk: ChunkCut = { index: this.cuts, start: this.chunkStart, end, overlapped: this.chunkOverlapped };
    this.cuts += 1;
    this.chunkStart = nextStart ?? end;
    this.chunkOverlapped = nextStart !== null;
    // The next chunk's speech so far, from its start to now, and the quiet it ends on.
    const level = this.pauseLevel();
    this.speechFrames = 0;
    this.quietRun = 0;
    this.loudRun = 0;
    for (let frame = Math.floor(this.chunkStart / this.frameLength); frame < this.frames; frame += 1) this.count((this.decibels[frame] ?? silenceDecibels) < level);
    return chunk;
  }

  /** Counts the next frame into the chunk's speech or the quiet it ends on. */
  private count(quiet: boolean): void {
    if (quiet) {
      // A blip inside the quiet was the room's: the quiet goes on through it.
      this.quietRun += this.loudRun + 1;
      this.loudRun = 0;
      return;
    }
    this.loudRun += 1;
    if (this.quietRun > 0 && this.loudRun <= this.blipFrames) return;
    // Speech: a gap between syllables or words before it is part of the speech; a longer quiet is not.
    if (this.quietRun < this.gapFrames) this.speechFrames += this.quietRun;
    this.speechFrames += this.loudRun;
    this.quietRun = 0;
    this.loudRun = 0;
  }

  /** The loudness below which a frame is quiet: `chunkPauseLevel` of the way from the recording's
   * room level to its voice level. The voice level is taken over the frames at least
   * `chunkMinimumRange` above the room only, so a long silence doesn't drag it down to the room's;
   * with no such frame there is no voice yet, and every frame is quiet. */
  private pauseLevel(): number {
    const floor = this.percentile(config.chunkFloorPercentile, 0);
    if (floor === null) return Number.POSITIVE_INFINITY;
    const speech = this.percentile(config.chunkSpeechPercentile, binOf(floor + config.chunkMinimumRange));
    if (speech === null) return Number.POSITIVE_INFINITY;
    return floor + config.chunkPauseLevel * (speech - floor);
  }

  /** The loudness `fraction` of the way up the frames from bin `fromBin`; null when there are none. */
  private percentile(fraction: number, fromBin: number): number | null {
    let count = 0;
    for (let bin = fromBin; bin < binCount; bin += 1) count += this.histogram[bin] ?? 0;
    if (count === 0) return null;
    const target = Math.floor(fraction * (count - 1));
    let seen = 0;
    for (let bin = fromBin; bin < binCount; bin += 1) {
      seen += this.histogram[bin] ?? 0;
      if (seen > target) return silenceDecibels + bin / binsPerDecibel;
    }
    return null;
  }
}

/** A frame's RMS loudness in dBFS, at least `silenceDecibels`. */
function frameDecibels(samples: Int16Array): number {
  let sumOfSquares = 0;
  for (const sample of samples) sumOfSquares += sample * sample;
  const rms = Math.sqrt(sumOfSquares / samples.length) / 0x8000;
  return rms > 0 ? Math.max(20 * Math.log10(rms), silenceDecibels) : silenceDecibels;
}

function binOf(decibels: number): number {
  return Math.min(binCount - 1, Math.max(0, Math.round((decibels - silenceDecibels) * binsPerDecibel)));
}
