// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ESLint, type Linter } from "eslint";
import { describe, expect, test } from "vitest";

/** The lint rule that keeps every request to TabMail's servers on `liveTransport`, which never follows
 * a redirect (eslint.config.mjs): which code it flags, and where. `npm run lint` applies it to the
 * source. */
describe("the request rule", () => {
  const root = join(__dirname, "..");
  const eslint = new ESLint({ cwd: root });
  const restricted = new Set(["no-restricted-globals", "no-restricted-properties", "no-restricted-syntax"]);
  const exemptFiles = ["src/core/agent/connectors/web.ts", "src/core/backend/http.ts", "src/main/documents/pdfWorker.ts"];

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
    ["a global object's fetch", "export const d = (u: string) => [globalThis.fetch(u), global.fetch(u), window.fetch(u), self.fetch(u), globalThis?.fetch(u)];", 5],
    ["a computed global fetch", "export const e = (u: string) => globalThis[\"fetch\"](u);", 1],
    ["fetch taken out of a global object", "const { fetch: send } = globalThis;\nconst { \"fetch\": other } = globalThis;\nexport const f = (u: string) => [send(u), other(u)];", 2],
    ["Electron's net", "import { net } from \"electron\";\nexport const g = (u: string) => [net.fetch(u), net.request(u)];", 2],
    ["Electron's net under another name", "import { net as web } from \"electron\";\nexport const h = (u: string) => web.request(u);", 1],
    ["Electron imported whole", "import * as electron from \"electron\";\nimport app from \"electron\";\nexport const i = (u: string) => [electron.net.request(u), app.net.request(u)];", 2],
    ["Electron's main-process module, net renamed or imported whole", "import { net as web } from \"electron/main\";\nimport * as main from \"electron/main\";\nexport const m = (u: string) => [web.request(u), main.net.request(u)];", 2],
    [
      "a session's fetch",
      "import { session, type WebContents } from \"electron/main\";\nexport const n = (u: string, contents: WebContents) => [session.defaultSession.fetch(u), session.fromPartition(\"p\").fetch(u), contents.session.fetch(u)];",
      3,
    ],
    ["a session's fetch kept or taken out", "import { session } from \"electron\";\nconst ses = session.defaultSession;\nconst { fetch: send } = session.defaultSession;\nexport const o = (u: string) => [ses.fetch(u), send(u)];", 2],
    ["any other object's fetch", "export const p = (c: { fetch(): void }) => c.fetch();", 1],
  ])("flags %s", async (_, code, count) => {
    expect(await flags(code)).toBe(count);
  });

  test.each([
    ["a method and a key named fetch", "export class C { fetch(): void {} }\nexport const o = { fetch: 1 };"],
    ["a local named fetch", "export const j = (make: () => (u: string) => void, u: string) => { const fetch = make(); fetch(u); };"],
    ["Electron's net by its name, and its other members", "import { net, shell } from \"electron\";\nexport const k = () => [net.isOnline(), shell];"],
    [
      "Electron's main-process module by name, and a session's other members",
      "import { net, session } from \"electron/main\";\nexport const q = () => [net.isOnline(), session.defaultSession.setPermissionCheckHandler(null)];",
    ],
    ["another package whole", "import updater from \"electron-updater\";\nexport const r = updater;"],
    ["the transport", "export const l = (u: string) => liveTransport({ method: \"GET\", url: u, headers: {}, body: \"\", timeout: 1 });"],
  ])("does not flag %s", async (_, code) => {
    expect(await flags(code)).toBe(0);
  });

  test("applies to all the source, the windows' code included", async () => {
    expect(await flags(bare, "src/renderer/settings/example.tsx")).toBe(1);
  });

  /** Every source file has the whole rule but the three that may fetch directly, which keep only the
   * import rule. */
  test("covers every source file but the three exempt ones", async () => {
    const rules = async (filePath: string) => {
      const all = ((await eslint.calculateConfigForFile(filePath)) as Linter.Config).rules ?? {};
      return [...restricted].map((rule) => all[rule]);
    };
    const whole = await rules("src/core/example.ts");
    const exempt = await rules(exemptFiles[0] ?? "");
    const sources = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => `src/${file.split("\\").join("/")}`)
      .sort();
    expect(sources.length).toBeGreaterThan(exemptFiles.length);

    const differing: string[] = [];
    for (const file of sources) {
      expect(await eslint.isPathIgnored(file)).toBe(false);
      const own = await rules(file);
      if (JSON.stringify(own) === JSON.stringify(whole)) continue;
      expect(own).toEqual(exempt);
      differing.push(file);
    }
    expect(differing).toEqual(exemptFiles);
    expect(exempt).not.toEqual(whole);
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
