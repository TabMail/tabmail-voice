// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { dictationVocabulary } from "../../../src/core/dictionary/vocabulary.js";

const words = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

/** The terms a dictation sends (ADR-DESK-038, #309): the first 100, which a speech model heeds, in
 * shares (screen up to 30, typed at most 50 of the dictionary's room, learned the rest), passing on
 * room a group can't fill; then, for the cleanup only, the rest up to 200. */
describe("dictationVocabulary", () => {
  test("the numbers are the owner's", () => {
    expect([config.vocabularyModelMaxTerms, config.vocabularyScreenShare, config.vocabularyTypedShare, config.vocabularyMaxTerms]).toEqual([100, 30, 50, 200]);
  });

  /** 100 typed, 50 learned and 80 screen terms: 50 typed, 30 screen, 20 learned, in that order. */
  test("50 typed, 30 from the screen, 20 learned", () => {
    const [typed, learned, shown] = [words("Typed", 100), words("Learned", 50), words("Shown", 80)];
    expect(dictationVocabulary({ typed, learned }, shown, words("Window", 40), false)).toEqual([...typed.slice(0, 50), ...shown.slice(0, 30), ...learned.slice(0, 20)]);
  });

  /** No learned words: the typed take the whole dictionary room, 70 beside 30 from the screen. */
  test("70 typed, 30 from the screen", () => {
    const [typed, shown] = [words("Typed", 100), words("Shown", 80)];
    expect(dictationVocabulary({ typed, learned: [] }, shown, [], false)).toEqual([...typed.slice(0, 70), ...shown.slice(0, 30)]);
    // No typed words: the learned take it.
    const learned = words("Learned", 100);
    expect(dictationVocabulary({ typed: [], learned }, shown, [], false)).toEqual([...shown.slice(0, 30), ...learned.slice(0, 70)]);
  });

  /** No screen terms: up to 100 dictionary words, the typed at most 50 while the learned can fill the rest. */
  test("with no screen, up to 100 dictionary words", () => {
    const [typed, learned] = [words("Typed", 100), words("Learned", 100)];
    expect(dictationVocabulary({ typed, learned }, [], [], false)).toEqual([...typed.slice(0, 50), ...learned.slice(0, 50)]);
    expect(dictationVocabulary({ typed, learned: learned.slice(0, 10) }, [], [], false)).toEqual([...typed.slice(0, 90), ...learned.slice(0, 10)]);
    expect(dictationVocabulary({ typed: typed.slice(0, 5), learned }, [], [], false)).toEqual([...typed.slice(0, 5), ...learned.slice(0, 95)]);
  });

  /** Fewer screen terms than their share: the dictionary takes the room; a small dictionary leaves the
   * screen and then the whole window all they have room for. */
  test("room a group can't fill passes on", () => {
    const [typed, learned] = [words("Typed", 100), words("Learned", 100)];
    expect(dictationVocabulary({ typed, learned }, words("Shown", 10), [], false)).toEqual([...typed.slice(0, 50), ...words("Shown", 10), ...learned.slice(0, 40)]);
    const window = words("Window", 100);
    expect(dictationVocabulary({ typed: ["Typed"], learned: ["Learned"] }, words("Shown", 60), window, false)).toEqual(["Typed", ...words("Shown", 60), "Learned", ...window.slice(0, 38)]);
  });

  /** With the cleanup, the 100 come first exactly as without it, then the rest of the dictionary (typed,
   * then learned), the rest of the screen's terms and the whole window's, up to 200. */
  test("the cleanup gets the rest after the same first 100, up to 200", () => {
    const [typed, learned, shown, window] = [words("Typed", 100), words("Learned", 50), words("Shown", 80), words("Window", 40)];
    const without = dictationVocabulary({ typed, learned }, shown, window, false);
    const withCleanup = dictationVocabulary({ typed, learned }, shown, window, true);
    expect(without).toHaveLength(100);
    expect(withCleanup).toHaveLength(200);
    expect(withCleanup.slice(0, 100)).toEqual(without);
    expect(withCleanup.slice(100)).toEqual([...typed.slice(50), ...learned.slice(20), ...shown.slice(30, 50)]);
    // Under 200 in all: every term, the whole window's last.
    const small = dictationVocabulary({ typed: words("Typed", 60), learned: words("Learned", 10) }, words("Shown", 40), words("Window", 5), true);
    expect(small).toEqual([...words("Typed", 60), ...words("Shown", 30), ...words("Learned", 10), ...words("Shown", 40).slice(30), ...words("Window", 5)]);
  });

  /** A screen term that is a dictionary word, whatever its case, goes as the dictionary's (if it fits)
   * and counts nothing toward the screen's share. No term goes twice. */
  test("no term twice; a screen term that is a dictionary word goes as the dictionary's", () => {
    const typed = words("Typed", 100);
    const shown = ["XYVORA", "typed0", "Typed99", "Brevalle"];
    const sent = dictationVocabulary({ typed, learned: ["Xyvora"] }, shown, ["brevalle", "Quillon"], true);
    // One screen term (Brevalle) leaves 99 for the dictionary: 98 typed and the learned word.
    expect(sent).toEqual([...typed.slice(0, 98), "Brevalle", "Xyvora", "Typed98", "Typed99", "Quillon"]);
    expect(dictationVocabulary({ typed, learned: ["Xyvora"] }, shown, ["brevalle", "Quillon"], false)).toEqual(sent.slice(0, 100));
  });

  test("nothing to send sends nothing", () => {
    expect(dictationVocabulary({ typed: [], learned: [] }, [], [], true)).toEqual([]);
  });
});
