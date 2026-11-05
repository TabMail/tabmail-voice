// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { contextTerms, termCandidates } from "../../../src/core/dictionary/contextTerms.js";

/** Stands in for the dictionaries of the user's languages (the shared core's `knownWords`, tested
 * with the real ones in Rust): a word is known when its lowercase form is one of these. */
const everyday = new Set([
  "i", "the", "and", "then", "today", "tomorrow", "works", "friday", "too", "maybe", "ask", "from", "thanks", "see",
  "report", "came", "review", "done", "we", "ship", "it", "quarterly", "planning", "notes", "engineering", "staff",
  "내일", "에서",
]);

/** The names and terms picked from the screen read at key-down (ADR-DESK-038, amended 2026-11-04),
 * sent with a dictation beside the user's dictionary. */
describe("contextTerms", () => {
  const known = (text: string) => new Set(termCandidates(text).filter((word) => everyday.has(word.toLowerCase())));
  const terms = (text: string) => contextTerms(text, known(text));

  test("picks names and terms, not everyday words", () => {
    expect(terms("I spoke with Xyvora about the launch plan.")).toEqual(["Xyvora"]);
    expect(terms("the brevalle report is late")).toEqual([]);
  });

  /** The reason for the dictionary (#333): a chat's author line starts with the author's full name,
   * which the old rule took for a sentence's first word and dropped. */
  test("a name starting a line or a sentence is a term; an everyday word there is not", () => {
    expect(terms("Xyvora Brevalle  [Today at 4:12 PM]\nwe ship it")).toEqual(["Xyvora Brevalle"]);
    expect(terms("Tomorrow works. Xyvora asks. Friday too? Maybe")).toEqual(["Xyvora"]);
    expect(terms("Tomorrow works\nFriday too")).toEqual([]);
    expect(terms("- Review the launch\n• Tomorrow we ship\nDone. — Xyvora")).toEqual(["Xyvora"]);
  });

  /** A capital inside a word marks a term wherever it is: "TabMail", "OKR", "iOS". */
  test("a capital inside a word is a term anywhere", () => {
    expect(terms("TabMail ships the OKR list for iOS.")).toEqual(["TabMail", "OKR", "iOS"]);
    // A titlecase letter (one of the digraphs, "ǅ") is a capital too.
    expect(terms("ask ǅemivora today")).toEqual(["ǅemivora"]);
  });

  /** Names of more than one word are kept together, up to a dictionary word's length; punctuation
   * between them splits them; a longer run of capitals is a heading, its words counted alone. */
  test("runs of capitals are kept together", () => {
    expect(terms("From: Kaelthorne Drake")).toEqual(["Kaelthorne Drake"]);
    expect(terms("I met Kaelthorne, Drake and Xyvora.")).toEqual(["Kaelthorne", "Drake", "Xyvora"]);
    expect(terms("Thanks Xyvora [Brevalle Labs] shipped it")).toEqual(["Xyvora", "Brevalle Labs"]);
    expect(terms("met Xyvora (Brevalle Labs) and cc Kaelthorne \"Drake\" today")).toEqual(["Xyvora", "Brevalle Labs", "Kaelthorne", "Drake"]);
    expect(terms("see Brevalle Xyvora Labs Kaelthorne Drake Quill")).toEqual(["Brevalle Xyvora Labs Kaelthorne Drake Quill"]);
    expect(terms("see Brevalle Xyvora Labs Kaelthorne Drake Quill Zorvek")).toEqual(["Brevalle", "Xyvora", "Labs", "Kaelthorne", "Drake", "Quill", "Zorvek"]);
    // An everyday word ends a run, a heading's included.
    expect(terms("see the Quarterly Planning Review Notes Brevalle Engineering Staff")).toEqual(["Brevalle"]);
  });

  test("everyday words, digits and addresses are not terms", () => {
    expect(terms("and then The report came")).toEqual([]);
    expect(terms("write to Xyvora <person@example.com> or https://Example.com/Brevalle")).toEqual(["Xyvora"]);
    expect(terms("ask 2026 or ### today")).toEqual([]);
    expect(terms("ask Brevalle2 about 4DGS and Q3")).toEqual([]);
    expect(terms("or write to Person@Example.com today")).toEqual([]);
  });

  /** Each term is one the backend takes: never a refused character, a short word or a long one. */
  test("every term is a valid dictionary word", () => {
    expect(terms("ask Al and Bo about Xy<vora today")).toEqual([]);
    expect(terms(`ask X${"y".repeat(config.dictionaryWordMaxChars)} today`)).toEqual([]);
    expect(terms("a Kaelthorne Drake note, from Brevalle Xyvora Labs")).toEqual(["Kaelthorne Drake", "Brevalle Xyvora Labs"]);
  });

  /** The most frequent first, then the earliest; none twice, whatever its case; all of them, however
   * many (#310: `dictationVocabulary` takes as many as it has room for). */
  test("the most frequent first, distinct, and all of them", () => {
    const text = "ask Brevalle and Xyvora. then Xyvora again, and XYVORA, and Kaelthorne";
    expect(terms(text)).toEqual(["Xyvora", "Brevalle", "Kaelthorne"]);
    const letters = (index: number) => [index % 26, Math.floor(index / 26) % 26, Math.floor(index / 676)].map((digit) => String.fromCharCode(97 + digit)).join("");
    const names = Array.from({ length: config.cleanupScreenMaxTerms + config.dictionaryMaxEntries }, (_, index) => `Brevalle${letters(index)}`);
    expect(terms(`ask ${names.join(", ")}`)).toEqual(names);
  });

  /** A script without case marks no name, so its words not in a dictionary are terms, each alone. */
  test("a word in a script without case is a term unless a dictionary knows it, and stands alone", () => {
    expect(terms("회의는 내일 Brevalle 에서")).toEqual(["회의는", "Brevalle"]);
    expect(contextTerms("회의는 오늘밤 서윤아", new Set())).toEqual(["회의는", "오늘밤", "서윤아"]);
    // As in any script, a word shorter than `correctionMinWordLength` is not a term.
    expect(contextTerms("회의는 오늘", new Set())).toEqual(["회의는"]);
  });

  /** What a word is asked for comes from the same rules, each once. */
  test("the candidates asked about are every word that may be a term, each once", () => {
    expect(termCandidates("Today Xyvora said today, Xyvora 4DGS and 회의 at Person@Example.com\u0085Drake")).toEqual(["Today", "Xyvora", "회의", "Drake"]);
  });

  /** A word nobody answered for is not known: with no answer at all every candidate is a term. */
  test("a word missing from the answer is a term", () => {
    expect(contextTerms("Today Xyvora", new Set())).toEqual(["Today Xyvora"]);
  });
});

