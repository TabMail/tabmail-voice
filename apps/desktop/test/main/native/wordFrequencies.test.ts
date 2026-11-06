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

  /** A whole window's read can hold more words than the Windows and Linux main helpers take in one
   * request line (1 MiB): they go in several requests, each line under it, every word answered by
   * its own request's reply, whichever reply comes first (the helpers answer requests concurrently). */
  test("a screen's words too many for one request line are asked in several", async () => {
    const helperLineMaxBytes = 1024 * 1024;
    const syllable = (index: number) => String.fromCodePoint(0xac00 + (index % 11_172));
    const words = Array.from({ length: 120_000 }, (_, index) => `${syllable(Math.floor(index / 11_172))}${syllable(index)}${syllable(index * 7)}${syllable(index * 13)}`);
    const zipf = (word: string) => word.codePointAt(1)! % 100;
    const replies: { reply: () => void }[] = [];
    const request = vi.fn((_method: string, params: { words: string[] }) => new Promise((resolve) => {
      replies.push({ reply: () => resolve({ zipf: params.words.map(zipf) }) });
    }));
    const asked = lists(request).frequencies(words);
    expect(replies.length).toBeGreaterThan(1);
    for (const { reply } of replies.toReversed()) {
      reply();
      await Promise.resolve();
    }
    const answers = await asked;
    for (const [method, params] of request.mock.calls) {
      expect(Buffer.byteLength(`${JSON.stringify({ id: Number.MAX_SAFE_INTEGER, method, params })}\n`)).toBeLessThan(helperLineMaxBytes);
    }
    expect(request.mock.calls.flatMap(([, params]) => params.words)).toEqual([...new Set(words)]);
    expect(answers).toEqual(new Map(words.map((word) => [word, zipf(word)])));
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
