// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { wordFrequenciesTimeout } from "../../core/config.js";
import { errorName, log } from "../../core/log.js";
import type { WordFrequencies } from "../../core/dictionary/contextTerms.js";
import type { HelperClient } from "./helperClient.js";

/**
 * How often the words on screen are seen, answered by the main helper from the word list the app
 * ships (`wordFrequencies`, ADR-DESK-038 amended 2026-11-05): the screen terms' test. `folder` is the
 * list's absolute folder. Each word's answer is its Zipf in tenths (0 when the list doesn't have it),
 * or null when no language list is written in its script.
 */
export class NativeWordFrequencies {
  constructor(
    private readonly helper: Pick<HelperClient, "request">,
    private readonly folder: string,
  ) {}

  /** Each of `words`' answer, keyed by the word as given. */
  async frequencies(words: readonly string[]): Promise<WordFrequencies> {
    const asked = [...new Set(words)];
    const reply = await this.helper.request<unknown>("wordFrequencies", { folder: this.folder, words: asked }, wordFrequenciesTimeout);
    if (typeof reply !== "object" || reply === null || !("zipf" in reply) || !Array.isArray(reply.zipf) || reply.zipf.length !== asked.length
      || !reply.zipf.every((zipf) => zipf === null || (Number.isSafeInteger(zipf) && (zipf as number) >= 0))) throw new Error("Invalid wordFrequencies reply.");
    const answers: readonly (number | null)[] = reply.zipf;
    return new Map(asked.map((word, index) => [word, answers[index]!]));
  }

  /** Has the helper start reading the list, so the first dictation doesn't wait for it. */
  warmUp(): void {
    this.frequencies([]).then(
      () => log.debug("NativeWordFrequencies: word list ready"),
      (error: unknown) => log.debug(`NativeWordFrequencies: word list not ready (${errorName(error)})`),
    );
  }
}
