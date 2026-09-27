// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "./config.js";
import { type DictationHotkey, hotkeyNames } from "./hotkey.js";
import { type KeyValueStore, storedBool, storedInteger } from "./keyValueStore.js";

/** A tip the overlay shows under the listening pill, as TipKit tips behave: it shows until the user
 * has done what it teaches, or has seen it `maxDisplays` times, and then never again.
 * - `switchMode`: Space switches between dictation and agent mode; shown as a hold starts listening.
 * - `doubleTap`: a double tap of the hotkey dictates without holding it; shown once a hold passes
 *   `config.doubleTapTipHoldDuration`. */
export type DictationTip = "switchMode" | "doubleTap";

export const tipDetails: Record<DictationTip, { maxDisplays: number; displayDuration: number }> = {
  switchMode: { maxDisplays: config.switchModeTipMaxDisplays, displayDuration: config.switchModeTipDisplayDuration },
  doubleTap: { maxDisplays: config.doubleTapTipMaxDisplays, displayDuration: config.doubleTapTipDisplayDuration },
};

/** One piece of a tip's line: words, or a key drawn as a keycap. */
export type TipPart = { words: string } | { key: string };

/** The tip's lines, a few words each, so the tooltip stays not much wider than the pill (owner,
 * 2026-09-26: "should be multi-line instead"). The double-tap tip names the key held to dictate. */
export function tipLines(tip: DictationTip, hotkey: DictationHotkey): TipPart[][] {
  switch (tip) {
    case "switchMode":
      return [[{ words: "Press" }, { key: "space" }, { words: "to switch" }], [{ words: "between dictation" }], [{ words: "and agent mode" }]];
    case "doubleTap":
      return [[{ words: "Double-tap" }, { key: hotkeyNames[hotkey].keycap }], [{ words: "to dictate" }], [{ words: "without holding" }]];
  }
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
    return !(storedBool(this.store, learnedKey(tip)) ?? false) && this.displays(tip) < tipDetails[tip].maxDisplays;
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
