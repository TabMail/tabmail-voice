// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../src/core/config.js";
import { contextTerms } from "../src/core/contextTerms.js";

/** The names and terms picked from the screen read at key-down (ADR-DESK-038), sent with a dictation
 * beside the user's dictionary. */
describe("contextTerms", () => {
  const terms = (text: string, excluding: string[] = [], max = config.contextTermsMax) => contextTerms(text, excluding, max);

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

  /** The most frequent first, then the earliest; none twice, whatever its case; none already in the
   * user's dictionary; at most `max`. */
  test("the most frequent first, distinct, and capped", () => {
    const text = "ask Brevalle and Xyvora. then Xyvora again, and XYVORA, and Kaelthorne";
    expect(terms(text)).toEqual(["Xyvora", "Brevalle", "Kaelthorne"]);
    expect(terms(text, ["xyvora"])).toEqual(["Brevalle", "Kaelthorne"]);
    expect(terms(text, [], 1)).toEqual(["Xyvora"]);
    expect(config.contextTermsMax).toBe(100);
  });

  test("picks in any script", () => {
    expect(terms("회의는 내일 Brevalle 에서")).toEqual(["Brevalle"]);
    expect(terms("회의는 내일")).toEqual([]);
  });
});
