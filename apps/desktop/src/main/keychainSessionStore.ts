// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Entry } from "@napi-rs/keyring";
import { type SessionStore, sessionFromWire, sessionToWire, type TabMailSession } from "../core/account.js";
import * as config from "../core/config.js";
import { errorName, log } from "../core/log.js";

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
    this.entry.setPassword(JSON.stringify(sessionToWire(session)));
  }

  /** Throws when the store refuses it (a missing entry is no failure): the account then stays
   * signed in, rather than coming back at the next launch. */
  clear(): void {
    this.entry.deletePassword();
  }
}
