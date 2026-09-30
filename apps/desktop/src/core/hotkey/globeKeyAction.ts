// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { DictationHotkey } from "./hotkey.js";
import { type KeyValueStore, storedInteger } from "../util/keyValueStore.js";
import { errorName, log } from "../log.js";

/** The system's Globe-key setting, through the macOS helper (`globeRead`/`globeUpdate`, HIToolbox's
 * private `TISGetFnUsageType`/`TISUpdateFnUsageType`, what System Settings itself calls). */
export interface GlobeKeySystem {
  /** Null when this macOS no longer has the calls. */
  read(): Promise<number | null>;
  update(value: number): Promise<void>;
}

/** `AppleFnUsageType`'s Do Nothing. */
export const doNothing = 0;
/** The user's choice while the app holds the key at Do Nothing. Kept in the app's store so a run
 * that crashed is put right at the next launch. */
export const savedChoiceKey = "globeKeyActionBeforeFnHotkey";

/**
 * The Globe (fn) key's own action, Keyboard settings' "Press 🌐 key to". macOS runs it ahead of
 * every event tap, so a press of fn as the hotkey also switched the input source. While fn is the
 * hotkey the app sets it to Do Nothing, and puts the user's choice back when fn stops being the
 * hotkey or the app quits (ADR-DESK-031). Calls run one at a time, in the order made.
 */
export class GlobeKeyAction {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly system: GlobeKeySystem,
    private readonly store: KeyValueStore,
  ) {}

  /** At launch and whenever the hotkey changes. */
  hotkeyIs(hotkey: DictationHotkey): Promise<void> {
    return this.enqueue(() => (hotkey === "function" ? this.takeOver() : this.putBack()));
  }

  /** Puts the user's choice back, unless they picked another action since. At quit, too. */
  restore(): Promise<void> {
    return this.enqueue(() => this.putBack());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation).catch((error: unknown) => {
      log.error(`GlobeKeyAction: ${errorName(error)}`);
    });
    this.queue = next;
    return next;
  }

  private async putBack(): Promise<void> {
    const saved = storedInteger(this.store, savedChoiceKey);
    if (saved === null) return;
    const current = await this.system.read();
    if (current === doNothing) {
      await this.system.update(saved);
      log.debug(`GlobeKeyAction: Globe action restored to ${saved}`);
    } else if (current === null) {
      log.error("GlobeKeyAction: TISUpdateFnUsageType unavailable; the Globe action stays Do Nothing");
    } else {
      log.debug("GlobeKeyAction: the Globe action was changed meanwhile; leaving it");
    }
    // Forgotten only now, so a crash before the update still knows the way back.
    this.store.remove(savedChoiceKey);
  }

  private async takeOver(): Promise<void> {
    const current = await this.system.read();
    if (current === null) {
      log.error("GlobeKeyAction: TISUpdateFnUsageType unavailable; the Globe action stays on");
      return;
    }
    // Already Do Nothing: the user's own choice, or ours with their choice saved.
    if (current === doNothing) return;
    // Saved first, so a crash after the change still knows the way back.
    this.store.set(savedChoiceKey, current);
    await this.system.update(doNothing);
    log.debug(`GlobeKeyAction: Globe action ${current} set to Do Nothing while fn is the hotkey`);
  }
}
