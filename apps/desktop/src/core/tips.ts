// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "./config.js";
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
