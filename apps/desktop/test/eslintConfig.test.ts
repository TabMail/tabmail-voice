// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, test } from "vitest";

/** The lint rule that keeps every request to TabMail's servers on `liveTransport`, which never follows
 * a redirect (eslint.config.mjs): which code it flags, and where. `npm run lint` applies it to the
 * source. */
describe("the request rule", () => {
  const eslint = new ESLint({ cwd: fileURLToPath(new URL("..", import.meta.url)) });
  const restricted = new Set(["no-restricted-globals", "no-restricted-properties"]);

  async function flags(code: string, filePath = "src/core/example.ts"): Promise<number> {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? []).filter((message) => message.ruleId !== null && restricted.has(message.ruleId)).length;
  }

  test.each([
    ["a call", "export const a = (u: string) => fetch(u);", 1],
    ["fetch kept under another name or handed on", "export const send = fetch;\nexport const b = (run: (f: unknown) => void) => run(fetch);", 2],
    ["a global object's fetch", "export const c = (u: string) => [globalThis.fetch(u), window.fetch(u), self.fetch(u)];", 3],
    ["a computed global fetch", "export const d = (u: string) => globalThis[\"fetch\"](u);", 1],
    ["Electron's net", "import { net } from \"electron\";\nexport const e = (u: string) => [net.fetch(u), net.request(u)];", 2],
  ])("flags %s", async (_, code, count) => {
    expect(await flags(code)).toBe(count);
  });

  test.each([
    ["a method, a key and a property named fetch", "export class C { fetch(): void {} }\nexport const o = { fetch: 1, go(c: C) { c.fetch(); } };"],
    ["a local named fetch", "export const f = (make: () => (u: string) => void, u: string) => { const fetch = make(); fetch(u); };"],
    ["the transport", "export const g = (u: string) => liveTransport({ method: \"GET\", url: u, headers: {}, body: \"\", timeout: 1 });"],
  ])("does not flag %s", async (_, code) => {
    expect(await flags(code)).toBe(0);
  });

  test("applies to all the source, the windows' code included", async () => {
    expect(await flags("export const h = (u: string) => fetch(u);", "src/renderer/settings/example.tsx")).toBe(1);
  });

  test.each(["src/core/backend/http.ts", "src/core/agent/connectors/web.ts", "src/main/documents/pdfWorker.ts", "test/example.test.ts"])(
    "leaves %s, which may fetch directly",
    async (filePath) => {
      expect(await flags("export const i = (u: string) => fetch(u);", filePath)).toBe(0);
    },
  );
});
