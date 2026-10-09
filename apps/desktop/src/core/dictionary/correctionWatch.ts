// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import type { ScreenExclusions } from "../dictation/excludedSites.js";
import { learnedCorrections } from "./corrections.js";
import { errorName, log } from "../log.js";
import { sleep } from "../util/timeout.js";

/** The shared core's own breaks between a terminal's rows (U+2029): a terminal's field is the box around
 * its cursor, and a row ending at one may be one the terminal wrapped. */
const rowBreak = "\u2029";

/** The ways a field may hold the pasted text, in order: as read; with the rows a terminal wrapped
 * inside a word joined (its breaks dropped); and with the rows a program wrapped at its words joined
 * by a space (each break and the blanks around it, as a full-screen program indents its next row).
 * Only the core's breaks are joined, never the user's own line breaks. (The core checked its text for
 * secrets with its breaks and with them dropped; the text joined by spaces stays on this computer,
 * and only the words learned reach the debug log.) */
const joins: ((field: string) => string)[] = [
  (field) => field,
  (field) => field.replaceAll(rowBreak, ""),
  (field) => field.replace(/[^\S\u2029]*\u2029[^\S\u2029]*/gu, " "),
];

/** The focused field's reader (voice-field-reader, ADR-DESK-053). */
export interface FieldSource {
  /** The text of the focused field of `target`, the app or window a dictation was pasted into, as the
   * main helper named it at key-down (`DictationController`'s `targetApp`); null when there is none to
   * read (a password field, one too long, no field, on Windows and Linux `target` no longer in front,
   * or an app or website among `exclusions`, which is never read). */
  value(target: number, exclusions: ScreenExclusions): Promise<string | null>;
}

/**
 * Watches the field a dictation was pasted into and learns the user's corrections of it
 * (ADR-DESK-038): `target`, the app or window the paste went to and was checked against, never
 * whatever is in front after it (a window the user switched to in that moment may show the same
 * words). Every `interval` for `duration`, it reads that one's field: the first
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
    private readonly field: FieldSource,
    /** Adds the words to the dictionary. */
    private readonly learn: (words: string[]) => void,
    private readonly interval = config.correctionPollInterval,
    private readonly duration = config.correctionWatchDuration,
  ) {}

  /** Watches `target`, the app or window into which `pasted` was just pasted, unless it or the website
   * the field is on is among `exclusions`, what was excluded from screen reading as the dictation
   * started. */
  watch(target: number, pasted: string, exclusions: ScreenExclusions): void {
    this.stop();
    void this.run(this.generation, target, pasted, exclusions);
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

  private async run(generation: number, target: number, pasted: string, exclusions: ScreenExclusions): Promise<void> {
    const isCurrent = () => this.generation === generation;
    let before: string | null = null;
    let previous: string | null = null;
    // How the field holds the pasted text, found with it, and every later read joined the same way.
    let join = joins[0]!;
    for (let elapsed = this.interval; elapsed <= this.duration; elapsed += this.interval) {
      await sleep(this.interval);
      if (!isCurrent()) return;
      const read = await this.field.value(target, exclusions).catch((error: unknown) => {
        log.debug(`CorrectionWatch: read failed: ${errorName(error)}`);
        return null;
      });
      if (!isCurrent()) return;
      if (read === null) {
        log.debug("CorrectionWatch: no field to read; stopped");
        this.stop();
        return;
      }
      if (before === null) {
        const found = joins.findIndex((candidate) => candidate(read).includes(pasted));
        if (found !== -1) {
          join = joins[found]!;
          before = join(read);
          log.debug(`CorrectionWatch: found the pasted text in the field${found === 0 ? "" : ", its wrapped rows joined"}`);
        }
        previous = join(read);
        continue;
      }
      const field = join(read);
      // A read that respells something new, or has the pasted text back as it was (an undo), replaces
      // the correction pending: with what it teaches once the field has held since the last read, with
      // nothing while it is still changing, so a spelling paused on and then changed is never learned.
      // A read that respells nothing (the message sent and the field emptied, focus moved on, a word
      // half retyped) leaves it.
      // A terminal rewraps its rows after an edit that changes a word's length, so the join found
      // with the pasted text can run two words together, or split one, in a later read: while the
      // field has rows, only a word read whole on one of them is learned.
      const words = learnedCorrections(pasted, before, field).filter((word) => !read.includes(rowBreak) || read.includes(word));
      if ((words.length > 0 || field.includes(pasted)) && words.join("\n") !== this.pending.join("\n")) {
        this.pending = field === previous ? words : [];
      }
      previous = field;
    }
    log.debug("CorrectionWatch: watch over");
    this.stop();
  }
}