/** With no spelling dictionary for the user's languages (amended 2026-11-05: a dictionary that knows a
 * word in no language serves none), terms are picked as before the dictionaries: by capital letters,
 * a sentence's first word left out, and the everyday-word list. */
describe("contextTerms with no spelling dictionary", () => {
  const terms = (text: string) => contextTerms(text, null);


  test("picks names and terms, not everyday words", () => {
    expect(terms("I spoke with Xyvora about the launch plan.")).toEqual(["Xyvora"]);
    expect(terms("the brevalle report is late")).toEqual([]);
  });

  /** A capital at a sentence's start is the sentence's, not a name's; after `.`, `!` or `?`, or at a
   * line's start, a new sentence starts. */
  test("a capital starting a sentence is not a term", () => {
    expect(terms("Tomorrow works. Friday works too? Maybe ask Xyvora.")).toEqual(["Xyvora"]);
    expect(terms("Tomorrow works\nFriday too")).toEqual([]);
    expect(terms("Tomorrow works\u2028Friday too")).toEqual([]);
    expect(terms('It works." Friday too')).toEqual([]);
    // A bullet or a dash is not a word: the sentence still starts after it.
    expect(terms("- Review the launch\n• Tomorrow we ship\nDone. — Monday works")).toEqual([]);
  });

  /** A capital inside a word marks a term wherever it is: "TabMail", "OKR", "iOS". */
  test("a capital inside a word is a term anywhere", () => {
    expect(terms("TabMail ships the OKR list for iOS.")).toEqual(["TabMail", "OKR", "iOS"]);
  });

  /** Names of more than one word are kept together, up to a dictionary word's length; punctuation
   * between them splits them; a longer run of capitals is a heading, its words counted alone. */
  test("runs of capitals are kept together", () => {
    expect(terms("From: Kaelthorne Drake")).toEqual(["Kaelthorne Drake"]);
    expect(terms("I met Kaelthorne, Drake and Xyvora.")).toEqual(["Kaelthorne", "Drake", "Xyvora"]);
    expect(terms("Thanks Xyvora [Brevalle Labs] shipped it")).toEqual(["Xyvora", "Brevalle Labs"]);
    expect(terms("met Xyvora (Brevalle Labs) and cc Kaelthorne \"Drake\" today")).toEqual(["Xyvora", "Brevalle Labs", "Kaelthorne", "Drake"]);
    expect(terms("see Brevalle Xyvora Labs Kaelthorne Drake Quill")).toEqual(["Brevalle Xyvora Labs Kaelthorne Drake Quill"]);
    const heading = terms("see the Quarterly Planning Review Notes Brevalle Engineering Staff");
    expect(heading).toContain("Brevalle");
    expect(heading).toContain("Quarterly");
    expect(heading.some((term) => term.includes(" "))).toBe(false);
  });

  test("everyday words and addresses are not terms", () => {
    expect(terms("and then The report came")).toEqual([]);
    expect(terms("write to Xyvora <person@example.com> or https://Example.com/Brevalle")).toEqual(["Xyvora"]);
    expect(terms("ask 2026 or ### today")).toEqual([]);
    expect(terms("or write to Person@Example.com today")).toEqual([]);
  });

  /** Each term is one the backend takes: never a refused character, a short word or a long one. */
  test("every term is a valid dictionary word", () => {
    expect(terms("ask Al and Bo about Xy<vora today")).toEqual([]);
    expect(terms(`ask X${"y".repeat(config.dictionaryWordMaxChars)} today`)).toEqual([]);
    expect(terms("a Kaelthorne Drake note, from Brevalle Xyvora Labs")).toEqual(["Kaelthorne Drake", "Brevalle Xyvora Labs"]);
  });

  /** The most frequent first, then the earliest; none twice, whatever its case; all of them, however
   * many (#310: `dictationVocabulary` takes as many as it has room for). */
  test("the most frequent first, distinct, and all of them", () => {
    const text = "ask Brevalle and Xyvora. then Xyvora again, and XYVORA, and Kaelthorne";
    expect(terms(text)).toEqual(["Xyvora", "Brevalle", "Kaelthorne"]);
    const names = Array.from({ length: config.cleanupScreenMaxTerms + config.dictionaryMaxEntries }, (_, index) => `Brevalle${index}`);
    expect(terms(`ask ${names.join(", ")}`)).toEqual(names);
  });

  test("picks in any script", () => {
    expect(terms("회의는 내일 Brevalle 에서")).toEqual(["Brevalle"]);
    expect(terms("회의는 내일")).toEqual([]);
  });

  /** The rule's known blind spot, the reason for the dictionaries (#333), kept where they're missing. */
  test("a name starting a line is left out, and no word in a script without case is a term", () => {
    expect(terms("Xyvora Brevalle said hi\nthanks Kaelthorne")).toEqual(["Brevalle", "Kaelthorne"]);
    expect(terms("회의는 오늘밤 서윤아")).toEqual([]);
  });
});
