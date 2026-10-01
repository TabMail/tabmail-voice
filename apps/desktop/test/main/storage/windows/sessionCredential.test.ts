// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { WindowsSessionCredential } from "../../../../src/main/storage/windows/sessionCredential.js";

function fixture(legacy: string | null = null) {
  let stored: number[] | null = legacy === null ? null : [...Buffer.from(legacy, "utf16le")];
  let denied = false;
  const native = {
    getSecret: () => stored,
    getPassword: () => stored === null ? null : Buffer.from(stored).toString("utf16le"),
    setSecret: (value: Uint8Array) => {
      if (denied) throw new Error("denied");
      if (value.byteLength > 2560) throw new Error("native blob limit");
      stored = [...value];
    },
    deletePassword: () => {
      if (denied) throw new Error("denied");
      const had = stored !== null; stored = null; return had;
    },
  };
  return { credential: new WindowsSessionCredential(native), native, deny: () => { denied = true; } };
}

describe("Windows session credential encoding", () => {
  test("a JWT-shaped session beyond the UTF-16 limit round trips in one protected blob", () => {
    const value = JSON.stringify({ access_token: Buffer.from(JSON.stringify({ sub: "synthetic-user", roles: ["authenticated"], metadata: "synthetic".repeat(220) })).toString("base64url"), refresh_token: "synthetic-refresh", expires_at: 2000000000, user: { id: "synthetic-user", email: "dev@example.test", name: "🙂" } });
    expect(Buffer.byteLength(value, "utf16le")).toBeGreaterThan(2560);
    const { credential, native } = fixture();
    credential.setPassword(value);
    expect(native.getSecret()!.length).toBeLessThanOrEqual(2560);
    expect(credential.getPassword()).toBe(value);
    expect(credential.deletePassword()).toBe(true);
    expect(credential.getPassword()).toBeNull();
    expect(credential.deletePassword()).toBe(false);
  });

  test("existing UTF-16 sessions load and migrate on the next save", () => {
    const { credential, native } = fixture('{"legacy":"synthetic"}');
    expect(credential.getPassword()).toBe('{"legacy":"synthetic"}');
    credential.setPassword('{"current":"synthetic"}');
    expect(credential.getPassword()).toBe('{"current":"synthetic"}');
    expect(Buffer.from(native.getSecret()!).subarray(0, 20).toString()).toContain("TabMailVoiceSession");
  });

  test("failed or oversized writes preserve the previously saved session", () => {
    const { credential, deny } = fixture();
    credential.setPassword("previous");
    expect(() => credential.setPassword(randomBytes(4000).toString("base64"))).toThrow("blob limit");
    expect(() => credential.setPassword("x".repeat(65537))).toThrow("storage bound");
    expect(credential.getPassword()).toBe("previous");
    deny();
    expect(() => credential.setPassword("new")).toThrow("denied");
    expect(() => credential.deletePassword()).toThrow("denied");
    expect(credential.getPassword()).toBe("previous");
  });

  test("corrupt or oversized decompression is refused", () => {
    const { credential, native } = fixture();
    const prefix = Buffer.from("TabMailVoiceSession\0v1\0");
    native.setSecret(Buffer.concat([prefix, Buffer.from("corrupt")]));
    expect(() => credential.getPassword()).toThrow();
    native.setSecret(Buffer.concat([prefix, deflateSync(Buffer.alloc(65537))]));
    expect(() => credential.getPassword()).toThrow();
  });
});
