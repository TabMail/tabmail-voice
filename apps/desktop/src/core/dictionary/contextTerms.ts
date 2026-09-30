// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { dictionaryWord } from "./entries.js";

/**
 * The names and terms in `text`, what was on screen when a dictation started (ADR-DESK-038): sent
 * with the dictation beside the user's dictionary, so the speech model spells them as they appear
 * there. A dictionary built on the fly from the screen, picked on this Mac; only the words picked are
 * sent. A term is a word with a capital letter anywhere but at the start of a sentence (a name,
 * "TabMail", "OKR"); runs of them are kept together ("Kaelthorne Drake"); not everyday words, no
 * addresses. The most frequent first, then the earliest; none the same word as one in `excluding` or
 * another; each a valid dictionary word; at most `max`. TabMail on iOS picks them by the same rules
 * (its ADR-IOS-086).
 */
export function contextTerms(text: string, excluding: readonly string[], max: number): string[] {
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
    let sentenceStart = true;
    for (const token of line.split(/\s+/).filter((token) => token !== "")) {
      const word = trimmed(token);
      // Punctuation before a word ends a run too ("Xyvora (Brevalle Labs)", a link's "[").
      if (!token.startsWith(word)) endRun();
      if (isTerm(word, token, sentenceStart)) run.push(word);
      else endRun();
      // Punctuation after a word ends a run ("Kaelthorne, Drake"); a full stop also ends the sentence.
      if (word === "" || !token.endsWith(word)) endRun();
      if (word !== "") sentenceStart = endsSentence(token);
    }
    endRun();
  }
  const excluded = new Set(excluding.map((word) => word.toLowerCase()));
  return [...tallies.values()]
    .filter(({ term }) => !excluded.has(term.toLowerCase()))
    .sort((a, b) => (a.count !== b.count ? b.count - a.count : a.first - b.first))
    .slice(0, max)
    .map(({ term }) => term);
}

/** Whether a word is a name or term: a capital inside it, or a capital at its start where no sentence
 * starts; not an everyday word; not an address. */
function isTerm(word: string, token: string, sentenceStart: boolean): boolean {
  if (word === "" || token.includes("@") || token.includes("://")) return false;
  const [first, ...rest] = [...word];
  if (rest.some((character) => /\p{Lu}/u.test(character))) return true;
  if (sentenceStart || !/\p{Lu}/u.test(first!)) return false;
  return !config.correctionCommonWords.has(word.toLowerCase());
}

/** Whether the punctuation after a word ends its sentence (`Drake.` or `Drake?"`). */
function endsSentence(token: string): boolean {
  return /[.!?]/.test(/[^\p{L}\p{N}\p{M}]*$/u.exec(token)![0]);
}

/** The token without the punctuation around it. */
export function trimmed(token: string): string {
  return token.replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, "");
}
