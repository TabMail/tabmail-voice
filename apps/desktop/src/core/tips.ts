// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "./config.js";
import { type DictationHotkey, hotkeyNames } from "./hotkey.js";
import { type KeyValueStore, storedBool, storedInteger } from "./keyValueStore.js";

/** A tip the overlay shows by the listening pill (`hintCentre`). Most behave as TipKit tips do: a
 * tip shows until the user has done what it teaches, or has seen it `maxDisplays` times, and then
 * never again. Its words, display duration and display count are in the config (`tipDetails`).
 * - `switchMode`: Space switches between dictation and agent mode; shown as a hold starts listening.
 * - `doubleTap`: a double tap of the hotkey dictates without holding it; shown once a hold passes
 *   `config.doubleTapTipHoldDuration`.
 * - `handsFree`: how hands-free listening ends (tap the hotkey, or Escape); shown the whole time it
 *   listens, every time. Never learned: nothing marks it so. */
export type DictationTip = "switchMode" | "doubleTap" | "handsFree";

export const tipDetails: Record<DictationTip, config.TipSettings> = {
  switchMode: config.switchModeTip,
  doubleTap: config.doubleTapTip,
  handsFree: config.handsFreeTip,
};

/** One piece of a tip's line: words, or a key drawn as a keycap. */
export type TipPart = { words: string } | { key: string };

/** The tip's lines, a few words each, so the tooltip stays not much wider than the pill (owner,
 * 2026-09-26: "should be multi-line instead"), as the config writes them. */
export function tipLines(tip: DictationTip, hotkey: DictationHotkey): TipPart[][] {
  return tipDetails[tip].lines.map((line) => tipParts(line, hotkey));
}

/** A configured line's words and keycaps: `[space]` is a keycap, `[hotkey]` the dictation key's. */
export function tipParts(line: string, hotkey: DictationHotkey): TipPart[] {
  const parts: TipPart[] = [];
  const addWords = (words: string) => {
    const trimmed = words.trim();
    if (trimmed !== "") parts.push({ words: trimmed });
  };
  let rest = line;
  for (;;) {
    const open = rest.indexOf("[");
    const close = open < 0 ? -1 : rest.indexOf("]", open);
    if (close < 0) break;
    addWords(rest.slice(0, open));
    const key = rest.slice(open + 1, close);
    parts.push({ key: key === "hotkey" ? hotkeyNames[hotkey].keycap : key });
    rest = rest.slice(close + 1);
  }
  addWords(rest);
  return parts;
}

/** The key a tip names. */
export function tipKeycap(tip: DictationTip, hotkey: DictationHotkey): string | null {
  for (const part of tipLines(tip, hotkey).flat()) if ("key" in part) return part.key;
  return null;
}

/** Which tips have been shown how often, and which the user has learned, kept in the app's store. */
export class TipBook {
  constructor(private readonly store: KeyValueStore) {}

  /** Whether `tip` may still show. */
  isEligible(tip: DictationTip): boolean {
    if (storedBool(this.store, learnedKey(tip)) ?? false) return false;
    const { maxDisplays } = tipDetails[tip];
    return maxDisplays === null || this.displays(tip) < maxDisplays;
  }

  recordDisplay(tip: DictationTip): void {
    this.store.set(displaysKey(tip), this.displays(tip) + 1);
  }

  /** The user did what `tip` teaches: it never shows again. */
  markLearned(tip: DictationTip): void {
    this.store.set(learnedKey(tip), true);
  }

  private displays(tip: DictationTip): number {
    return storedInteger(this.store, displaysKey(tip)) ?? 0;
  }
}

function displaysKey(tip: DictationTip): string {
  return `tip.${tip}.displays`;
}

function learnedKey(tip: DictationTip): string {
  return `tip.${tip}.learned`;
}
