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
 * one interval is compared with it (`learnedCorrections`), and the words the last one teaches are
 * learned when the watch ends, not before, unless a later change teaches otherwise: a pause in the
 * middle of an edit ("tabmail" on the way to "TabMail", "Xyvor" on the way to "Xyvora") teaches
 * nothing, though the field is sent before its last spelling stays. One watch at a time: a new one, or
 * `stop` (the next dictation's key-down), ends the last; so do a field it can't read and the end of
 * `duration`. The field's text stays on this computer; only the words learned reach the debug log.
 */
export class CorrectionWatch {
  private generation = 0;
  /** What the current watch's last settled edit teaches, while no later one teaches otherwise. */
  private pending: string[] = [];

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
    this.stop();
    void this.run(this.generation, pid, pasted);
  }

  /** Ends the watch, learning what its last settled edit teaches. */
  stop(): void {
    this.generation += 1;
    const words = this.pending;
    this.pending = [];
    if (words.length === 0) return;
    log.debug(`CorrectionWatch: learning ${words.length} word(s)`);
    log.content("CorrectionWatch: learned", words.join(", "));
    this.learn(words);
  }

  private async run(generation: number, pid: number, pasted: string): Promise<void> {
    const isCurrent = () => this.generation === generation;
    let before: string | null = null;
    let previous: string | null = null;
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
        this.stop();
        return;
      }
      if (before === null) {
        if (field.includes(pasted)) {
          before = field;
          log.debug("CorrectionWatch: found the pasted text in the field");
        }
      } else {
        // A read that respells something new, or has the pasted text back as it was (an undo), replaces
        // the correction pending: with what it teaches once the field has held since the last read, with
        // nothing while it is still changing, so a spelling paused on and then changed is never learned.
        // A read that respells nothing (the message sent and the field emptied, focus moved on, a word
        // half retyped) leaves it.
        const words = learnedCorrections(pasted, before, field);
        if ((words.length > 0 || field.includes(pasted)) && words.join("\n") !== this.pending.join("\n")) {
          this.pending = field === previous ? words : [];
        }
      }
      previous = field;
    }
    log.debug("CorrectionWatch: watch over");
    this.stop();
  }
}
