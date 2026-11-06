// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { dictionaryWord } from "./entries.js";

/** How often each screen word is seen (`NativeWordFrequencies`), keyed by the word as asked: its Zipf
 * in tenths, 0 when the word list doesn't have it, null when no list is written in its script. */
export type WordFrequencies = ReadonlyMap<string, number | null>;

/**
 * The words in `text` that `contextTerms` asks about, each once (ADR-DESK-038, amended 2026-11-05):
 * every word, split on spaces with the punctuation around it trimmed, that has a letter, no digit, and
 * is no part of an address.
 */
export function termCandidates(text: string): string[] {
  const candidates = new Set<string>();
  for (const token of text.split(/[\s\u0085]+/u)) {
    const word = trimmed(token);
    if (isCandidate(word, token)) candidates.add(word);
  }
  return [...candidates];
}

/**
 * The names and terms in `text`, what was on screen when a dictation started (ADR-DESK-038, amended
 * 2026-11-05): sent with the dictation beside the user's dictionary, so the speech model spells them
 * as they appear there. A term is a candidate (`termCandidates`) that is not ordinary: the word list
 * sees it less often than `cutoff`, or, in a script no list is written in, it has a capital letter.
 * Each word stands alone. The rarest first (a word no list has, or in a script without a list, counts
 * as 0), then the most often on screen, then the earliest; none the same word as another, the case
 * aside; each a valid dictionary word; all of them (`dictationVocabulary` sends as many as it has room
 * for). A word `frequencies` has no answer for is no term. TabMail on iOS applies the same rule
 * (its ADR-IOS-086).
 */
export function contextTerms(text: string, frequencies: WordFrequencies, cutoff = config.screenTermCommonZipf): string[] {
  const tallies = new Map<string, { term: string; zipf: number; count: number; first: number }>();
  for (const token of text.split(/[\s\u0085]+/u)) {
    const word = trimmed(token);
    if (!isCandidate(word, token)) continue;
    const zipf = frequencies.get(word);
    if (zipf === undefined || (zipf === null ? !/\p{Lu}|\p{Lt}/u.test(word) : zipf >= cutoff)) continue;
    const term = dictionaryWord(word);
    if (term === null || [...term].length < config.correctionMinWordLength) continue;
    const key = term.toLowerCase();
    const existing = tallies.get(key);
    if (existing) existing.count += 1;
    else tallies.set(key, { term, zipf: zipf ?? 0, count: 1, first: tallies.size });
  }
  return [...tallies.values()]
    .sort((a, b) => a.zipf - b.zipf || b.count - a.count || a.first - b.first)
    .map(({ term }) => term);
}

/** Whether a word is asked about: a letter in it, no digit, not part of an address. */
function isCandidate(word: string, token: string): boolean {
  return /\p{L}/u.test(word) && !/\p{N}/u.test(word) && !token.includes("@") && !token.includes("://");
}

/** The token without the punctuation around it. */
export function trimmed(token: string): string {
  return token.replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, "");
}
