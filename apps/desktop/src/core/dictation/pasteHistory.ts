// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { Observable } from "../util/observable.js";
import { trimWhitespace } from "../util/text.js";

/** A text dictation or agent mode pasted, or copied when it could not paste. `id` tells entries
 * apart while the list changes; `at` is when it came, in milliseconds since 1970. */
export interface PasteEntry {
  id: number;
  text: string;
  at: number;
}

/** The paste history a triple tap shows (ADR-DESK-043): the newest first, at most `limit`. Kept in
 * memory for the app's life and never saved: no user content goes to disk. */
export class PasteHistory extends Observable {
  private items: PasteEntry[] = [];
  private nextId = 1;

  constructor(
    private readonly limit = config.pasteHistoryLimit,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  get entries(): readonly PasteEntry[] {
    return this.items;
  }

  /** Adds `text` at the top; the same text again moves up rather than showing twice. Blank text is
   * nothing to keep. */
  add(text: string): void {
    if (trimWhitespace(text) === "") return;
    const kept = this.items.filter((entry) => entry.text !== text);
    this.items = [{ id: this.nextId++, text, at: this.now() }, ...kept].slice(0, this.limit);
    this.changed();
  }

  /** The entry `id`'s text; null once it has dropped off the end. */
  text(id: number): string | null {
    return this.items.find((entry) => entry.id === id)?.text ?? null;
  }
}

const minute = 60_000;
const hour = 60 * minute;

/** How long ago `at` was, as the history lists it: "just now", minutes, hours, else the time of day. */
export function pastedAgo(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < minute) return "just now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} min ago`;
  if (elapsed < 24 * hour) return `${Math.floor(elapsed / hour)} h ago`;
  return new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
