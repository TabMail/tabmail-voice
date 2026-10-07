// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { log } from "../log.js";
import { trimWhitespace } from "../util/text.js";

/** One chunk's text, and whether its audio started inside the chunk before it (`ChunkCut.overlapped`). */
export interface ChunkText {
  text: string;
  overlapped: boolean;
}

/** An ellipsis at the end or the start of a text: a model may write the pause a chunk was cut at as one. */
const trailingEllipsis = /(?:\s*(?:\.{3}|…))+\s*$/u;
const leadingEllipsis = /^\s*(?:(?:\.{3}|…)\s*)+/u;
/** Scripts written without spaces between words: no space is added where one meets another chunk,
 * or a delimiter before the caret (`spacedFromCaret`). */
export const unspacedScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * A long dictation's text, from its chunks' texts in order (ADR-DESK-049).
 *
 * - An ellipsis where two chunks meet is taken out (owner, 2026-10-03): it is the pause the cut fell in, not
 *   the speaker's. One inside a chunk stays.
 * - Chunks cut at a pause (only while `chunkCutsAtPauses` is on), or overlapping chunks with no
 *   shared run of words, are joined with a space, or none between scripts written without spaces.
 * - A chunk that starts inside the one before it (no pause to cut at) holds the same speech as the
 *   end of that one: the two are joined where their words first run together for at least
 *   `chunkOverlapMinimumRun` words, the run kept once: its first word as the earlier chunk wrote it,
 *   mid-sentence, since a chunk's first word comes capitalised as the start of its text (owner,
 *   2026-10-03: "capitalization mid breaks"), the rest as the later one did. With no such run they are joined whole
 *   (owner, 2026-10-03: "better than losing things"): a few words may repeat, none are lost.
 * - An empty chunk adds nothing, and the chunk after it is joined whole: it overlaps only the empty
 *   one, so matching it against an earlier chunk's words would cut out the speech between them.
 *   Nothing else is changed: no capital is lowered, no punctuation added.
 */
export function joinChunkTexts(chunks: readonly ChunkText[]): string {
  let joined = "";
  let previousHeard = false;
  for (const chunk of chunks) {
    let text = trimWhitespace(chunk.text);
    if (joined !== "") text = text.replace(leadingEllipsis, "");
    const overlapsJoined = chunk.overlapped && previousHeard;
    previousHeard = text !== "";
    if (text === "") continue;
    if (joined === "") {
      joined = text;
      continue;
    }
    joined = joined.replace(trailingEllipsis, "");
    joined = overlapsJoined ? joinOverlapping(joined, text) : joinedWith(joined, text);
  }
  return joined;
}

/** `left` and `right` with a space between, or none where either side is a script without spaces. */
function joinedWith(left: string, right: string): string {
  if (left === "") return right;
  const last = [...left].at(-1) ?? "";
  const first = [...right][0] ?? "";
  return unspacedScript.test(last) || unspacedScript.test(first) ? `${left}${right}` : `${left} ${right}`;
}

/** `left` and `right`, which both hold the speech around a cut, joined on the longest run of words
 * the end of one and the start of the other share: `left` up to the run's first word, `right` from
 * its second. Each side is cut at a word's place in its own text, so its line breaks and spacing
 * stay as they were. */
function joinOverlapping(left: string, right: string): string {
  const leftWords = [...left.matchAll(/\S+/gu)];
  const rightWords = [...right.matchAll(/\S+/gu)].slice(0, config.chunkOverlapSearchWords);
  const leftFrom = Math.max(0, leftWords.length - config.chunkOverlapSearchWords);
  const leftKeys = leftWords.slice(leftFrom).map((word) => matchKey(word[0]));
  const rightKeys = rightWords.map((word) => matchKey(word[0]));
  const run = longestRun(leftKeys, rightKeys);
  if (run === null || run.length < config.chunkOverlapMinimumRun) {
    log.debug("ChunkJoin: no shared words where two chunks overlap; joined whole");
    return joinedWith(left, right);
  }
  log.debug(() => `ChunkJoin: overlapping chunks joined on a run of ${run.length} words`);
  // A run holds at least `chunkOverlapMinimumRun` (more than one) words, so both have a second word.
  const leftEnd = leftWords[leftFrom + run.left + 1]?.index ?? left.length;
  const rightStart = rightWords[run.right + 1]?.index ?? right.length;
  return joinedWith(trimWhitespace(left.slice(0, leftEnd)), right.slice(rightStart));
}

/** A word as the two chunks' texts are compared: lower case, letters and digits only, so the
 * punctuation and capitals a cut changes around it don't count. */
function matchKey(word: string): string {
  return word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** The longest run of words, none empty, that `left` and `right` share: where it starts in each. */
function longestRun(left: readonly string[], right: readonly string[]): { left: number; right: number; length: number } | null {
  let best: { left: number; right: number; length: number } | null = null;
  let previous = new Uint16Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Uint16Array(right.length + 1);
    for (let j = 1; j <= right.length; j += 1) {
      const key = left[i - 1] ?? "";
      if (key === "" || key !== right[j - 1]) continue;
      const length = (previous[j - 1] ?? 0) + 1;
      current[j] = length;
      if (best === null || length > best.length) best = { left: i - length, right: j - length, length };
    }
    previous = current;
  }
  return best;
}
