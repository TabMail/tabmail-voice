// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { cleanupDictionary, dictationVocabulary } from "../../../src/core/dictionary/vocabulary.js";

const words = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

/** The terms a dictation sends (ADR-DESK-038, #309): the first 100, which a speech model heeds, in
 * shares (screen up to 30, typed at most 50 of the dictionary's room, learned the rest), passing on
 * room a group can't fill; then, for the cleanup only, the rest of the screen's and the whole window's
 * terms, up to 500 more of theirs, counted apart from those in the first 100 (#310; owner, 2026-10-29). */
describe("dictationVocabulary", () => {
  test("the numbers are the owner's", () => {
    expect([config.vocabularyModelMaxTerms, config.vocabularyScreenShare, config.vocabularyTypedShare, config.cleanupScreenMaxTerms, config.cleanupDictionaryMaxWords]).toEqual([100, 30, 50, 500, 500]);
    // Within the backend's limits (#310): 1,000 vocabulary terms, and a cleanup field of 30,000 code
    // units holding the cleanup's dictionary, one word of at most `dictionaryWordMaxChars` per line.
    expect(config.vocabularyModelMaxTerms + config.cleanupScreenMaxTerms).toBeLessThanOrEqual(1_000);
    expect(config.cleanupDictionaryMaxWords * (config.dictionaryWordMaxChars + 1) - 1).toBeLessThanOrEqual(config.cleanupFieldMaxLength);
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

  /** With the cleanup, the 100 come first exactly as without it, then the rest of the screen's terms
   * and the whole window's, up to 500 more (#310), those in the first 100 not counted (owner,
   * 2026-10-29). The dictionary's words past the first 100 are not sent: they go in the cleanup's own
   * dictionary. */
  test("the cleanup gets the rest of the screen after the same first 100, up to 500 more screen terms", () => {
    const [typed, learned, shown, window] = [words("Typed", 100), words("Learned", 50), words("Shown", 400), words("Window", 400)];
    const without = dictationVocabulary({ typed, learned }, shown, window, false);
    const withCleanup = dictationVocabulary({ typed, learned }, shown, window, true);
    expect(without).toHaveLength(100);
    expect(withCleanup.slice(0, 100)).toEqual(without);
    // 30 of the screen's terms in the first 100, then 500 more: the shown ones' rest, then the window's.
    expect(withCleanup.slice(100)).toEqual([...shown.slice(30), ...window.slice(0, 130)]);
    // Fewer than 500 more: every screen term, the whole window's last.
    const small = dictationVocabulary({ typed: words("Typed", 60), learned: words("Learned", 10) }, words("Shown", 40), words("Window", 5), true);
    expect(small).toEqual([...words("Typed", 60), ...words("Shown", 30), ...words("Learned", 10), ...words("Shown", 40).slice(30), ...words("Window", 5)]);
    // No screen: only the first 100 dictionary words go, as without the cleanup.
    expect(dictationVocabulary({ typed, learned }, [], [], true)).toEqual(dictationVocabulary({ typed, learned }, [], [], false));
  });

  /** The whole window's terms in the first 100 don't count toward the 500 either (owner, 2026-10-29). */
  test("the whole window's terms in the first 100 don't count toward the 500", () => {
    const window = words("Window", 700);
    const sent = dictationVocabulary({ typed: ["Typed"], learned: [] }, words("Shown", 10), window, true);
    // 89 of the window's in the first 100, then 500 more.
    expect(sent).toEqual(["Typed", ...words("Shown", 10), ...window.slice(0, 589)]);
  });

  /** A screen term that is a dictionary word, whatever its case, goes as the dictionary's (if it fits)
   * and counts nothing toward the screen's share. No term goes twice. */
  test("no term twice; a screen term that is a dictionary word goes as the dictionary's", () => {
    const typed = words("Typed", 100);
    const shown = ["XYVORA", "typed0", "Typed99", "Brevalle"];
    const sent = dictationVocabulary({ typed, learned: ["Xyvora"] }, shown, ["brevalle", "Quillon"], true);
    // One screen term (Brevalle) leaves 99 for the dictionary: 98 typed and the learned word. Then, for
    // the cleanup, the window's Quillon; the dictionary's words past the first 100 go to its own list.
    expect(sent).toEqual([...typed.slice(0, 98), "Brevalle", "Xyvora", "Quillon"]);
    expect(dictationVocabulary({ typed, learned: ["Xyvora"] }, shown, ["brevalle", "Quillon"], false)).toEqual(sent.slice(0, 100));
  });

  /** #310: the cleanup's dictionary holds only 500 of the user's words, so a word past them that is
   * on screen goes as a screen term, never in neither list; one among them goes as the dictionary's. */
  test("a dictionary word past the cleanup's 500 goes as a screen term", () => {
    const learned = words("Learned", config.cleanupDictionaryMaxWords + 100);
    const old = learned.at(-1)!;
    const sent = dictationVocabulary({ typed: [], learned }, ["Learned0", old], [], true);
    expect(sent).toEqual([old, ...learned.slice(0, config.vocabularyModelMaxTerms - 1)]);
    expect(cleanupDictionary({ typed: [], learned })).not.toContain(old);
    // The same first 100 without the cleanup, and the word just past the 500 too.
    expect(dictationVocabulary({ typed: [], learned }, ["Learned0", old], [], false)).toEqual(sent);
    const next = learned[config.cleanupDictionaryMaxWords]!;
    const last = learned[config.cleanupDictionaryMaxWords - 1]!;
    for (const cleans of [true, false]) {
      expect(dictationVocabulary({ typed: [], learned }, [last, next], [], cleans)).toEqual([next, ...learned.slice(0, config.vocabularyModelMaxTerms - 1)]);
    }
  });

  /** The cleanup's dictionary: the user's words, typed first, then learned, each in the order given
   * (most recently used first), at most 500. */
  test("the cleanup's dictionary is the first 500 words, typed first", () => {
    const [typed, learned] = [words("Typed", 100), words("Learned", 600)];
    expect(cleanupDictionary({ typed, learned })).toEqual([...typed, ...learned.slice(0, 400)]);
    expect(cleanupDictionary({ typed: ["Typed"], learned: ["Learned"] })).toEqual(["Typed", "Learned"]);
  });

  test("nothing to send sends nothing", () => {
    expect(dictationVocabulary({ typed: [], learned: [] }, [], [], true)).toEqual([]);
  });
});
