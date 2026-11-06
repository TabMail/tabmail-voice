// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { contextTerms, termCandidates, type WordFrequencies } from "../../../src/core/dictionary/contextTerms.js";

/** The rule's cases every implementation runs (TabMail on iOS copies them), their answers checked
 * against the real word list in the shared core's suite. */
const shared = JSON.parse(readFileSync(join(__dirname, "../../../native/shared/dictionary/cases.json"), "utf8")) as {
  cutoff: number;
  terms: { name: string; text: string; zipf: Record<string, number | null>; terms: string[] }[];
};

/** The names and terms picked from the screen read at key-down (ADR-DESK-038, amended 2026-11-05),
 * sent with a dictation beside the user's dictionary. */
describe("contextTerms", () => {
  test.each(shared.terms)("$name", ({ text, zipf, terms }) => {
    // The case answers exactly the words the rule asks about.
    expect(termCandidates(text)).toEqual(Object.keys(zipf));
    expect(contextTerms(text, new Map(Object.entries(zipf)))).toEqual(terms);
  });

  test("the shared cases' cutoff is the app's", () => {
    expect(shared.cutoff).toBe(config.screenTermCommonZipf);
  });

  /** A word the list sees exactly as often as the cutoff is ordinary; one tenth less, a term. */
  test("the cutoff is where a word stops being rare", () => {
    const zipf = (seen: number): WordFrequencies => new Map([["Brevalle", seen]]);
    expect(contextTerms("Brevalle", zipf(40), 40)).toEqual([]);
    expect(contextTerms("Brevalle", zipf(39), 40)).toEqual(["Brevalle"]);
    expect(contextTerms("Brevalle", zipf(50), 51)).toEqual(["Brevalle"]);
  });

  /** A capital is what makes a word with no list (null) a term, a titlecase digraph ("ǅ") too; a
   * word the list answers for is judged by how often it is seen, whatever its case. */
  test("a capital letter decides only for a word in a script no list is written in", () => {
    const zipf: WordFrequencies = new Map([["Արամ", null], ["ǅamila", null], ["սարգիս", null], ["kubectl", 0], ["Today", 56]]);
    expect(contextTerms("Արամ ǅamila սարգիս kubectl Today", zipf)).toEqual(["Արամ", "ǅamila", "kubectl"]);
  });

  /** An answer that has no entry for a word (it was asked before the screen changed) makes no term. */
  test("a word the answer has nothing for is no term", () => {
    expect(contextTerms("Xyvora Brevalle", new Map([["Xyvora", 0]]))).toEqual(["Xyvora"]);
  });

  test("rarer first, then the most often on screen, then the earliest", () => {
    const zipf: WordFrequencies = new Map([["Nairobi", 34], ["Priya", 29], ["Xyvora", 0], ["Brevalle", 0], ["Quillon", null]]);
    expect(contextTerms("Nairobi Nairobi Priya Brevalle Xyvora Xyvora Quillon", zipf)).toEqual(["Xyvora", "Brevalle", "Quillon", "Priya", "Nairobi"]);
  });

  /** Each term is a word the user's dictionary could hold: long enough, no longer than it allows,
   * and without a character it refuses (an angle bracket a code editor shows inside a word). */
  test("every term is a valid dictionary word", () => {
    const long = "X".repeat(config.dictionaryWordMaxChars + 1);
    const zipf: WordFrequencies = new Map([["Xy", 0], [long, 0], ["Xy<vora", 0], ["Bre>valle", 0], ["Xyv", 0]]);
    expect(contextTerms(`Xy ${long} Xy<vora Bre>valle Xyv`, zipf)).toEqual(["Xyv"]);
  });

  test("the candidates are every word with a letter, each once, without digits or addresses, no longer than a dictionary word", () => {
    expect(termCandidates("Ask Xyvora, ask\u0085Xyvora: (Brevalle) Xyvora4 2026 -- user@example.com https://example.com/x 'kubectl'")).toEqual(
      ["Ask", "Xyvora", "ask", "Brevalle", "kubectl"],
    );
    expect(termCandidates(`Xyvora ${"X".repeat(config.dictionaryWordMaxChars + 1)} ${"y".repeat(config.dictionaryWordMaxChars)}`)).toEqual(["Xyvora", "y".repeat(config.dictionaryWordMaxChars)]);
    expect(termCandidates("")).toEqual([]);
    expect(contextTerms("", new Map())).toEqual([]);
  });

  /** The words asked about are those the rule judges: an address or a word with a digit is skipped
   * even when an answer is given for it. */
  test("a word that is no candidate is no term, whatever the answer", () => {
    const zipf: WordFrequencies = new Map([["Xyvora4", 0], ["user@example.com", 0], ["https://example.com", 0]]);
    expect(contextTerms("Xyvora4 user@example.com https://example.com", zipf)).toEqual([]);
  });
});
