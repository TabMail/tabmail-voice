// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../src/core/config.js";
import { learnedCorrections } from "../src/core/corrections.js";

const pasted = "Please forward the Zivora contract to Keelthorn Draszek before Friday.";

/** The words learned when the user edits the pasted text, alone in its field, into `edited`. */
function learned(edited: string, before = pasted, original = pasted): string[] {
  return learnedCorrections(original, before, before.replace(original, edited));
}

/** What the user's edit of a pasted dictation teaches the dictionary (ADR-DESK-038): respellings
 * within the pasted text, nothing else. */
describe("learnedCorrections", () => {
  test("learns a respelled word", () => {
    expect(learned("Please forward the Xyvora contract to Keelthorn Draszek before Friday.")).toEqual(["Xyvora"]);
  });

  test("learns each respelling of one edit, once", () => {
    expect(learned("Please forward the Xyvora contract to Kaelthorne Draszek before Friday.")).toEqual(["Xyvora", "Kaelthorne"]);
    const twice = "Zivora met the team, and the team met Zivora.";
    expect(learnedCorrections(twice, twice, twice.replaceAll("Zivora", "Xyvora"))).toEqual(["Xyvora"]);
  });

  /** A name heard as two words, or two words heard as one, is learned whole. */
  test("learns a respelling across words", () => {
    expect(learnedCorrections("Sync the tab mail inbox.", "Sync the tab mail inbox.", "Sync the TabMail inbox.")).toEqual(["TabMail"]);
    expect(learnedCorrections("Ask Kaelthornedraszek today.", "Ask Kaelthornedraszek today.", "Ask Kaelthorne Draszek today.")).toEqual(["Kaelthorne Draszek"]);
  });

  test("the punctuation around a word is not part of it", () => {
    expect(learnedCorrections("Meet Zivora.", "Meet Zivora.", "Meet Xyvora!")).toEqual(["Xyvora"]);
    expect(learnedCorrections("Meet (Zivora)", "Meet (Zivora)", "Meet (Xyvora)")).toEqual(["Xyvora"]);
  });

  /** The field holds other text too: an edit of the pasted part counts, one elsewhere doesn't. */
  test("only an edit within the pasted text counts", () => {
    const field = `Earlier text about Zivora.\n${pasted}\nSigned, Zivora`;
    expect(learned("Please forward the Xyvora contract to Keelthorn Draszek before Friday.", field)).toEqual(["Xyvora"]);
    expect(learnedCorrections(pasted, field, field.replace("Earlier text about Zivora", "Earlier text about Xyvora"))).toEqual([]);
    expect(learnedCorrections(pasted, field, field.replace("Signed, Zivora", "Signed, Xyvora"))).toEqual([]);
  });

  /** Of two copies of the pasted text, the one the edit is in. */
  test("finds the copy of the pasted text that was edited", () => {
    const text = "Meet Zivora.";
    const field = `${text} ${text}`;
    expect(learnedCorrections(text, field, `${text} Meet Xyvora.`)).toEqual(["Xyvora"]);
  });

  test("an edit reaching outside the pasted text teaches nothing", () => {
    const field = `Intro. ${pasted} Outro.`;
    expect(learnedCorrections(pasted, field, field.replace("Intro. Please", "Hello. Kindly").replace("Zivora", "Xyvora"))).toEqual([]);
  });

  test("text added after the paste, or words deleted, teach nothing", () => {
    expect(learnedCorrections(pasted, pasted, `${pasted} Thanks, Xyvora`)).toEqual([]);
    expect(learned("Please forward the contract to Keelthorn Draszek before Friday.")).toEqual([]);
  });

  test("no edit, or no pasted text in the field, teaches nothing", () => {
    expect(learnedCorrections(pasted, pasted, pasted)).toEqual([]);
    expect(learnedCorrections(pasted, "Something else entirely.", "Something else, Xyvora.")).toEqual([]);
    expect(learnedCorrections("", "Meet Zivora.", "Meet Xyvora.")).toEqual([]);
  });

  /** More than `config.correctionMaxChangedShare` of the words changed: a rewrite, not a correction. */
  test("a rewrite teaches nothing", () => {
    const text = "Zivora and Keelthorn sent Draszek notes";
    expect(learnedCorrections(text, text, "Xyvora and Kaelthorne sent Draszek notes")).toEqual(["Xyvora", "Kaelthorne"]);
    expect(learnedCorrections(text, text, "Xyvora und Kaelthorne sendet Draszek notes")).toEqual([]);
    expect(config.correctionMaxChangedShare).toBe(0.5);
  });

  /** Past `config.correctionMaxEditShare` of the longer spelling, it's another word, not a respelling. */
  test("a different word teaches nothing", () => {
    expect(learnedCorrections("Meet Zivora today.", "Meet Zivora today.", "Meet Bartholomew today.")).toEqual([]);
    // "Shunade" → "Sinead": 4 edits of 7, within the share.
    expect(learnedCorrections("Ask Shunade today.", "Ask Shunade today.", "Ask Sinead today.")).toEqual(["Sinead"]);
    // At the share exactly, 13 edits of 20, a respelling; one more, another word.
    const [heard, at, past] = ["Abcdefghijklmnopqrst", "Àáâãäåæçèéêëìnopqrst", "Àáâãäåæçèéêëìíopqrst"];
    expect(learnedCorrections(`Ask ${heard} today.`, `Ask ${heard} today.`, `Ask ${at} today.`)).toEqual([at]);
    expect(learnedCorrections(`Ask ${heard} today.`, `Ask ${heard} today.`, `Ask ${past} today.`)).toEqual([]);
  });

  test("short and everyday words are not learned", () => {
    expect(learnedCorrections("Ask Al today.", "Ask Al today.", "Ask Ai today.")).toEqual([]);
    expect(learnedCorrections("Better then ever.", "Better then ever.", "Better than ever.")).toEqual([]);
    // Capitalised, so not taken for another form of a lowercase word: only its being everyday refuses it.
    expect(learnedCorrections("Wood you send it?", "Wood you send it?", "Would you send it?")).toEqual([]);
  });

  /** A lowercase word changed at its end alone is another form of it, a grammar or wording fix; a
   * capitalised name changed there, or a word in a script without case, is a respelling. */
  test("another form of a lowercase word is not learned", () => {
    const forms: [string, string][] = [["report", "reports"], ["call", "called"], ["meeting", "meetings"], ["review", "revise"], ["send", "sent"], ["reports", "report"], ["file", "fire"]];
    for (const [heard, corrected] of forms) {
      const text = `Please ${heard} it today.`;
      expect(learnedCorrections(text, text, text.replace(heard, corrected)), `${heard} → ${corrected}`).toEqual([]);
    }
    expect(learnedCorrections("Ask Steven today.", "Ask Steven today.", "Ask Stephen today.")).toEqual(["Stephen"]);
    expect(learnedCorrections("Ask brevale today.", "Ask brevale today.", "Ask Brevalle today.")).toEqual(["Brevalle"]);
    expect(learnedCorrections("내일 김민수 회의", "내일 김민수 회의", "내일 김민서 회의")).toEqual(["김민서"]);
    // A change within the start is a respelling, lowercase or not.
    expect(learnedCorrections("run cubectl today", "run cubectl today", "run kubectl today")).toEqual(["kubectl"]);
  });

  /** A capital at a word's start alone is a sentence's or a style's, not a spelling; one inside a word,
   * or a changed spacing, is. */
  test("a change of case is learned only inside a word", () => {
    expect(learnedCorrections("meet zivora today", "meet zivora today", "meet Zivora today")).toEqual([]);
    expect(learnedCorrections("sync with tabmail", "sync with tabmail", "sync with TabMail")).toEqual(["TabMail"]);
  });

  test("a word the backend would refuse is not learned", () => {
    expect(learnedCorrections("Meet Zivora today.", "Meet Zivora today.", "Meet Xyv<ora today.")).toEqual([]);
    const long = "x".repeat(config.dictionaryWordMaxChars);
    expect(learnedCorrections(`Meet X${long}y today.`, `Meet X${long}y today.`, `Meet X${long}z today.`)).toEqual([]);
  });

  test("a respelling of more words than a dictionary word holds is not learned", () => {
    const heard = "a1 b2 c3 d4 e5 f6 g7";
    const text = `${heard} ${"word ".repeat(20)}`;
    expect(learnedCorrections(text, text, text.replace(heard, "A1x B2x C3x D4x E5x F6x G7x"))).toEqual([]);
  });

  /** Hangul and other scripts: the words are split on spaces alike. */
  test("learns in any script", () => {
    expect(learnedCorrections("내일 테브메일 회의", "내일 테브메일 회의", "내일 탭메일 회의")).toEqual(["탭메일"]);
  });
});
