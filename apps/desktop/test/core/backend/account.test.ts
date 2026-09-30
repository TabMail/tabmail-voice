// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { AccountModel, AuthClient, AuthError, type TabMailSession } from "../../../src/core/backend/account.js";
import * as config from "../../../src/core/config.js";
import { deferred, Fixtures, InMemorySessionStore, StubTransport } from "../../support/support.js";

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

  /** A refresh answers for the session it was started for. Signed out and signed in afresh while it
   * ran, its answer (a rejection, or a new token even for the same user) leaves the new session, as
   * kept and as stored, alone. */
  test.each([
    ["a rejected refresh, another account signed in", 400, "user-2"],
    ["a refreshed token, the same user signed in again", 200, Fixtures.userId],
  ])("a refresh outlived by a new sign-in leaves it alone: %s", async (_, refreshStatus, newUser) => {
    const refreshing = deferred<void>();
    const release = deferred<void>();
    const stub = new StubTransport();
    stub.gate = async (request) => {
      if (!request.url.includes("grant_type=refresh_token")) return;
      refreshing.resolve();
      await release.promise;
    };
    // Replies go out in the order requests are answered: the sign-in's, then the held refresh's.
    stub.enqueue(200, Fixtures.sessionJSON({ access: "new-sign-in", refresh: "new-refresh", userId: newUser }));
    stub.enqueue(refreshStatus, refreshStatus === 200 ? Fixtures.sessionJSON({ access: "old-refreshed", refresh: "old-refresh-2" }) : { error: "invalid_grant" });
    const store = new InMemorySessionStore(Fixtures.session({ expiresIn: 0 }));
    const account = new AccountModel(client(stub), store);

    const old = account.validToken();
    await refreshing.promise;
    account.signOut();
    await account.verify(Fixtures.email, "123456");
    const signedIn = store.load();
    expect(signedIn?.accessToken).toBe("new-sign-in");
    release.resolve();

    expect(await old).toBeNull();
    expect(account.session).toEqual(signedIn);
    expect(store.load()).toEqual(signedIn);
    expect(await account.validToken()).toBe("new-sign-in");
  });

  /** Every caller sharing a refresh gets what its first caller got: none gets the old account's
   * token after a sign-out. */
  test("callers sharing a refresh get no token after a sign-out", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.sessionJSON({ access: "old-account", refresh: "refresh-2" }));
    const release = deferred<void>();
    stub.gate = () => release.promise;
    const store = new InMemorySessionStore(Fixtures.session({ expiresIn: 0 }));
    const account = new AccountModel(client(stub), store);

    const first = account.validToken();
    const second = account.validToken();
    account.signOut();
    release.resolve();

    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(stub.requests).toHaveLength(1);
    expect(store.load()).toBeNull();
  });

  /** A store that refuses to delete the saved sign-in: signing out still signs out, and says so. */
  class KeepingStore extends InMemorySessionStore {
    override clear(): void {
      throw new Error("denied");
    }
  }

  /** Signed out during a refresh, with the saved sign-in kept by the store: signed out all the same,
   * and no second refresh spends the same single-use refresh token. */
  test("a sign-out that keeps the saved sign-in during a refresh signs out, with one refresh", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.sessionJSON({ access: "refreshed", refresh: "refresh-2" }));
    const release = deferred<void>();
    stub.gate = () => release.promise;
    const account = new AccountModel(client(stub), new KeepingStore(Fixtures.session({ expiresIn: 0 })));

    const before = account.validToken();
    expect(() => account.signOut()).toThrow("denied");
    expect(account.isSignedIn).toBe(false);
    expect(await account.validToken()).toBeNull();
    release.resolve();

    expect(await before).toBeNull();
    expect(stub.requests).toHaveLength(1);
  });

  /** A rejected refresh token signs out and says so as a rejection, even when the store keeps the
   * saved sign-in. */
  test("a rejected refresh signs out even when the store keeps the saved sign-in", async () => {
    const stub = new StubTransport();
    stub.enqueue(400, { error: "invalid_grant" });
    const account = new AccountModel(client(stub), new KeepingStore(Fixtures.session({ expiresIn: 0 })));

    expect((await authError(account.validToken()))?.kind).toBe("refreshRejected");
    expect(account.isSignedIn).toBe(false);
    expect(await account.validToken()).toBeNull();
    expect(stub.requests).toHaveLength(1);
  });

  /** An old account's refresh settling while the new account's forced refresh is still out leaves that
   * refresh shared: a caller after it gets the same answer from the one request. */
  test("an old refresh settling leaves the new account's shared refresh alone", async () => {
    const old = deferred<TabMailSession>();
    const fresh = deferred<TabMailSession>();
    const sent: string[] = [];
    const newSignIn = Fixtures.session({ access: "access-b", refresh: "refresh-b", userId: "user-2" });
    const auth = {
      verify: async () => newSignIn,
      refresh: (session: TabMailSession) => {
        sent.push(session.refreshToken);
        return session.userId === "user-2" ? fresh.promise : old.promise;
      },
    } as unknown as AuthClient;
    const store = new InMemorySessionStore(Fixtures.session({ expiresIn: 0 }));
    const account = new AccountModel(auth, store);

    const first = account.validToken();
    account.signOut();
    await account.verify(Fixtures.email, "123456");
    const second = account.validToken(true);
    old.resolve(Fixtures.session({ access: "obsolete", refresh: "obsolete-r" }));
    expect(await first).toBeNull();
    const third = account.validToken(true);
    const refreshed = Fixtures.session({ access: "access-b2", refresh: "refresh-b2", userId: "user-2" });
    fresh.resolve(refreshed);

    expect(await Promise.all([second, third])).toEqual(["access-b2", "access-b2"]);
    expect(sent).toEqual([Fixtures.session().refreshToken, "refresh-b"]);
    expect(account.session).toEqual(refreshed);
    expect(store.load()).toEqual(refreshed);
  });

  /** A refreshed session the store refuses is not used: every caller sharing the refresh fails, and
   * the account and the saved session stay as they were. */
  test("a refresh the store refuses to save fails every caller and keeps the old session", async () => {
    const previous = Fixtures.session({ expiresIn: 0 });
    class RefusingStore extends InMemorySessionStore {
      override save(): void {
        throw new Error("denied");
      }
    }
    const store = new RefusingStore(previous);
    let requests = 0;
    const auth = {
      refresh: async () => {
        requests += 1;
        return Fixtures.session({ access: "rotated", refresh: "rotated-r" });
      },
    } as unknown as AuthClient;
    const account = new AccountModel(auth, store);

    const outcomes = await Promise.allSettled([account.validToken(), account.validToken()]);

    expect(requests).toBe(1);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(account.session).toBe(previous);
    expect(store.load()).toBe(previous);
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
