// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import { JSONFileStore } from "../../../src/main/storage/jsonFileStore.js";

/** The read error the store's file gives, by its path: one a test can't make the file system give. */
const failing = vi.hoisted(() => ({ path: "", code: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === failing.path) throw Object.assign(new Error(`${failing.code}: read failed`), { code: failing.code });
      return fs.readFileSync(...args);
    },
  };
});

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  failing.path = "";
  configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
});

/** A passing read error (the disk, a file held by another program, too many open files) never lets
 * the app write defaults over the user's file (ADR-DESK-063). */
describe("JSONFileStore read errors", () => {
  test.each([
    ["EIO", "unreadable"],
    ["EBUSY", "unreadable"],
    ["EMFILE", "unreadable"],
    ["EPERM", "permission"],
    ["EACCES", "permission"],
  ])("a file that fails to read with %s is never written over", (code, kind) => {
    const folder = mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"));
    folders.push(folder);
    const path = join(folder, "userPrompts.json");
    const kept = JSON.stringify({ "user_prompts:user_kb.md": "- Mine." });
    writeFileSync(path, kept);
    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
    failing.path = path;
    failing.code = code;

    const store = new JSONFileStore(path);
    expect(store.problem).toEqual({ kind, path, code });
    expect(store.set("user_prompts:user_kb.md", "- Default.")).toBe(false);
    expect(store.setAll({ "user_prompts:user_kb.md": "- Default." })).toBe(false);
    store.remove("user_prompts:user_kb.md");

    failing.path = "";
    expect(readFileSync(path, "utf8")).toBe(kept);
    expect(new JSONFileStore(path).get("user_prompts:user_kb.md")).toBe("- Mine.");
  });
});
