// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, test } from "vitest";

/** The lint rule that keeps every request to TabMail's servers on `liveTransport`, which never follows
 * a redirect (eslint.config.mjs): which code it flags, and where. `npm run lint` applies it to the
 * source. */
describe("the request rule", () => {
  const eslint = new ESLint({ cwd: join(__dirname, "..") });
  const restricted = new Set(["no-restricted-globals", "no-restricted-properties", "no-restricted-syntax"]);

  /** How many times the rule flags `code` as the file `filePath`, which must be linted (not ignored)
   * and parse. */
  async function flags(code: string, filePath = "src/core/example.ts"): Promise<number> {
    expect(await eslint.isPathIgnored(filePath)).toBe(false);
    const results = await eslint.lintText(code, { filePath });
    expect(results.map((result) => result.fatalErrorCount)).toEqual([0]);
    return (results[0]?.messages ?? []).filter((message) => message.ruleId !== null && restricted.has(message.ruleId)).length;
  }

  const bare = "export const a = (u: string) => fetch(u);";
  const property = "export const b = (u: string) => globalThis.fetch(u);";

  test.each([
    ["a call", bare, 1],
    ["fetch kept under another name or handed on", "export const send = fetch;\nexport const c = (run: (f: unknown) => void) => run(fetch);", 2],
    ["a global object's fetch", "export const d = (u: string) => [globalThis.fetch(u), global.fetch(u), window.fetch(u), self.fetch(u)];", 4],
    ["a computed global fetch", "export const e = (u: string) => globalThis[\"fetch\"](u);", 1],
    ["fetch taken out of a global object", "const { fetch: send } = globalThis;\nexport const f = (u: string) => send(u);", 1],
    ["Electron's net", "import { net } from \"electron\";\nexport const g = (u: string) => [net.fetch(u), net.request(u)];", 2],
    ["Electron's net under another name", "import { net as web } from \"electron\";\nexport const h = (u: string) => web.fetch(u);", 1],
    ["Electron imported whole", "import * as electron from \"electron\";\nimport app from \"electron\";\nexport const i = (u: string) => [electron.net.fetch(u), app.net.fetch(u)];", 2],
  ])("flags %s", async (_, code, count) => {
    expect(await flags(code)).toBe(count);
  });

  test.each([
    ["a method, a key and a property named fetch", "export class C { fetch(): void {} }\nexport const o = { fetch: 1, go(c: C) { c.fetch(); } };"],
    ["a local named fetch", "export const j = (make: () => (u: string) => void, u: string) => { const fetch = make(); fetch(u); };"],
    ["Electron's net by its name, and its other members", "import { net, shell } from \"electron\";\nexport const k = () => [net.isOnline(), shell];"],
    ["the transport", "export const l = (u: string) => liveTransport({ method: \"GET\", url: u, headers: {}, body: \"\", timeout: 1 });"],
  ])("does not flag %s", async (_, code) => {
    expect(await flags(code)).toBe(0);
  });

  test("applies to all the source, the windows' code included", async () => {
    expect(await flags(bare, "src/renderer/settings/example.tsx")).toBe(1);
  });

  /** Exactly these files may fetch directly, in either form; a file beside one of them may not. */
  test.each([
    ["src/core/backend/http.ts", "src/core/backend/example.ts"],
    ["src/core/agent/connectors/web.ts", "src/core/agent/connectors/example.ts"],
    ["src/main/documents/pdfWorker.ts", "src/main/documents/example.ts"],
  ])("leaves %s, which may fetch directly, and flags %s beside it", async (exempt, beside) => {
    expect([await flags(bare, exempt), await flags(property, exempt)]).toEqual([0, 0]);
    expect([await flags(bare, beside), await flags(property, beside)]).toEqual([1, 1]);
  });

  test("leaves the tests", async () => {
    expect([await flags(bare, "test/example.test.ts"), await flags(property, "test/example.test.ts")]).toEqual([0, 0]);
  });
});
