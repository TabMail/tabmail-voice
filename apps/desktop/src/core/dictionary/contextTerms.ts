// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { dictionaryWord } from "./entries.js";

/**
 * The words in `text` that may be names or terms, each once: those `contextTerms` asks `known`
 * about, for the dictionaries of the user's languages to answer (ADR-DESK-038, amended 2026-11-04).
 * A word may be a term when it has a capital letter anywhere, or is in a script without case
 * (Hangul); never when it holds a digit or is part of an address. Words are split on spaces.
 */
export function termCandidates(text: string): string[] {
  const candidates = new Set<string>();
  // Split as `contextTerms` splits: its lines, then their spaces.
  for (const token of text.split(/[\s\u0085]+/)) {
    const word = trimmed(token);
    if (mayBeTerm(word, token)) candidates.add(word);
  }
  return [...candidates];
}

/**
 * The names and terms in `text`, what was on screen when a dictation started (ADR-DESK-038, amended
 * 2026-11-04): sent with the dictation beside the user's dictionary, so the speech model spells them
 * as they appear there. A term is a word that may be one (`termCandidates`) and that no dictionary of
 * the user's languages knows: `known` holds the candidates one does (in its lowercase form, so a name
 * a dictionary keeps capitalized, "Paris", is a term, and "Today" starting a sentence is not). Runs of
 * them are kept together ("Kaelthorne Drake"), a word in a script without case standing alone, since
 * such a script marks no name. The most frequent first, then the earliest; none the same word as
 * another; each a valid dictionary word; all of them (`dictationVocabulary` sends as many as it has
 * room for, once the user's dictionary words are left out). TabMail on iOS picks terms by its own
 * rules (its ADR-IOS-086).
 */
export function contextTerms(text: string, known: ReadonlySet<string>): string[] {
  const tallies = new Map<string, { term: string; count: number; first: number }>();
  const tally = (term: string) => {
    const word = dictionaryWord(term);
    if (word === null || [...word].length < config.correctionMinWordLength) return;
    const key = word.toLowerCase();
    const existing = tallies.get(key);
    if (existing) existing.count += 1;
    else tallies.set(key, { term: word, count: 1, first: tallies.size });
  };
  for (const line of text.split(/[\n\v\f\r\u0085\u2028\u2029]/)) {
    let run: string[] = [];
    const endRun = () => {
      // A longer run is a title or a heading, not a name: its words count one by one.
      if (run.length <= config.dictionaryWordMaxWords) {
        if (run.length > 0) tally(run.join(" "));
      } else {
        run.forEach(tally);
      }
      run = [];
    };
    for (const token of line.split(/\s+/).filter((token) => token !== "")) {
      const word = trimmed(token);
      // Punctuation before a word ends a run too ("Xyvora (Brevalle Labs)", a link's "[").
      if (!token.startsWith(word)) endRun();
      if (mayBeTerm(word, token) && !known.has(word)) {
        if (isCaseless(word)) {
          endRun();
          tally(word);
        } else {
          run.push(word);
        }
      } else {
        endRun();
      }
      // Punctuation after a word ends a run ("Kaelthorne, Drake").
      if (word === "" || !token.endsWith(word)) endRun();
    }
    endRun();
  }
  return [...tallies.values()]
    .sort((a, b) => (a.count !== b.count ? b.count - a.count : a.first - b.first))
    .map(({ term }) => term);
}

/** Whether a word may be a name or term: a capital letter in it, or a script without case; no digit;
 * not an address. */
function mayBeTerm(word: string, token: string): boolean {
  if (word === "" || token.includes("@") || token.includes("://") || /\p{N}/u.test(word)) return false;
  return /\p{Lu}|\p{Lt}/u.test(word) || isCaseless(word);
}

/** Whether a word's letters have no case (Hangul, Han, Arabic): none would change case. */
function isCaseless(word: string): boolean {
  return /\p{L}/u.test(word) && word.toLowerCase() === word && word.toUpperCase() === word;
}

/** The token without the punctuation around it. */
export function trimmed(token: string): string {
  return token.replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, "");
}
