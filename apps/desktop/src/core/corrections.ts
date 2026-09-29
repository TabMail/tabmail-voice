// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "./config.js";
import { dictionaryWord, isSameWord } from "./dictionary.js";

/**
 * The words to learn from the user's edit of a pasted dictation (ADR-DESK-038): the field's text
 * `before` the edit, holding the `pasted` text, and `after` it. Only a respelling within the pasted
 * text counts: "Zivora" corrected to "Xyvora", "tab mail" to "TabMail". Nothing is learned from an
 * edit that reaches outside the pasted text, a rewrite of more than `config.correctionMaxChangedShare`
 * of its words, a replacement by a different word (`config.correctionMaxEditShare`), a short or
 * everyday word, or a change of case alone at a word's start.
 */
export function learnedCorrections(pasted: string, before: string, after: string): string[] {
  const edited = editedPaste(pasted, before, after);
  if (edited === null) return [];
  const heardWords = words(pasted);
  const runs = changedRuns(heardWords, words(edited));
  const changed = runs.reduce((count, run) => count + run.heard.length, 0);
  if (changed > heardWords.length * config.correctionMaxChangedShare) return [];
  const learned: string[] = [];
  for (const { heard, corrected } of runs) {
    const word = respelling(heard, corrected);
    if (word !== null && !learned.some((other) => isSameWord(other, word))) learned.push(word);
  }
  return learned;
}

/** `pasted` with the edit from `before` to `after` applied, or null when there is no edit or it is
 * not all within one place `pasted` is in `before`. */
function editedPaste(pasted: string, before: string, after: string): string | null {
  if (pasted === "" || before === after) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix += 1;
  }
  const changeEnd = before.length - suffix;
  for (let start = before.indexOf(pasted); start !== -1; start = before.indexOf(pasted, start + 1)) {
    if (start <= prefix && changeEnd <= start + pasted.length) {
      return pasted.slice(0, prefix - start) + after.slice(prefix, after.length - suffix) + pasted.slice(changeEnd - start);
    }
  }
  return null;
}

/** The text's words, without the punctuation around them. */
function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, ""))
    .filter((word) => word !== "");
}

interface ChangedRun {
  heard: string[];
  corrected: string[];
}

/** Where `corrected` differs from `heard`: the runs of words between those both keep (a longest
 * common subsequence). A change of case is a change: "tabmail" → "TabMail" is a respelling. */
function changedRuns(heard: string[], corrected: string[]): ChangedRun[] {
  const [a, b] = [heard, corrected];
  // kept[i][j]: the most words a[i…] and b[j…] have in common, in order.
  const kept = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      kept[i]![j] = a[i] === b[j] ? kept[i + 1]![j + 1]! + 1 : Math.max(kept[i + 1]![j]!, kept[i]![j + 1]!);
    }
  }
  const runs: ChangedRun[] = [];
  let run: ChangedRun = { heard: [], corrected: [] };
  const close = () => {
    if (run.heard.length > 0 || run.corrected.length > 0) runs.push(run);
    run = { heard: [], corrected: [] };
  };
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || kept[i]![j + 1]! >= kept[i + 1]![j]!)) {
      run.corrected.push(corrected[j]!);
      j += 1;
    } else {
      run.heard.push(heard[i]!);
      i += 1;
    }
  }
  close();
  return runs;
}

/** The corrected words, when they respell the heard ones rather than replace them; else null. */
function respelling(heard: string[], corrected: string[]): string | null {
  if (heard.length === 0 || corrected.length === 0) return null;
  const word = dictionaryWord(corrected.join(" "));
  if (word === null || [...word].length < config.correctionMinWordLength) return null;
  if (corrected.length === 1 && config.correctionCommonWords.has(word.toLowerCase())) return null;
  const [from, to] = [heard.join("").toLowerCase(), corrected.join("").toLowerCase()];
  if (from === to) {
    // Only the case or the spacing changed: learned when the spacing did ("tab mail" → "TabMail"), or
    // a capital went inside a word ("tabmail" → "TabMail"), not a capital at a word's start alone.
    const isInnerCapital = corrected.some((part) => /\p{Lu}/u.test(part.slice(1)));
    return heard.length !== corrected.length || isInnerCapital ? word : null;
  }
  return editDistance([...from], [...to]) <= Math.max([...from].length, [...to].length) * config.correctionMaxEditShare ? word : null;
}

/** The fewest single-character insertions, deletions and substitutions that turn `a` into `b`. */
function editDistance(a: string[], b: string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}
