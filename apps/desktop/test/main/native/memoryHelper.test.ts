// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { configureLog, errorName, observeContent, setDebugMode } from "../../../src/core/log.js";
import { MemoryError, memoryRow } from "../../../src/core/memory/store.js";
import { MemoryHelper, type MemoryHelperOptions, memoryFolders } from "../../../src/main/native/memoryHelper.js";

const fake = join(__dirname, "../../support/fakeMemoryHelper.mjs");
const day = 24 * 60 * 60 * 1_000;

/** Memory kept by the memory helper over its native messaging, here a stand-in helper
 * (`fakeMemoryHelper.mjs`) that keeps memory in a file in its database folder and records its starts,
 * arguments and `init` in a folder of the test's own. */
describe("MemoryHelper", () => {
  let directory: string;
  let record: string;
  let helper: MemoryHelper | null = null;
  const errors: string[] = [];

  function make(flags: string[] = [], options: Partial<MemoryHelperOptions> = {}): MemoryHelper {
    helper = new MemoryHelper({ executable: process.execPath, args: [fake, "--record-dir", record, ...flags], directory, ...options });
    return helper;
  }

  const lines = (name: string) => {
    const file = join(record, name);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : [];
  };
  const starts = () => lines("starts.log").length;
  const ends = () => lines("ends.log").length;
  const lastArgs = () => JSON.parse(readFileSync(join(record, "args.json"), "utf8")) as string[];
  const rowsOf = (memory: MemoryHelper) => memory.search({ query: "", from: "", to: "", limit: 100 });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "voice-memory-test-"));
    record = mkdtempSync(join(tmpdir(), "voice-memory-record-"));
    errors.length = 0;
    configureLog({ isDebugBuild: false, sinks: { error: (text) => errors.push(text) } });
  });

  afterEach(async () => {
    helper?.stop();
    helper = null;
    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
    // Let a stopped helper exit before its folder goes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(directory, { recursive: true, force: true });
    rmSync(record, { recursive: true, force: true });
  });

  test("starts on first use, in memory's own folders, told where everything goes", async () => {
    const memory = make();
    expect(starts()).toBe(0);
    expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
    const folders = memoryFolders(directory);
    expect(folders.databaseFile).toBe(join(directory, "database", "tabmail_fts", "memory.db"));
    for (const folder of [folders.database, folders.models]) expect(existsSync(folder)).toBe(true);
    expect(JSON.parse(readFileSync(join(record, "init.json"), "utf8"))).toEqual({ profilePath: folders.database, modelDir: folders.models });
    expect(lastArgs()).toEqual(expect.arrayContaining(["--log-dir", folders.logs]));
    expect(starts()).toBe(1);
  });

  test("prepare starts it ahead of a request, which then reuses it", async () => {
    const memory = make();
    memory.prepare();
    await vi.waitFor(() => expect(existsSync(join(record, "init.json"))).toBe(true));
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
    expect(starts()).toBe(1);
    await memory.clear();
    expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
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

  test("a helper's error rejects that request only, with its reason kept out of what is logged", async () => {
    const memory = make(["--error-on", "memoryRemoveBatch"]);
    const error = await memory.remove(["turn:1"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemoryError);
    expect(error).toMatchObject({ method: "memoryRemoveBatch", reason: "memoryRemoveBatch failed" });
    expect(errorName(error)).toBe("MemoryError(memoryRemoveBatch)");
    expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
  });

  test("a search the helper refuses rejects with its reason, which no error log line carries", async () => {
    const memory = make();
    for (const query of ["re: invoice", "50%", "(invoice", "invoice AND"]) {
      const error = await memory.search({ query, from: "", to: "", limit: 5 }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MemoryError);
      expect((error as MemoryError).reason).toContain(query);
      expect(errorName(error)).not.toContain(query);
    }
    expect(errors.filter((line) => /invoice|50%/.test(line))).toEqual([]);
  });

  test("what the helper writes to stderr, which can name the query, reaches only the content log", async () => {
    const seen: string[] = [];
    const stop = observeContent((label, text) => seen.push(`${label}: ${text}`));
    try {
      const memory = make();
      await memory.search({ query: "dentist appointment", from: "", to: "", limit: 5 });
      await vi.waitFor(() => expect(seen.some((line) => line.startsWith("voice-memory: ") && line.includes("dentist appointment"))).toBe(true));
      expect(errors.filter((line) => line.includes("dentist"))).toEqual([]);
    } finally {
      stop();
    }
  });

  test("writes no log file anywhere while debug logging is off", async () => {
    const memory = make();
    await memory.search({ query: "dentist appointment", from: "", to: "", limit: 5 });
    expect(lastArgs()).toEqual(expect.arrayContaining(["--log-level", "off"]));
    expect(existsSync(memoryFolders(directory).logs)).toBe(false);
  });

  test("logs while debug logging is on, as decided when the helper starts", async () => {
    setDebugMode(true);
    const memory = make();
    await memory.search({ query: "dentist appointment", from: "", to: "", limit: 5 });
    expect(lastArgs()).toEqual(expect.arrayContaining(["--log-level", "debug"]));
    expect(readFileSync(join(memoryFolders(directory).logs, "fts_helper.log"), "utf8")).toContain("dentist appointment");
    // Turned off while it runs: the running helper keeps its level; the next one starts at "off".
    setDebugMode(false);
    await memory.search({ query: "x", from: "", to: "", limit: 5 });
    expect(starts()).toBe(1);
    await memory.clear();
    await memory.search({ query: "x", from: "", to: "", limit: 5 });
    expect(starts()).toBe(2);
    expect(lastArgs()).toEqual(expect.arrayContaining(["--log-level", "off"]));
    expect(existsSync(memoryFolders(directory).logs)).toBe(false);
  });

  describe("Clear All", () => {
    const now = Date.now();
    const rows = [0, 1, 2].map((i) => memoryRow(`question ${i}`, `answer ${i}`, now - (3 - i) * day, String(i)));

    test("keeps memory across helper starts (the file it deletes is where memory is)", async () => {
      const memory = make([], { idleTimeout: 50 });
      await memory.index(rows, 1 << 30);
      await vi.waitFor(() => expect(ends()).toBe(1));
      expect(await rowsOf(memory)).toHaveLength(3);
      expect(starts()).toBe(2);
    });

    test("removes every row, though the helper's own clear would answer ok and keep them", async () => {
      const memory = make(["--clear-keeps-rows"]);
      await memory.index(rows, 1 << 30);
      await memory.clear();
      expect(existsSync(memoryFolders(directory).databaseFile)).toBe(false);
      expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
      expect(await rowsOf(memory)).toEqual([]);
    });

    test("deletes memory only once the helper has exited, and ends one that doesn't", async () => {
      const memory = make(["--linger", "60000"], { exitTimeout: 200 });
      await memory.index(rows, 1 << 30);
      const pid = Number(lines("starts.log")[0]);
      await memory.clear();
      expect(() => process.kill(pid, 0)).toThrow();
      expect(errors).toEqual(["MemoryHelper: still running after its stdin closed; ending it"]);
      expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
    });

    test("a request made while it runs waits, and what it keeps stays", async () => {
      const memory = make(["--linger", "200"]);
      await memory.index(rows, 1 << 30);
      const cleared = memory.clear();
      const kept = memory.index([memoryRow("after", "kept", now, "after")], 1 << 30);
      await Promise.all([cleared, kept]);
      expect((await rowsOf(memory)).map((hit) => hit.memId)).toEqual(["turn:after"]);
    });

    test("deletes the helper's logs", async () => {
      setDebugMode(true);
      const memory = make();
      await memory.search({ query: "dentist appointment", from: "", to: "", limit: 5 });
      expect(existsSync(memoryFolders(directory).logs)).toBe(true);
      await memory.clear();
      expect(existsSync(memoryFolders(directory).logs)).toBe(false);
    });

    test("with no helper running, still deletes what memory holds", async () => {
      const memory = make([], { idleTimeout: 50 });
      await memory.index(rows, 1 << 30);
      await vi.waitFor(() => expect(ends()).toBe(1));
      await memory.clear();
      expect(existsSync(memoryFolders(directory).databaseFile)).toBe(false);
      expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
    });
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
    await expect(memory.stats()).rejects.toMatchObject({ name: "MemoryError", method: "init" });
    await expect(memory.stats()).rejects.toMatchObject({ name: "MemoryError", method: "init" });
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
