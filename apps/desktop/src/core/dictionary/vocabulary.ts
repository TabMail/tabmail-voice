// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import type { DictionaryWords } from "./entries.js";

/** The terms a dictation sends with its recording (ADR-DESK-038, amended for #309), most important
 * first. A speech model heeds only the first `config.vocabularyModelMaxTerms`, so those are chosen in
 * shares: the screen's terms (`shown`, from what the window shows) keep up to
 * `config.vocabularyScreenShare` places, and of the dictionary's room the learned words keep all
 * but `config.vocabularyTypedShare`, the typed words' share. A share another group can't fill passes
 * on. In order: the typed words, the screen's terms, the learned words, then the whole window's terms
 * (`window`) in any room left. With `cleans` (the backend's cleanup reads the request too), the words
 * that didn't fit follow, up to `config.vocabularyMaxTerms`: the rest of the dictionary (typed, then
 * learned), the rest of the screen's terms, the rest of the whole window's. Without it, only the
 * first ones go. No term twice, whatever its case; a screen term that is a dictionary word goes as the
 * dictionary's, if at all. */
export function dictationVocabulary(dictionary: DictionaryWords, shown: readonly string[], window: readonly string[], cleans: boolean): string[] {
  const { typed, learned } = dictionary;
  const key = (term: string) => term.toLowerCase();
  const inDictionary = new Set([...typed, ...learned].map(key));
  const notInDictionary = (terms: readonly string[]) => terms.filter((term) => !inDictionary.has(key(term)));
  const screen = notInDictionary(shown);
  const wholeWindow = notInDictionary(window);
  const room = config.vocabularyModelMaxTerms - Math.min(config.vocabularyScreenShare, screen.length);
  const learnedShare = Math.min(learned.length, Math.max(0, room - config.vocabularyTypedShare));
  const typedSent = Math.min(typed.length, room - learnedShare);
  const learnedSent = Math.min(learned.length, room - typedSent);

  const sent: string[] = [];
  const seen = new Set<string>();
  const add = (terms: readonly string[], max: number) => {
    for (const term of terms) {
      if (sent.length >= max) return;
      if (seen.has(key(term))) continue;
      seen.add(key(term));
      sent.push(term);
    }
  };
  add(typed.slice(0, typedSent), config.vocabularyModelMaxTerms);
  // The screen's terms go before the learned words, in the room those leave.
  add(screen, config.vocabularyModelMaxTerms - learnedSent);
  add(learned.slice(0, learnedSent), config.vocabularyModelMaxTerms);
  add(wholeWindow, config.vocabularyModelMaxTerms);
  if (!cleans) return sent;
  for (const rest of [typed, learned, screen, wholeWindow]) add(rest, config.vocabularyMaxTerms);
  return sent;
}
