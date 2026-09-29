// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "./config.js";
import { learnedCorrections } from "./corrections.js";
import { errorName, log } from "./log.js";
import { sleep } from "./timeout.js";

/**
 * Watches the field a dictation was pasted into and learns the user's corrections of it
 * (ADR-DESK-038). Every `interval` for `duration`, it reads the field of the app pasted into: the first
 * read holding the pasted text is the field before any edit; after that, each change that stays for
 * one interval is compared with it (`learnedCorrections`). One watch at a time: a new one, or `stop`
 * (the next dictation's key-down), ends the last; so does a field it can't read. The field's text
 * stays on this computer, in the debug log only.
 */
export class CorrectionWatch {
  private generation = 0;

  constructor(
    /** The text of the focused field of the app `pid`; null when there is none to read (a password
     * field, one too long, or no field). */
    private readonly readField: (pid: number) => Promise<string | null>,
    /** Adds the words to the dictionary. */
    private readonly learn: (words: string[]) => void,
    private readonly interval = config.correctionPollInterval,
    private readonly duration = config.correctionWatchDuration,
  ) {}

  /** Watches the app `pid`, into which `pasted` was just pasted. */
  watch(pid: number, pasted: string): void {
    this.generation += 1;
    void this.run(this.generation, pid, pasted);
  }

  stop(): void {
    this.generation += 1;
  }

  private async run(generation: number, pid: number, pasted: string): Promise<void> {
    const isCurrent = () => this.generation === generation;
    let before: string | null = null;
    let previous: string | null = null;
    let compared: string | null = null;
    for (let elapsed = this.interval; elapsed <= this.duration; elapsed += this.interval) {
      await sleep(this.interval);
      if (!isCurrent()) return;
      const field = await this.readField(pid).catch((error: unknown) => {
        log.debug(`CorrectionWatch: read failed: ${errorName(error)}`);
        return null;
      });
      if (!isCurrent()) return;
      if (field === null) {
        log.debug("CorrectionWatch: no field to read; stopped");
        return;
      }
      if (before === null) {
        if (field.includes(pasted)) {
          before = field;
          compared = field;
          log.debug("CorrectionWatch: found the pasted text in the field");
        }
      } else if (field === previous && field !== compared) {
        compared = field;
        const words = learnedCorrections(pasted, before, field);
        log.debug(`CorrectionWatch: an edit settled; ${words.length} word(s) to learn`);
        if (words.length > 0) {
          log.content("CorrectionWatch: learned", words.join(", "));
          this.learn(words);
        }
      }
      previous = field;
    }
    log.debug("CorrectionWatch: watch over");
  }
}
