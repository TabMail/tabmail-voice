// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test, vi } from "vitest";
import { wordFrequenciesTimeout } from "../../../src/core/config.js";
import type { HelperClient } from "../../../src/main/native/helperClient.js";
import { NativeWordFrequencies } from "../../../src/main/native/wordFrequencies.js";

/** The screen terms' test (ADR-DESK-038, amended 2026-11-05): the main helper answers from the word
 * list the app ships. */
describe("NativeWordFrequencies", () => {
  const folder = "/Applications/TabMail Voice.app/Contents/Resources/dictionary";
  const lists = (request: ReturnType<typeof vi.fn>) => new NativeWordFrequencies({ request } as Pick<HelperClient, "request">, folder);

  test("asks the main helper with the list's folder and the words", async () => {
    const request = vi.fn().mockResolvedValue({ zipf: [0] });
    const words = lists(request);
    await words.frequencies(["Xyvora"]);
    await words.frequencies(["회의"]);
    expect(request.mock.calls).toEqual([
      ["wordFrequencies", { folder, words: ["Xyvora"] }, wordFrequenciesTimeout],
      ["wordFrequencies", { folder, words: ["회의"] }, wordFrequenciesTimeout],
    ]);
  });

  test("asks for each word once, as given, and answers each by it", async () => {
    const request = vi.fn().mockResolvedValue({ zipf: [56, 56, 0, null] });
    expect(await lists(request).frequencies(["Today", "today", "Today", "Xyvora", "สวัสดี"])).toEqual(new Map([["Today", 56], ["today", 56], ["Xyvora", 0], ["สวัสดี", null]]));
    expect(request).toHaveBeenCalledExactlyOnceWith("wordFrequencies", { folder, words: ["Today", "today", "Xyvora", "สวัสดี"] }, wordFrequenciesTimeout);
  });

  test("a reply out of shape fails the ask", async () => {
    for (const reply of [null, "56", {}, { zipf: "56" }, { zipf: [] }, { zipf: [56, 0] }, { zipf: [-1] }, { zipf: [5.5] }, { zipf: ["56"] }, { zipf: [undefined] }]) {
      await expect(lists(vi.fn().mockResolvedValue(reply)).frequencies(["Today"])).rejects.toThrow("Invalid wordFrequencies reply.");
    }
  });

  test("a helper failure fails the ask", async () => {
    await expect(lists(vi.fn().mockRejectedValue(new Error("exited"))).frequencies(["Today"])).rejects.toThrow("exited");
  });

  test("warming up asks for no words, so the helper starts reading the list, and never throws", async () => {
    const request = vi.fn().mockResolvedValue({ zipf: [] });
    lists(request).warmUp();
    const failing = vi.fn().mockRejectedValue(new Error("exited"));
    lists(failing).warmUp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledExactlyOnceWith("wordFrequencies", { folder, words: [] }, wordFrequenciesTimeout));
    await vi.waitFor(() => expect(failing).toHaveBeenCalledOnce());
  });
});
