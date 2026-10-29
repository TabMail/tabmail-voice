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
 * (`window`) in any room left. With `cleans` (the backend's cleanup reads the request too), the rest
 * of the screen's terms follow, then the rest of the whole window's, up to
 * `config.cleanupScreenMaxTerms` of theirs in all (#310); the dictionary's words past the first ones
 * go only in the cleanup's own dictionary (`cleanupDictionary`). Without it, only the first ones go. No
 * term twice, whatever its case; a screen term that is one of the cleanup's dictionary words goes as
 * the dictionary's, if at all, so it reaches the cleanup in one list or the other; a word past those
 * (a learned word long unused) is a screen term like any other. */
export function dictationVocabulary(dictionary: DictionaryWords, shown: readonly string[], window: readonly string[], cleans: boolean): string[] {
  const { typed, learned } = dictionary;
  const key = (term: string) => term.toLowerCase();
  // Every dictionary word the first ones can hold is among these: the typed words (`AppSettings` keeps
  // at most 100), then the learned most recently used first.
  const inDictionary = new Set(cleanupDictionary(dictionary).map(key));
  const notInDictionary = (terms: readonly string[]) => terms.filter((term) => !inDictionary.has(key(term)));
  const screen = notInDictionary(shown);
  const wholeWindow = notInDictionary(window);
  const room = config.vocabularyModelMaxTerms - Math.min(config.vocabularyScreenShare, screen.length);
  const learnedShare = Math.min(learned.length, Math.max(0, room - config.vocabularyTypedShare));
  const typedSent = Math.min(typed.length, room - learnedShare);
  const learnedSent = Math.min(learned.length, room - typedSent);

  const sent: string[] = [];
  const seen = new Set<string>();
  /** Adds `terms` not sent yet while fewer than `max` are; how many it added. */
  const add = (terms: readonly string[], max: number) => {
    const before = sent.length;
    for (const term of terms) {
      if (sent.length >= max) break;
      if (seen.has(key(term))) continue;
      seen.add(key(term));
      sent.push(term);
    }
    return sent.length - before;
  };
  add(typed.slice(0, typedSent), config.vocabularyModelMaxTerms);
  // The screen's terms go before the learned words, in the room those leave.
  let screenSent = add(screen, config.vocabularyModelMaxTerms - learnedSent);
  add(learned.slice(0, learnedSent), config.vocabularyModelMaxTerms);
  screenSent += add(wholeWindow, config.vocabularyModelMaxTerms);
  if (!cleans) return sent;
  const max = sent.length - screenSent + config.cleanupScreenMaxTerms;
  add(screen, max);
  add(wholeWindow, max);
  return sent;
}

/** The user's words the backend's cleanup gets in its own dictionary (#310): the typed ones, then the
 * learned, each most recently used first, at most `config.cleanupDictionaryMaxWords`. */
export function cleanupDictionary(dictionary: DictionaryWords): string[] {
  return [...dictionary.typed, ...dictionary.learned].slice(0, config.cleanupDictionaryMaxWords);
}
