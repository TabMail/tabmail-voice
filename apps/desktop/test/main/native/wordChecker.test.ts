// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test, vi } from "vitest";
import { knownWordsTimeout } from "../../../src/core/config.js";
import type { HelperClient } from "../../../src/main/native/helperClient.js";
import { NativeWordChecker } from "../../../src/main/native/wordChecker.js";

/** The screen terms' test (ADR-DESK-038, amended 2026-11-04): the main helper answers with the system's
 * spelling dictionaries for the system's preferred languages. */
describe("NativeWordChecker", () => {
  const checker = (request: ReturnType<typeof vi.fn>, languages = ["en-US", "ko-KR"]) => new NativeWordChecker({ request } as Pick<HelperClient, "request">, () => languages);

  test("asks the main helper with the languages preferred at the ask", async () => {
    const request = vi.fn().mockResolvedValue({ known: [], unavailable: [], dictionaries: 1 });
    const languages = ["en-US"];
    const words = new NativeWordChecker({ request } as Pick<HelperClient, "request">, () => languages);
    await words.known(["xyvora"]);
    languages.push("ko-KR");
    await words.known(["회의"]);
    expect(request.mock.calls).toEqual([
      ["knownWords", { languages: ["en-US"], words: ["xyvora"] }, knownWordsTimeout],
      ["knownWords", { languages: ["en-US", "ko-KR"], words: ["회의"] }, knownWordsTimeout],
    ]);
  });

  /** A dictionary has "today" and "Paris": a word is known by its lowercase form, so a sentence's
   * first word is and a name the dictionary keeps capitalized is not. */
  test("asks for each word's lowercase form once, and knows every word whose lowercase form is known", async () => {
    const request = vi.fn().mockResolvedValue({ known: ["today"], unavailable: [], dictionaries: 1 });
    expect(await checker(request).known(["Today", "TODAY", "today", "Paris", "Xyvora"])).toEqual(new Set(["Today", "TODAY", "today"]));
    expect(request).toHaveBeenCalledExactlyOnceWith("knownWords", { languages: ["en-US", "ko-KR"], words: ["today", "paris", "xyvora"] }, knownWordsTimeout);
  });

  test("a language without a dictionary still answers for the others", async () => {
    const request = vi.fn().mockResolvedValue({ known: ["회의"], unavailable: ["fi-FI"], dictionaries: 1 });
    expect(await checker(request, ["fi-FI", "ko-KR"]).known(["회의", "huomenna"])).toEqual(new Set(["회의"]));
  });

  /** The menu names a language without a dictionary from each answer (ADR-DESK-038). */
  test("tells the languages no dictionary serves at each answer, and nothing when the ask fails", async () => {
    const told: (readonly string[])[] = [];
    const request = vi.fn().mockResolvedValueOnce({ known: [], unavailable: ["ko-KR"], dictionaries: 1 }).mockResolvedValueOnce({ known: [], unavailable: [], dictionaries: 1 }).mockRejectedValueOnce(new Error("exited"));
    const words = new NativeWordChecker({ request } as Pick<HelperClient, "request">, () => ["en-US", "ko-KR"], (languages) => told.push(languages));
    await words.known(["Xyvora"]);
    await words.known(["Xyvora"]);
    await expect(words.known(["Xyvora"])).rejects.toThrow("exited");
    expect(told).toEqual([["ko-KR"], []]);
  });

  /** A dictionary that knows a word in no language serves none (amended 2026-11-05): with none of the
   * user's languages served, the answer says so, and the controller picks screen terms by capitals. */
  test("answers null when no dictionary serves the user's languages, still telling the menu which", async () => {
    const told: (readonly string[])[] = [];
    const request = vi.fn().mockResolvedValue({ known: [], unavailable: ["uk-UA"], dictionaries: 0 });
    const words = new NativeWordChecker({ request } as Pick<HelperClient, "request">, () => ["uk-UA"], (languages) => told.push(languages));
    expect(await words.known(["Xyvora"])).toBeNull();
    expect(told).toEqual([["uk-UA"]]);
  });

  test("a reply out of shape fails the ask", async () => {
    for (const reply of [null, "today", {}, { known: "today", unavailable: [] }, { known: [1], unavailable: [] }, { known: [] }, { known: [], unavailable: "fi" }, { known: [], unavailable: [1] }, { known: [], unavailable: [] },
    { known: [], unavailable: [], dictionaries: -1 }, { known: [], unavailable: [], dictionaries: 1.5 }, { known: [], unavailable: [], dictionaries: "1" }]) {
      await expect(checker(vi.fn().mockResolvedValue(reply)).known(["Today"])).rejects.toThrow("Invalid knownWords reply.");
    }
  });

  test("a helper failure fails the ask", async () => {
    await expect(checker(vi.fn().mockRejectedValue(new Error("exited"))).known(["Today"])).rejects.toThrow("exited");
  });

  test("warming up asks for no words, so the helper readies the dictionaries, and never throws", async () => {
    const request = vi.fn().mockResolvedValue({ known: [], unavailable: ["fi-FI"], dictionaries: 1 });
    checker(request).warmUp();
    const failing = vi.fn().mockRejectedValue(new Error("exited"));
    checker(failing).warmUp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledExactlyOnceWith("knownWords", { languages: ["en-US", "ko-KR"], words: [] }, knownWordsTimeout));
    await vi.waitFor(() => expect(failing).toHaveBeenCalledOnce());
  });
});
