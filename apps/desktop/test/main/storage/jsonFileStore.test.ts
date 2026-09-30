// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
