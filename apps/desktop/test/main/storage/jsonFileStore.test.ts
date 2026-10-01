// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("a saved value is in the file as written", () => {
    const path = join(scratch(), "settings.json");
    expect(new JSONFileStore(path).set("excludedSites", ["example.com"])).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ excludedSites: ["example.com"] });
  });

  test.each(["not json", "[1, 2]", "null"])("an unreadable file (%j) starts empty", (contents) => {
    const path = join(scratch(), "settings.json");
    writeFileSync(path, contents);
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => errors.push(text) } });

    const store = new JSONFileStore(path);
    expect(store.snapshot()).toEqual({});
    expect(errors).toEqual(["FileStore: unreadable preferences file; starting empty"]);
    store.set("readsScreen", false);
    expect(new JSONFileStore(path).get("readsScreen")).toBe(false);
  });
});
