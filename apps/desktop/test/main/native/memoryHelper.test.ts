// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { memoryRow } from "../../../src/core/memory/store.js";
import { HelperError } from "../../../src/main/native/helperClient.js";
import { MemoryHelper, type MemoryHelperOptions, memoryFolders } from "../../../src/main/native/memoryHelper.js";

const fake = join(__dirname, "../../support/fakeMemoryHelper.mjs");
const day = 24 * 60 * 60 * 1_000;

/** Memory kept by the memory helper over its native messaging, here a stand-in helper
 * (`fakeMemoryHelper.mjs`) that keeps memory in a list and records its starts and its `init`. */
describe("MemoryHelper", () => {
  let directory: string;
  let helper: MemoryHelper | null = null;

  function make(flags: string[] = [], options: Partial<MemoryHelperOptions> = {}): MemoryHelper {
    helper = new MemoryHelper({ executable: process.execPath, args: [fake, ...flags], directory, ...options });
    return helper;
  }

  const lines = (name: string) => {
    const file = join(memoryFolders(directory).logs, name);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : [];
  };
  const starts = () => lines("starts.log").length;
  const ends = () => lines("ends.log").length;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "voice-memory-test-"));
  });

  afterEach(async () => {
    helper?.stop();
    helper = null;
    // Let a stopped helper exit before its folder goes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(directory, { recursive: true, force: true });
  });

  test("starts on first use, in memory's own folders, told where everything goes", async () => {
    const memory = make();
    expect(starts()).toBe(0);
    expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
    const folders = memoryFolders(directory);
    expect(folders.databaseFile).toBe(join(directory, "database", "tabmail_fts", "memory.db"));
    for (const folder of [folders.database, folders.models, folders.logs]) expect(existsSync(folder)).toBe(true);
    expect(JSON.parse(readFileSync(join(folders.logs, "init.json"), "utf8"))).toEqual({ profilePath: folders.database, modelDir: folders.models });
    expect(starts()).toBe(1);
  });

  test("prepare starts it ahead of a request, which then reuses it", async () => {
    const memory = make();
    memory.prepare();
    await vi.waitFor(() => expect(existsSync(join(memoryFolders(directory).logs, "init.json"))).toBe(true));
    await memory.stats();
    expect(starts()).toBe(1);
  });

  test("keeps, searches, reads, counts, trims, removes and clears", async () => {
    const memory = make();
    const now = Date.now();
    const rows = [0, 1, 2].map((i) => memoryRow(`budget question ${i} café 日本語`, `answer ${i}`, now - (3 - i) * day, String(i)));
    await memory.index(rows, 1 << 30);
    const size = Buffer.byteLength(rows[0]?.content ?? "", "utf8");
    expect(await memory.stats()).toEqual({ docs: 3, usedBytes: size * 3 });

    const found = await memory.search({ query: "budget 日本語", from: "", to: "", limit: 2 });
    expect(found).toEqual([
      { memId: "turn:2", content: rows[2]?.content, snippet: null, dateMs: rows[2]?.dateMs },
      { memId: "turn:1", content: rows[1]?.content, snippet: null, dateMs: rows[1]?.dateMs },
    ]);
    expect(await memory.read(rows[1]?.dateMs ?? 0, day / 2)).toEqual([{ memId: "turn:1", content: rows[1]?.content, snippet: "", dateMs: rows[1]?.dateMs }]);

    expect(await memory.trim(size * 2)).toEqual({ removed: 1, withinLimit: true });
    expect(await memory.trim(1)).toEqual({ removed: 2, withinLimit: false });
    await memory.index(rows, 1 << 30);
    expect(await memory.remove(["turn:0", "turn:9"])).toBe(1);
    await memory.clear();
    expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
    expect(starts()).toBe(1);
  });

  test("a reply longer than one pipe read arrives whole", async () => {
    const memory = make();
    const now = Date.now();
    const rows = Array.from({ length: 200 }, (_, i) => memoryRow(`long ${i}`, "x".repeat(2_000), now - i, String(i)));
    await memory.index(rows, 1 << 30);
    expect(await memory.search({ query: "long", from: "", to: "", limit: 200 })).toHaveLength(200);
  });

  test("the limit goes with every write, and the oldest rows go first", async () => {
    const memory = make();
    const now = Date.now();
    const rows = [0, 1, 2].map((i) => memoryRow(`r${i}`, "a", now - (3 - i) * day, String(i)));
    const size = Buffer.byteLength(rows[0]?.content ?? "", "utf8");
    await memory.index(rows, size * 2);
    expect((await memory.search({ query: "", from: "", to: "", limit: 10 })).map((hit) => hit.memId)).toEqual(["turn:2", "turn:1"]);
  });

  test("a helper's error rejects that request only", async () => {
    const memory = make(["--error-on", "memoryClear"]);
    const error = await memory.clear().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HelperError);
    expect(error).toMatchObject({ kind: "failed", method: "memoryClear", helperMessage: "memoryClear failed" });
    expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
  });

  test.each([["memoryStats", (m: MemoryHelper) => m.stats()], ["memorySearch", (m: MemoryHelper) => m.search({ query: "a", from: "", to: "", limit: 1 })], ["memoryTrim", (m: MemoryHelper) => m.trim(1)]])(
    "a reply of the wrong shape to %s rejects",
    async (method, call) => {
      const memory = make(["--bad-on", method]);
      await expect(call(memory)).rejects.toMatchObject({ kind: "failed", method, helperMessage: "unexpected reply" });
    },
  );

  test("a failed init rejects, and the next request starts the helper afresh", async () => {
    const memory = make(["--init-error"]);
    await expect(memory.stats()).rejects.toMatchObject({ kind: "failed", method: "init" });
    await expect(memory.stats()).rejects.toMatchObject({ kind: "failed", method: "init" });
    expect(starts()).toBe(2);
  });

  test("a helper that exits mid-request fails it, and the next request starts another", async () => {
    const memory = make(["--exit-on", "memorySearch"]);
    await memory.stats();
    await expect(memory.search({ query: "a", from: "", to: "", limit: 1 })).rejects.toMatchObject({ kind: "exited", method: "memorySearch" });
    expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
    expect(starts()).toBe(2);
  });

  test("a helper that can't run fails at once, not at its timeout", async () => {
    helper = new MemoryHelper({ executable: join(directory, "missing-helper"), directory, initTimeout: 60_000 });
    const started = Date.now();
    await expect(helper.stats()).rejects.toMatchObject({ kind: "exited" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a request that gets no answer times out, and the helper still serves the next", async () => {
    const memory = make(["--silent-on", "memorySearch"], { requestTimeout: 200 });
    await expect(memory.search({ query: "a", from: "", to: "", limit: 1 })).rejects.toMatchObject({ kind: "timeout", method: "memorySearch" });
    expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
    expect(starts()).toBe(1);
  });

  test("ends when unused, and starts again when next used", async () => {
    const memory = make([], { idleTimeout: 100 });
    await memory.stats();
    await vi.waitFor(() => expect(ends()).toBe(1));
    await memory.stats();
    expect(starts()).toBe(2);
  });

  test("doesn't end while a request is under way", async () => {
    const memory = make(["--slow-on", "memorySearch", "400"], { idleTimeout: 100 });
    await memory.stats();
    expect(await memory.search({ query: "a", from: "", to: "", limit: 1 })).toEqual([]);
    expect(ends()).toBe(0);
    expect(starts()).toBe(1);
  });

  /** A helper ended for idleness exits a little later; its exit must not fail the requests of the
   * helper started after it. */
  test("an ended helper's exit fails none of the next helper's requests", async () => {
    const memory = make(["--linger", "300", "--slow-on", "memorySearch", "600"], { idleTimeout: 50 });
    await memory.stats();
    await vi.waitFor(() => expect(ends()).toBe(1));
    expect(await memory.search({ query: "a", from: "", to: "", limit: 1 })).toEqual([]);
    expect(starts()).toBe(2);
  });

  test("once stopped, ends its helper and starts none again", async () => {
    const memory = make();
    await memory.stats();
    memory.stop();
    await vi.waitFor(() => expect(ends()).toBe(1));
    await expect(memory.stats()).rejects.toMatchObject({ kind: "exited" });
    memory.prepare();
    expect(starts()).toBe(1);
  });
});
