// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Entry } from "@napi-rs/keyring";
import { type SessionStore, sessionFromWire, sessionToWire, type TabMailSession } from "../core/account.js";
import * as config from "../core/config.js";
import { errorName, log } from "../core/log.js";

/** Shown when the credential store refuses to keep a sign-in. */
export const saveFailedMessage = "Couldn't save your sign-in in the system's credential store. Try again.";

/** Shown when a sign-out could not remove the saved sign-in (owner, 2026-09-27: sign out, and say so). */
export const savedSignInKeptMessage = "Signed out, but your saved sign-in couldn't be removed from the system's credential store. It may come back when TabMail Voice next opens.";

/** The signed-in session in the system's credential store (the macOS Keychain, the Windows
 * Credential Manager, the Secret Service on Linux), as GoTrue's JSON. Tests use
 * `InMemorySessionStore` and never touch it. */
export class KeychainSessionStore implements SessionStore {
  private readonly entry = new Entry(config.keychainService, config.keychainAccount);

  load(): TabMailSession | null {
    try {
      const stored = this.entry.getPassword();
      return stored ? sessionFromWire(JSON.parse(stored)) : null;
    } catch (error) {
      log.error(`KeychainSessionStore: load failed: ${errorName(error)}`);
      return null;
    }
  }

  /** Throws when the store refuses it: the account then stays as it was. */
  save(session: TabMailSession): void {
    try {
      this.entry.setPassword(JSON.stringify(sessionToWire(session)));
    } catch (error) {
      log.error(`KeychainSessionStore: save failed: ${errorName(error)}`);
      throw new Error(saveFailedMessage, { cause: error });
    }
  }

  /** Throws, saying so in the app's words, when the store refuses it (a missing entry is no failure). */
  clear(): void {
    try {
      this.entry.deletePassword();
    } catch (error) {
      log.error(`KeychainSessionStore: clear failed: ${errorName(error)}`);
      throw new Error(savedSignInKeptMessage, { cause: error });
    }
  }
}
