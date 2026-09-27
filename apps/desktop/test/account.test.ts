// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { AccountModel, AuthClient, AuthError } from "../src/core/account.js";
import * as config from "../src/core/config.js";
import { deferred, Fixtures, InMemorySessionStore, StubTransport } from "./support.js";

function client(stub: StubTransport, key = "pk"): AuthClient {
  return new AuthClient(stub.transport, "https://auth.example.com", key);
}

async function authError(promise: Promise<unknown>): Promise<AuthError | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  return undefined;
}

describe("AuthClient", () => {
  test("sendCode requests an email code for existing accounts only", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, {});

    await client(stub).sendCode(Fixtures.email);

    expect(stub.requests).toHaveLength(1);
    expect(new URL(stub.requests[0]?.url ?? "").pathname).toBe("/auth/v1/otp");
    expect(stub.requests[0]?.headers.apikey).toBe("pk");
    expect(stub.body(0)).toEqual({ email: Fixtures.email, create_user: false });
  });

  test("sendCode reports an unknown email", async () => {
    const stub = new StubTransport();
    stub.enqueue(422, { msg: "Signups not allowed for otp" });
    expect((await authError(client(stub).sendCode(Fixtures.email)))?.kind).toBe("emailNotRegistered");
  });

  test("verify returns the session", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.sessionJSON({ access: "a", refresh: "r" }));

    const session = await client(stub).verify(Fixtures.email, "123456");

    expect(session.accessToken).toBe("a");
    expect(session.userEmail).toBe(Fixtures.email);
    expect(stub.body(0).type).toBe("email");
    expect(stub.body(0).token).toBe("123456");
  });

  test("verify reports a wrong code", async () => {
    const stub = new StubTransport();
    stub.enqueue(403, { msg: "Token has expired or is invalid" });
    expect((await authError(client(stub).verify(Fixtures.email, "000000")))?.kind).toBe("invalidCode");
  });

  test("refresh rejects a session for a different user", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.sessionJSON({ access: "a2", refresh: "r2", userId: "someone-else" }));
    expect((await authError(client(stub).refresh(Fixtures.session())))?.kind).toBe("refreshRejected");
  });
});

describe("AccountModel", () => {
  test("verify persists the session", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.sessionJSON({ access: "a", refresh: "r" }));
    const store = new InMemorySessionStore();
    const account = new AccountModel(client(stub), store);

    await account.verify(` ${Fixtures.email} `, " 123456 ");

    expect(account.isSignedIn).toBe(true);
    expect(store.load()?.accessToken).toBe("a");
    expect(stub.body(0).token).toBe("123456");
  });

  test("a fresh token is used without refreshing", async () => {
    const stub = new StubTransport();
    const account = new AccountModel(client(stub), new InMemorySessionStore(Fixtures.session({ access: "fresh" })));
    expect(await account.validToken()).toBe("fresh");
    expect(stub.requests).toHaveLength(0);
  });

  test("an expiring token is refreshed and persisted", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.sessionJSON({ access: "new", refresh: "refresh-2" }));
    const store = new InMemorySessionStore(Fixtures.session({ access: "old", expiresIn: config.tokenRefreshLeewaySeconds - 1 }));
    const account = new AccountModel(client(stub), store);

    expect(await account.validToken()).toBe("new");
    expect(store.load()?.refreshToken).toBe("refresh-2");
    expect(stub.body(0).refresh_token).toBe("refresh-1");
  });

  /** Refresh tokens are single-use: concurrent callers must share one refresh. */
  test("concurrent callers share one refresh", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.sessionJSON({ access: "new", refresh: "refresh-2" }));
    stub.enqueue(200, Fixtures.sessionJSON({ access: "newer", refresh: "refresh-3" }));
    const release = deferred<void>();
    stub.gate = () => release.promise;
    const account = new AccountModel(client(stub), new InMemorySessionStore(Fixtures.session({ expiresIn: 0 })));

    const first = account.validToken();
    const second = account.validToken();
    release.resolve();

    expect(await Promise.all([first, second])).toEqual(["new", "new"]);
    expect(stub.requests).toHaveLength(1);
  });

  test("a rejected refresh signs out", async () => {
    const stub = new StubTransport();
    stub.enqueue(400, { error: "invalid_grant" });
    const store = new InMemorySessionStore(Fixtures.session({ expiresIn: 0 }));
    const account = new AccountModel(client(stub), store);

    expect((await authError(account.validToken()))?.kind).toBe("refreshRejected");
    expect(account.isSignedIn).toBe(false);
    expect(store.load()).toBeNull();
  });

  test("signing out during a refresh does not resurrect the session", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.sessionJSON({ access: "new", refresh: "refresh-2" }));
    const release = deferred<void>();
    stub.gate = () => release.promise;
    const store = new InMemorySessionStore(Fixtures.session({ expiresIn: 0 }));
    const account = new AccountModel(client(stub), store);

    const token = account.validToken();
    account.signOut();
    release.resolve();

    expect(await token).toBeNull();
    expect(account.isSignedIn).toBe(false);
    expect(store.load()).toBeNull();
  });

  /** A refresh started before a sign-out must not hand its token to a caller after it: the next
   * caller refreshes the new account's own session. */
  test("a sign-out drops the refresh in flight for later callers", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.sessionJSON({ access: "old-account", refresh: "refresh-2" }));
    const release = deferred<void>();
    stub.gate = () => release.promise;
    const account = new AccountModel(client(stub), new InMemorySessionStore(Fixtures.session({ expiresIn: 0 })));

    const before = account.validToken();
    account.signOut();

    expect(await account.validToken()).toBeNull();
    release.resolve();
    expect(await before).toBeNull();
  });

  test("signed out has no token", async () => {
    const account = new AccountModel(client(new StubTransport()), new InMemorySessionStore());
    expect(await account.validToken()).toBeNull();
  });

  test("observers hear of a sign-in and a sign-out", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.sessionJSON({ access: "a", refresh: "r" }));
    const account = new AccountModel(client(stub), new InMemorySessionStore());
    let changes = 0;
    account.observe(() => {
      changes += 1;
    });

    await account.verify(Fixtures.email, "123456");
    account.signOut();

    expect(changes).toBe(2);
  });
});
