// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { knownWordsTimeout } from "../../core/config.js";
import { errorName, log } from "../../core/log.js";
import type { HelperClient } from "./helperClient.js";

/**
 * Which words are everyday words of the user's languages, answered by the main helper with the
 * system's spelling dictionaries (`knownWords`, ADR-DESK-038 amended 2026-11-04): the macOS and
 * Windows spell checkers, the Hunspell dictionaries installed on Linux. `languages()` are the
 * system's preferred languages, read at each ask. A word is known when its lowercase form is, so
 * "Today" starting a sentence is, and a name a dictionary keeps capitalized ("Paris") is not.
 */
export class NativeWordChecker {
  constructor(
    private readonly helper: Pick<HelperClient, "request">,
    private readonly languages: () => readonly string[],
    /** Told the languages no dictionary serves, at each answer. */
    private readonly onUnavailable: (languages: readonly string[]) => void = () => {},
  ) {}

  async known(words: readonly string[]): Promise<ReadonlySet<string>> {
    const lowercase = [...new Set(words.map((word) => word.toLowerCase()))];
    const reply = await this.helper.request<unknown>("knownWords", { languages: [...this.languages()], words: lowercase }, knownWordsTimeout);
    if (typeof reply !== "object" || reply === null || !("known" in reply) || !Array.isArray(reply.known) || !reply.known.every((word) => typeof word === "string")
      || !("unavailable" in reply) || !Array.isArray(reply.unavailable) || !reply.unavailable.every((language) => typeof language === "string")) throw new Error("Invalid knownWords reply.");
    const unavailable: readonly string[] = reply.unavailable;
    if (unavailable.length > 0) log.debug(() => `NativeWordChecker: ${unavailable.length} of the system's languages have no spelling dictionary`);
    this.onUnavailable(unavailable);
    const known = new Set(reply.known);
    return new Set(words.filter((word) => known.has(word.toLowerCase())));
  }

  /** Has the helper ready the dictionaries of the user's languages, so the first dictation doesn't wait for them. */
  warmUp(): void {
    this.known([]).then(
      () => log.debug("NativeWordChecker: dictionaries ready"),
      (error: unknown) => log.debug(`NativeWordChecker: dictionaries not ready (${errorName(error)})`),
    );
  }
}
