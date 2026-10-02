// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";

/** A word or name the user wants spelled their way (ADR-DESK-038): typed in Settings, or learned from
 * the user's own correction of a dictation (`learned`). `lastUsed` orders the entries by their latest
 * use (added, typed or learned again, or in a dictation's text), larger the more recent: a count, not
 * a time, so a clock set back can't reorder it. A full dictionary drops the learned word of the
 * smallest for a new one. */
export interface DictionaryEntry {
  word: string;
  learned: boolean;
  lastUsed: number;
}

// Characters the speech providers refuse in a keyword, failing the whole dictation: control
// characters and angle brackets (the backend refuses them too; it allows the C1 controls this also
// refuses).
const forbiddenCharacters = /[\p{Cc}<>]/u;

/** `raw` as a dictionary word, its spaces collapsed; null when it is empty, too long, of too many
 * words, or has a character the backend refuses. */
export function dictionaryWord(raw: string): string | null {
  const word = raw.trim().replace(/\s+/g, " ");
  if (word === "" || word.length > config.dictionaryWordMaxChars || forbiddenCharacters.test(word)) return null;
  return word.split(" ").length > config.dictionaryWordMaxWords ? null : word;
}

/** Whether two words are the same entry: the case aside, as the backend dedupes. */
export function isSameWord(first: string, second: string): boolean {
  return first.toLowerCase() === second.toLowerCase();
}

/** The `lastUsed` of a use now: after every entry's. */
export function nextUse(entries: readonly DictionaryEntry[]): number {
  return entries.reduce((latest, entry) => Math.max(latest, entry.lastUsed), 0) + 1;
}

/** The index of the learned entry used least recently before `use` (the earliest added of a tie): the
 * one a full dictionary drops for a new word; -1 when there is none. */
export function leastRecentlyUsedLearned(entries: readonly DictionaryEntry[], use: number): number {
  let found = -1;
  let foundUse = use;
  entries.forEach((entry, index) => {
    if (!entry.learned || entry.lastUsed >= foundUse) return;
    found = index;
    foundUse = entry.lastUsed;
  });
  return found;
}

/** A stored list read back: valid entries only, the first of any two that are the same word, at most
 * `config.dictionaryMaxEntries`. An entry without a valid `lastUsed` (one stored before it was kept)
 * reads as never used. */
export function storedDictionary(stored: unknown): DictionaryEntry[] {
  if (!Array.isArray(stored)) return [];
  const entries: DictionaryEntry[] = [];
  for (const item of stored) {
    if (entries.length === config.dictionaryMaxEntries) break;
    if (!item || typeof item !== "object") continue;
    const { word, learned, lastUsed } = item as Record<string, unknown>;
    if (typeof word !== "string" || typeof learned !== "boolean" || dictionaryWord(word) !== word) continue;
    if (entries.some((entry) => isSameWord(entry.word, word))) continue;
    entries.push({ word, learned, lastUsed: typeof lastUsed === "number" && Number.isSafeInteger(lastUsed) && lastUsed > 0 ? lastUsed : 0 });
  }
  return entries;
}
