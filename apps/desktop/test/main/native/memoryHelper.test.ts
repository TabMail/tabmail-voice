// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { configureLog, errorName, observeContent, setDebugMode } from "../../../src/core/log.js";
import { MemoryPage } from "../../../src/core/memory/page.js";
import { MemoryError, memoryRow } from "../../../src/core/memory/store.js";
import { MemoryTools } from "../../../src/core/memory/tools.js";
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
    // The helper makes the folders it is told.
    expect(existsSync(folders.database)).toBe(true);
    expect(JSON.parse(readFileSync(join(record, "init.json"), "utf8"))).toEqual({ profilePath: folders.database, modelDir: folders.models });
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

  /** "What have we discussed" in the dates asked: the tool's empty query reaches the helper with the
   *  dates, which bound the listing (it ignores them only when none is given). */
  test.each<[string, (now: number) => Record<string, string>, string[]]>([
    ["a start", (now) => ({ from_date: new Date(now - 2.5 * day).toISOString() }), ["turn:3", "turn:2"]],
    ["an end", (now) => ({ to_date: new Date(now - 2.5 * day).toISOString() }), ["turn:1", "turn:0"]],
    ["a start and an end", (now) => ({ from_date: new Date(now - 3.5 * day).toISOString(), to_date: new Date(now - 1.5 * day).toISOString() }), ["turn:2", "turn:1"]],
    ["no dates", () => ({}), ["turn:3", "turn:2", "turn:1", "turn:0"]],
  ])("the memory search tool with no query lists only the exchanges in the dates asked: %s", async (_name, dates, expected) => {
    const memory = make();
    const now = Date.now();
    const rows = [0, 1, 2, 3].map((i) => memoryRow(`question ${i}`, `answer ${i}`, now - (4 - i) * day, String(i)));
    await memory.index(rows, 1 << 30);
    const result = JSON.parse(await new MemoryTools(memory).run("memory_search", dates(now))) as { results: string; totalItems: number };
    expect(result.totalItems).toBe(expected.length);
    const shown = [...result.results.matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1]));
    expect(shown).toEqual(expected.map((memId) => rows.find((row) => row.memId === memId)?.dateMs));
    // The stored exchanges are all still there.
    expect((await rowsOf(memory)).map((hit) => hit.memId)).toEqual(["turn:3", "turn:2", "turn:1", "turn:0"]);
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

  /** What memory was asked is never written down: a helper outlives the debug switch and the account
   * signed in, so a log it kept would go on after either changed. */
  test("writes no record of what memory was asked, with debug logging on, or turned off while it runs", async () => {
    setDebugMode(true);
    const memory = make();
    await memory.search({ query: "dentist appointment", from: "", to: "", limit: 5 });
    setDebugMode(false);
    await memory.search({ query: "bravo invoice", from: "", to: "", limit: 5 });
    expect(starts()).toBe(1);
    expect(lastArgs()).toEqual(expect.arrayContaining(["--log-level", "off"]));
    const written = readdirSync(directory, { recursive: true, encoding: "utf8" })
      .map((name) => join(directory, name))
      .filter((path) => statSync(path).isFile())
      .map((path) => readFileSync(path, "utf8"));
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((text) => text.includes("dentist") || text.includes("bravo"))).toEqual([]);
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

    /** A Clear All cut short after the database file went, leaving its write-ahead log (which holds
     * the latest exchanges), is finished by the next one from Settings. */
    test("a Clear All cut short is finished by the next, from Settings", async () => {
      const memory = make([], { idleTimeout: 50 });
      const folders = memoryFolders(directory);
      const page = new MemoryPage(memory, () => existsSync(folders.databaseFile), { memorySizeLimit: 1 << 30, setMemorySizeLimit: () => true });
      await memory.index(rows, 1 << 30);
      await vi.waitFor(() => expect(ends()).toBe(1));
      // What the cut-short clear left.
      rmSync(folders.databaseFile);
      writeFileSync(`${folders.databaseFile}-wal`, "the latest exchanges");
      await page.clear();
      expect(page.state.status).toBe("Memory cleared.");
      expect(existsSync(folders.databases)).toBe(false);
    });

    /** A search the helper is still answering when Clear All starts would answer with what is being
     * cleared: it fails instead. */
    test("a request under way when it starts fails rather than answer with what it clears", async () => {
      const memory = make(["--slow-on", "memorySearch", "300", "--linger", "1000"]);
      await memory.index(rows, 1 << 30);
      const search = memory.search({ query: "", from: "", to: "", limit: 5 });
      search.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await memory.clear();
      await expect(search).rejects.toMatchObject({ kind: "exited", method: "memorySearch" });
    });

    /** The embedding model is downloaded once; Clear All deletes only the database. */
    test("keeps the embedding model", async () => {
      const memory = make();
      const folders = memoryFolders(directory);
      await memory.index(rows, 1 << 30);
      mkdirSync(folders.models, { recursive: true });
      const model = join(folders.models, "model.onnx");
      writeFileSync(model, "the model");
      await memory.clear();
      expect(existsSync(folders.databases)).toBe(false);
      expect(readFileSync(model, "utf8")).toBe("the model");
    });

    /** A delete can fail (a file still locked, a folder that can't be written): the requests waiting
     * on it go ahead, and the delete's error, which names memory's folder, reaches none of them. */
    test.skipIf(process.platform === "win32")("a request made while a Clear All that fails runs still goes ahead, naming no folder", async () => {
      const memory = make(["--linger", "200"]);
      const folders = memoryFolders(directory);
      await memory.index(rows, 1 << 30);
      chmodSync(folders.databases, 0o500);
      try {
        const cleared = memory.clear();
        const read = new MemoryTools(memory).run("memory_read", { timestamp: rows[2]?.dateMs });
        await expect(cleared).rejects.toThrow();
        const answer = await read;
        expect(answer).not.toContain(directory);
        expect(answer).toContain("answer 2");
        expect(starts()).toBe(2);
      } finally {
        chmodSync(folders.databases, 0o700);
      }
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

  test("a helper that can't run fails at once, not at its timeout, and Clear All doesn't wait on it", async () => {
    helper = new MemoryHelper({ executable: join(directory, "missing-helper"), directory, initTimeout: 60_000, requestTimeout: 60_000, exitTimeout: 60_000 });
    const started = Date.now();
    await expect(helper.stats()).rejects.toMatchObject({ kind: "exited" });
    // It reported only an error, never an exit: Clear All, and the request after, still end.
    await helper.clear();
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

  /** Started and ended all day long, it holds on to none of the helpers that have exited: what it
   * keeps of helpers is bounded by those still running. */
  test("keeps nothing of the helpers that have exited", async () => {
    const memory = make([], { idleTimeout: 50 });
    const running = () => (memory as unknown as { running: Map<unknown, unknown> }).running.size;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      await memory.stats();
      expect(running()).toBe(1);
      await vi.waitFor(() => expect(ends()).toBe(cycle));
      await vi.waitFor(() => expect(running()).toBe(0));
    }
    expect(starts()).toBe(4);
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
    // The next helper is still the one in use, and is itself ended when unused: the first one's
    // exit didn't make it forgotten (left running, and a third started beside it on the same files).
    await memory.stats();
    expect(starts()).toBe(2);
    await vi.waitFor(() => expect(ends()).toBe(2), { timeout: 3_000 });
  });

  test("ends when unused after its latest request, not only its first", async () => {
    const memory = make([], { idleTimeout: 150 });
    await memory.stats();
    await memory.stats();
    await vi.waitFor(() => expect(ends()).toBe(1), { timeout: 3_000 });
    expect(starts()).toBe(1);
  });

  test("a request that timed out doesn't keep the helper from ending when unused", async () => {
    const memory = make(["--silent-on", "memorySearch"], { requestTimeout: 100, idleTimeout: 100 });
    await expect(memory.search({ query: "a", from: "", to: "", limit: 1 })).rejects.toMatchObject({ kind: "timeout" });
    await vi.waitFor(() => expect(ends()).toBe(1), { timeout: 3_000 });
  });

  /** The helper died, and a request is written to it before its exit is seen: the write fails, which
   * must fail that request, not throw in the app. */
  test("a request written to a helper that just died fails, and the next starts another", async () => {
    const memory = make();
    await memory.stats();
    process.kill(Number(lines("starts.log")[0]), "SIGKILL");
    // Hold the event loop so the exit isn't seen before the next request is written.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    await expect(memory.stats()).rejects.toMatchObject({ kind: "exited" });
    expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
    expect(starts()).toBe(2);
  });

  test("a helper whose model didn't load is kept when unused, so it doesn't download it at every start", async () => {
    const memory = make(["--no-model"], { idleTimeout: 50 });
    await memory.stats();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ends()).toBe(0);
    await memory.stats();
    expect(starts()).toBe(1);
  });

  test("an idle end that came while the helper was starting waits from when it answered", async () => {
    const memory = make(["--slow-on", "init", "200"], { idleTimeout: 50 });
    memory.prepare();
    await vi.waitFor(() => expect(ends()).toBe(1), { timeout: 3_000 });
    expect(starts()).toBe(1);
  });

  test("a search within dates finds only the requests within them", async () => {
    const memory = make();
    const now = Date.now();
    await memory.index([memoryRow("older budget", "a", now - 3 * day, "old"), memoryRow("newer budget", "b", now - day, "new")], 1 << 30);
    const since = new Date(now - 2 * day).toISOString();
    expect((await memory.search({ query: "budget", from: since, to: "", limit: 10 })).map((hit) => hit.memId)).toEqual(["turn:new"]);
    const until = new Date(now - 2 * day).toISOString();
    expect((await memory.search({ query: "budget", from: "", to: until, limit: 10 })).map((hit) => hit.memId)).toEqual(["turn:old"]);
    expect((await memory.search({ query: "budget", from: "", to: "", limit: 10 })).map((hit) => hit.memId)).toEqual(["turn:new", "turn:old"]);
  });

  test("the agent key pressed while Clear All runs starts no helper on the files being deleted", async () => {
    const memory = make(["--linger", "300"]);
    await memory.index([memoryRow("old request", "old reply", Date.now() - 1_000, "old")], 1 << 30);
    const cleared = memory.clear();
    memory.prepare();
    await cleared;
    expect(starts()).toBe(1);
    expect(await rowsOf(memory)).toEqual([]);
  });

  test("a reply that arrives after its request timed out is ignored", async () => {
    const memory = make(["--slow-on", "memorySearch", "400"], { requestTimeout: 150 });
    await memory.stats();
    await expect(memory.search({ query: "a", from: "", to: "", limit: 1 })).rejects.toMatchObject({ kind: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await memory.stats()).toEqual({ docs: 0, usedBytes: 0 });
    expect(starts()).toBe(1);
  });

  describe("when memory's folder can't be used", () => {
    // A file where the app's data folder should be: nothing under it can be made.
    function blocked(): string {
      const file = join(directory, "userData");
      writeFileSync(file, "a file in the way");
      return join(file, "memory");
    }

    test("the agent key doesn't throw, and memory's requests fail without naming the folder", async () => {
      const memory = make([], { directory: blocked() });
      expect(() => memory.prepare()).not.toThrow();
      await expect(memory.stats()).rejects.toMatchObject({ name: "HelperError", method: "init" });
      const tools = new MemoryTools(memory);
      const searched = await tools.run("memory_search", { query: "invoice" });
      const read = await tools.run("memory_read", { timestamp: Date.now() });
      expect(JSON.parse(searched)).toEqual({ error: "memory search failed" });
      expect(JSON.parse(read)).toEqual({ error: "Failed to read memory: Something went wrong. Try again." });
      for (const text of [searched, read, ...errors]) expect(text).not.toContain(directory);
    });

    test("a helper that can't be spawned at all fails its requests, and the agent key doesn't throw", async () => {
      helper = new MemoryHelper({ executable: "", directory });
      expect(() => helper?.prepare()).not.toThrow();
      await expect(helper.stats()).rejects.toMatchObject({ name: "HelperError", kind: "failed", method: "init" });
      expect(errors.some((line) => line.includes("MemoryHelper: couldn't run"))).toBe(true);
    });
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
