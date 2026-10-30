// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import * as config from "../../../src/core/config.js";
import { JSONFileStore, restrictDataFolder } from "../../../src/main/storage/jsonFileStore.js";

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
    expect([store.problem, store.isNew]).toEqual([{ kind: "unreadable", path, code: "EISDIR" }, false]);
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
    expect([store.problem?.kind, store.isNew]).toEqual(["damaged", false]);
    expect(store.setAll({ "user_prompts:user_kb.md": "- Default." })).toBe(false);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  test("a file that isn't there yet starts empty, and is saved to", () => {
    const path = join(scratch(), "Preferences/settings.json");
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => errors.push(text) } });
    const store = new JSONFileStore(path);
    expect(store.snapshot()).toEqual({});
    expect([store.problem, store.isNew]).toEqual([undefined, true]);
    expect(store.set("readsScreen", true)).toBe(true);
    expect(errors).toEqual([]);
    const relaunched = new JSONFileStore(path);
    expect([relaunched.get("readsScreen"), relaunched.isNew]).toEqual([true, false]);
  });
  /** The user's factory reset (ADR-DESK-063): the file that couldn't be read is renamed aside, byte
   * for byte, never deleted, and the store starts again empty and saves from then on. */
  test.each([
    ["damaged", (path: string) => writeFileSync(path, "not json")],
    ["unreadable", (path: string) => mkdirSync(path)],
  ])("a %s file is kept as the reset copy, and the store saves afresh", (_kind, breakIt) => {
    const path = join(scratch(), "settings.json");
    const aside = join(dirname(path), "settings (before reset).json");
    breakIt(path);
    const store = new JSONFileStore(path);
    expect(store.problem).toBeDefined();
    const before = readdirSync(dirname(path)).length;
    // A change this session made, held until quit only, goes with the reset.
    expect(store.set("dictationHotkey", "function")).toBe(false);

    store.moveAside(aside);
    expect(store.problem).toBeUndefined();
    expect(store.snapshot()).toEqual({});
    expect(readdirSync(dirname(path))).toHaveLength(before);
    expect(readdirSync(dirname(path))).toContain("settings (before reset).json");
    expect(store.set("readsScreen", false)).toBe(true);
    expect(new JSONFileStore(path).get("readsScreen")).toBe(false);
    expect(new JSONFileStore(path).problem).toBeUndefined();
  });

  test("the reset copy holds the damaged file byte for byte", () => {
    const path = join(scratch(), "userPrompts.json");
    const aside = join(dirname(path), "userPrompts (before reset).json");
    const bytes = Buffer.from([0xff, 0xfe, 0x7b, 0x80, 0x00, 0xc3]);
    writeFileSync(path, bytes);
    const store = new JSONFileStore(path);
    store.moveAside(aside);
    expect(readFileSync(aside).equals(bytes)).toBe(true);
    expect(store.setAll({ "user_prompts:user_kb.md": "- Default." })).toBe(true);
    expect(readFileSync(aside).equals(bytes)).toBe(true);
  });

  test("a file that was read is never reset", () => {
    const path = join(scratch(), "settings.json");
    const store = new JSONFileStore(path);
    expect(store.set("readsScreen", false)).toBe(true);
    expect(() => store.moveAside(join(dirname(path), "aside.json"))).toThrow();
    expect(readdirSync(dirname(path))).toEqual(["settings.json"]);
    expect(store.get("readsScreen")).toBe(false);
  });

  /** A copy already under the reset's name is never written over: both files stay, and nothing changes. */
  test("a reset whose copy's name is taken changes nothing", () => {
    const path = join(scratch(), "settings.json");
    const aside = join(dirname(path), "aside.json");
    writeFileSync(path, "not json");
    writeFileSync(aside, "kept");
    const store = new JSONFileStore(path);
    expect(store.set("readsScreen", true)).toBe(false);
    expect(() => store.moveAside(aside)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("not json");
    expect(readFileSync(aside, "utf8")).toBe("kept");
    expect(store.problem?.kind).toBe("damaged");
    expect(store.get("readsScreen")).toBe(true);
    expect(store.set("readsScreen", false)).toBe(false);
  });

  test("a reset that can't rename the file changes nothing", () => {
    const path = join(scratch(), "settings.json");
    writeFileSync(path, "not json");
    const store = new JSONFileStore(path);
    // What the session held until quit stays when the reset fails.
    expect(store.set("readsScreen", true)).toBe(false);
    expect(() => store.moveAside(join(dirname(path), "missing folder", "aside.json"))).toThrow();
    expect(readFileSync(path, "utf8")).toBe("not json");
    expect(store.problem?.kind).toBe("damaged");
    expect(store.get("readsScreen")).toBe(true);
    expect(store.set("readsScreen", false)).toBe(false);
  });
});

/** Root ADR-035: the app's data folder and the files it writes there are the user's alone, set rather
 * than left to the system's defaults (POSIX permissions; Windows keeps a profile's folders private). */
describe.skipIf(process.platform === "win32")("permissions", () => {
  const mode = (path: string) => statSync(path).mode & 0o777;

  test("a saved file is the user's alone, and so are the folders made for it", () => {
    const path = join(scratch(), "Made/Here/userPrompts.json");
    expect(new JSONFileStore(path).set("key", "value")).toBe(true);
    expect(mode(path)).toBe(config.privateFileMode);
    expect(mode(dirname(path))).toBe(config.privateFolderMode);
    expect(mode(dirname(dirname(path)))).toBe(config.privateFolderMode);
  });

  /** A temporary file a crash left keeps its permissions when written over: they are set again. */
  test("a saved file is the user's alone whatever a leftover temporary file had", () => {
    const path = join(scratch(), "userPrompts.json");
    writeFileSync(`${path}.tmp`, "{}");
    chmodSync(`${path}.tmp`, 0o644);
    expect(new JSONFileStore(path).set("key", "value")).toBe(true);
    expect(mode(path)).toBe(config.privateFileMode);
  });

  test("a file read at launch is made the user's alone; one that couldn't be read is left as it is", () => {
    const folder = scratch();
    const readable = join(folder, "settings.json");
    writeFileSync(readable, "{}");
    chmodSync(readable, 0o644);
    new JSONFileStore(readable);
    expect(mode(readable)).toBe(config.privateFileMode);

    const damaged = join(folder, "userPrompts.json");
    writeFileSync(damaged, "not json");
    chmodSync(damaged, 0o644);
    expect(new JSONFileStore(damaged).problem).toBeDefined();
    expect(mode(damaged)).toBe(0o644);
  });

  test("the data folder is made, or made the user's alone when it is there", () => {
    const folder = scratch();
    const made = join(folder, "New");
    restrictDataFolder(made);
    expect(mode(made)).toBe(config.privateFolderMode);

    chmodSync(folder, 0o755);
    restrictDataFolder(folder);
    expect(mode(folder)).toBe(config.privateFolderMode);
  });

  /** A folder that can't be made is logged by its error's code, never its path, and nothing throws. */
  test("a data folder that can't be made is logged without its path", () => {
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (line) => errors.push(line) } });
    const file = join(scratch(), "a-file");
    writeFileSync(file, "");
    restrictDataFolder(join(file, "below"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(file);
  });
});

