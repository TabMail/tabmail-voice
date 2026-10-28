// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import { JSONFileStore } from "../../../src/main/storage/jsonFileStore.js";

const folders: string[] = [];
function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"));
  folders.push(folder);
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
});

describe("JSONFileStore", () => {
  test("values are kept across launches", () => {
    const path = join(scratch(), "Preferences/settings.json");
    const store = new JSONFileStore(path);
    store.set("dictationHotkey", "function");
    store.set("tip.agentAndHistory.displays", 3);
    store.set("gone", true);
    store.remove("gone");

    const relaunched = new JSONFileStore(path);
    expect(relaunched.get("dictationHotkey")).toBe("function");
    expect(relaunched.get("tip.agentAndHistory.displays")).toBe(3);
    expect(relaunched.get("gone")).toBeUndefined();
  });

  /** A write that fails is reported, so a choice that must last (an app or website excluded from
   * screen reading) is not taken for saved; the value is held until the app quits. */
  test.each([
    ["the file can't be written", (path: string) => mkdirSync(`${path}.tmp`)],
    ["the file can't be moved into place", (path: string) => { rmSync(path); mkdirSync(join(path, "in the way"), { recursive: true }); }],
  ])("a value is reported unsaved when %s", (_what, breakIt) => {
    const path = join(scratch(), "settings.json");
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => errors.push(text) } });
    const store = new JSONFileStore(path);
    expect(store.set("readsScreen", true)).toBe(true);
    expect(errors).toEqual([]);

    breakIt(path);
    expect(store.set("excludedSites", ["example.com"])).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^FileStore: save failed: /);
    expect(store.get("excludedSites")).toEqual(["example.com"]);
    expect(new JSONFileStore(path).get("excludedSites")).toBeUndefined();
  });

  /** Values set together are kept or lost together: a relaunch never reads one of them changed
   * and another not. */
  test("values set together are written together, or not at all", () => {
    const path = join(scratch(), "userPrompts.json");
    const store = new JSONFileStore(path);
    expect(store.setAll({ first: "one", second: "two", gone: "soon" })).toBe(true);
    expect(store.setAll({ gone: undefined })).toBe(true);
    expect(new JSONFileStore(path).snapshot()).toEqual({ first: "one", second: "two" });

    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
    mkdirSync(`${path}.tmp`);
    expect(store.setAll({ first: "uno", second: "dos" })).toBe(false);
    expect([store.get("first"), store.get("second")]).toEqual(["uno", "dos"]);
    expect(new JSONFileStore(path).snapshot()).toEqual({ first: "one", second: "two" });
  });

  test("a saved value is in the file as written", () => {
    const path = join(scratch(), "settings.json");
    expect(new JSONFileStore(path).set("excludedSites", ["example.com"])).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ excludedSites: ["example.com"] });
  });

  /** A file that is there but can't be read is never written over or moved: the app runs on defaults,
   * every save answers false, `problem` says why (for the menu to tell the user how to fix it), and
   * the next launch reads the file as it was once it can be read. */
  // Windows has no such permission bits, and root reads any file.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a file without read permission is never written over", () => {
    const path = join(scratch(), "userPrompts.json");
    writeFileSync(path, JSON.stringify({ "user_prompts:user_kb.md": "- Mine." }));
    chmodSync(path, 0o000);
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => errors.push(text) } });

    const store = new JSONFileStore(path);
    expect(store.snapshot()).toEqual({});
    expect(store.problem).toEqual({ kind: "permission", path, code: "EACCES" });
    expect(errors).toEqual(["FileStore: couldn't read a preferences file (EACCES); nothing is saved to it"]);
    expect(store.set("user_prompts:user_kb.md", "- Default.")).toBe(false);
    expect(store.setAll({ "user_prompts:user_kb.md": "- Default." })).toBe(false);
    store.remove("user_prompts:user_kb.md");
    expect(readdirSync(dirname(path))).toEqual(["userPrompts.json"]);

    chmodSync(path, 0o600);
    const relaunched = new JSONFileStore(path);
    expect(relaunched.get("user_prompts:user_kb.md")).toBe("- Mine.");
    expect(relaunched.problem).toBeUndefined();
  });

  test("a file that can't be read for another reason is never written over", () => {
    const path = join(scratch(), "settings.json");
    mkdirSync(path);
    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });

    const store = new JSONFileStore(path);
    expect(store.problem).toEqual({ kind: "unreadable", path, code: "EISDIR" });
    expect(store.set("readsScreen", false)).toBe(false);
    expect(readdirSync(path)).toEqual([]);
  });

  /** A damaged file (not a JSON object) is left as it is, byte for byte, never reset or moved by the
   * app: the user resets it by hand, as the menu tells. */
  test.each(["not json", "[1, 2]", "null", ""])("a damaged file (%j) is never written over or moved", (contents) => {
    const path = join(scratch(), "settings.json");
    writeFileSync(path, contents);
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => errors.push(text) } });

    const store = new JSONFileStore(path);
    expect(store.snapshot()).toEqual({});
    expect(store.problem).toEqual({ kind: "damaged", path, code: "invalid" });
    expect(errors).toEqual(["FileStore: a preferences file is damaged; nothing is saved to it"]);
    expect(store.set("readsScreen", false)).toBe(false);
    store.remove("readsScreen");
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(readdirSync(dirname(path))).toEqual(["settings.json"]);
  });

  test("a damaged file that isn't text is left byte for byte", () => {
    const path = join(scratch(), "userPrompts.json");
    const bytes = Buffer.from([0xff, 0xfe, 0x7b, 0x80, 0x00, 0xc3]);
    writeFileSync(path, bytes);
    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });

    const store = new JSONFileStore(path);
    expect(store.problem?.kind).toBe("damaged");
    expect(store.setAll({ "user_prompts:user_kb.md": "- Default." })).toBe(false);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  test("a file that isn't there yet starts empty, and is saved to", () => {
    const path = join(scratch(), "Preferences/settings.json");
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => errors.push(text) } });
    const store = new JSONFileStore(path);
    expect(store.snapshot()).toEqual({});
    expect(store.problem).toBeUndefined();
    expect(store.set("readsScreen", true)).toBe(true);
    expect(errors).toEqual([]);
    expect(new JSONFileStore(path).get("readsScreen")).toBe(true);
  });
});
