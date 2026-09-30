// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { AccountModel, AuthClient } from "../../../src/core/backend/account.js";
import { KeychainSessionStore, saveFailedMessage, savedSignInKeptMessage } from "../../../src/main/storage/keychainSessionStore.js";
import { Fixtures, StubTransport } from "../../support/support.js";

/** The system's credential store, in memory: one item, and a switch each to refuse a write or a
 * delete. The real one is never touched. */
const credentials = vi.hoisted(() => ({ stored: null as string | null, refusesSave: false, refusesDelete: false }));
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    getPassword(): string | null {
      return credentials.stored;
    }
    setPassword(value: string): void {
      if (credentials.refusesSave) throw new Error("denied");
      credentials.stored = value;
    }
    deletePassword(): boolean {
      if (credentials.refusesDelete) throw new Error("denied");
      const had = credentials.stored !== null;
      credentials.stored = null;
      return had;
    }
  },
}));

beforeEach(() => {
  credentials.stored = null;
  credentials.refusesSave = false;
  credentials.refusesDelete = false;
});

function account(stub: StubTransport): AccountModel {
  return new AccountModel(new AuthClient(stub.transport, "https://auth.example.com", "pk"), new KeychainSessionStore());
}

function signInReply(): StubTransport {
  const stub = new StubTransport();
  stub.enqueue(200, Fixtures.sessionJSON({ access: "access-a", refresh: "refresh-a" }));
  return stub;
}

describe("KeychainSessionStore", () => {
  test("a sign-in is there at the next launch, and a sign-out is not", async () => {
    const model = account(signInReply());
    await model.verify(Fixtures.email, "123456");
    expect(new KeychainSessionStore().load()?.accessToken).toBe("access-a");

    expect(() => model.signOut()).not.toThrow();
    expect(new KeychainSessionStore().load()).toBeNull();
    expect(account(new StubTransport()).isSignedIn).toBe(false);
  });

  test("signing out with nothing stored is no failure", () => {
    expect(() => new KeychainSessionStore().clear()).not.toThrow();
  });

  /** A session the store refused would be gone at the next launch: the sign-in fails instead, saying
   * so in words, not the credential library's. */
  test("a sign-in the store refuses fails and signs nothing in", async () => {
    credentials.refusesSave = true;
    const model = account(signInReply());

    await expect(model.verify(Fixtures.email, "123456")).rejects.toThrow(new Error(saveFailedMessage));

    expect(model.isSignedIn).toBe(false);
    expect(new KeychainSessionStore().load()).toBeNull();
  });

  /** The app signs out all the same, and says, in the app's words (the Settings reply carries this
   * error's message), that the saved sign-in is still there, to come back at the next launch (owner,
   * 2026-09-27). */
  test("a sign-out the store refuses still signs out, and says the sign-in was kept", async () => {
    const model = account(signInReply());
    await model.verify(Fixtures.email, "123456");
    credentials.refusesDelete = true;

    expect(() => model.signOut()).toThrow(new Error(savedSignInKeptMessage));

    expect(model.isSignedIn).toBe(false);
    expect(await model.validToken()).toBeNull();
    expect(new KeychainSessionStore().load()?.accessToken).toBe("access-a");
  });
});
