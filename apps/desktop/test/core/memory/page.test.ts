// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { log } from "../../../src/core/log.js";
import { formatBytes, MemoryPage } from "../../../src/core/memory/page.js";
import { MemoryError, type MemoryHit, type MemoryStats, memoryRow } from "../../../src/core/memory/store.js";
import { HelperError } from "../../../src/main/native/helperClient.js";
import { FakeMemory } from "../../support/fakeMemory.js";

const MB = 1_024 * 1_024;
const GB = 1_024 * MB;
const day = 24 * 60 * 60 * 1_000;

/** Settings › Memory: usage against the size limit, the limit to choose, the requests kept (searchable,
 * each removable), and Clear All, as Thunderbird's Chat History tab. */
describe("MemoryPage", () => {
  let memory: FakeMemory;
  let exists: boolean;
  let settings: { memorySizeLimit: number; setMemorySizeLimit(value: number): boolean };
  let page: MemoryPage;
  const now = Date.now();

  beforeEach(() => {
    memory = new FakeMemory();
    exists = true;
    settings = {
      memorySizeLimit: config.memorySizeLimitDefault,
      setMemorySizeLimit(value: number) {
        if (!config.memorySizeLimitChoices.includes(value)) return false;
        this.memorySizeLimit = value;
        return true;
      },
    };
    page = new MemoryPage(memory, () => exists, settings);
    for (let i = 0; i < 3; i += 1) memory.rows.push(memoryRow(`request ${i}`, `reply ${i}`, now - (3 - i) * day, String(i)));
  });

  test.each([
    [0, "0 KB"],
    [512, "0.5 KB"],
    [12.34 * MB, "12.3 MB"],
    [104.56 * MB, "105 MB"],
    [100 * MB, "100 MB"],
    [GB, "1 GB"],
    [1.5 * GB, "1.5 GB"],
    [5 * GB, "5 GB"],
    [2_048 * GB, "2048 GB"],
  ])("shows %s bytes as %s, as Thunderbird does", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  test("shows usage and the newest requests first", async () => {
    await page.load();
    expect(page.state.usage).toEqual({ docs: 3, usedBytes: memory.rows.reduce((n, row) => n + row.content.length, 0) });
    expect(page.state.unavailable).toBe(false);
    expect(page.state.entries.map((entry) => entry.memId)).toEqual(["turn:2", "turn:1", "turn:0"]);
    expect(page.state.entries[0]).toEqual({ memId: "turn:2", dateMs: now - day, content: "[USER]: request 2\n\n[AGENT]: reply 2" });
    expect(memory.searches).toEqual([{ query: "", from: "", to: "", limit: config.memoryListLimit }]);
  });

  test("searches for what was typed, and keeps the search for the next read", async () => {
    await page.load("  request 1 ");
    expect(page.state.query).toBe("  request 1 ");
    expect(page.state.entries.map((entry) => entry.memId)).toEqual(["turn:1"]);
    await page.load();
    expect(memory.searches.map((search) => search.query)).toEqual(["request 1", "request 1"]);
  });

  /** Before anything was kept there is nothing to read, and starting the helper for it would
   * download its model. */
  test("before anything is kept, shows nothing used without asking the helper", async () => {
    exists = false;
    memory.failing = true;
    await page.load();
    expect(page.state).toMatchObject({ usage: { docs: 0, usedBytes: 0 }, unavailable: false, entries: [] });
    expect(memory.searches).toEqual([]);
  });

  test("says memory is unavailable when the helper can't answer", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    await page.load();
    memory.failing = true;
    await page.load();
    expect(page.state).toMatchObject({ usage: null, unavailable: true, entries: [] });
    expect(error).toHaveBeenCalledWith("MemoryPage: memory couldn't be read: HelperError.exited(memory)");
    error.mockRestore();
  });

  /** Thunderbird's Chat History shows no results and keeps its stats for a search its helper
   * refuses. Waiting doesn't help such a search, and Clear All stays available. */
  test.each(["re: invoice", "50%", "(invoice", "invoice AND"])("a search the helper refuses (%s) empties only the list", async (query) => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    await page.load(query);
    expect(page.state).toMatchObject({ query, usage: { docs: 3 }, unavailable: false, entries: [], searchFailed: "refused" });
    expect(error.mock.calls.flat().filter((line) => String(line).includes(query))).toEqual([]);
    expect(error).toHaveBeenCalledWith("MemoryPage: memory couldn't be searched: MemoryError(memorySearch)");
    // The next search lists again.
    await page.load("request");
    expect(page.state).toMatchObject({ searchFailed: null, unavailable: false });
    expect(page.state.entries).toHaveLength(3);
    error.mockRestore();
  });

  test("a list the helper can't give, with usage read, says the list failed and keeps usage", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    memory.search = () => Promise.reject(new HelperError("timeout", "memorySearch"));
    await page.load();
    expect(page.state).toMatchObject({ usage: { docs: 3 }, unavailable: false, entries: [], searchFailed: "failed" });
    error.mockRestore();
  });

  test("usage the helper can't give, with the list read, says usage is unavailable and lists", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    memory.stats = () => Promise.reject(new MemoryError("memoryStats", "database is locked"));
    await page.load();
    expect(page.state).toMatchObject({ usage: null, unavailable: true, searchFailed: null });
    expect(page.state.entries).toHaveLength(3);
    error.mockRestore();
  });

  test("an earlier read that fails late doesn't overwrite a later one", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const failures: Array<(error: Error) => void> = [];
    const search = memory.search.bind(memory);
    memory.search = (asked) => (asked.query === "old" ? new Promise<MemoryHit[]>((_resolve, reject) => failures.push(reject)) : search(asked));
    const first = page.load("old");
    await page.load("request");
    failures[0]?.(new HelperError("timeout", "memorySearch"));
    await first;
    expect(page.state).toMatchObject({ query: "request", searchFailed: null, unavailable: false });
    expect(page.state.entries).toHaveLength(3);
    error.mockRestore();
  });

  test("shows only the latest read when an earlier one answers late", async () => {
    const answers: Array<(hits: MemoryHit[]) => void> = [];
    memory.stats = async (): Promise<MemoryStats> => ({ docs: 1, usedBytes: 1 });
    memory.search = () => new Promise<MemoryHit[]>((resolve) => answers.push(resolve));
    page = new MemoryPage(memory, () => true, settings);
    const first = page.load("old");
    const second = page.load("new");
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]?.([{ memId: "turn:new", content: "new", dateMs: now }]);
    await second;
    answers[0]?.([{ memId: "turn:old", content: "old", dateMs: now }]);
    await first;
    expect(page.state.query).toBe("new");
    expect(page.state.entries.map((entry) => entry.memId)).toEqual(["turn:new"]);
  });

  test("tells its observers of every change", async () => {
    const heard = vi.fn();
    page.observe(heard);
    await page.load();
    expect(heard).toHaveBeenCalled();
  });

  describe("size limit", () => {
    test("keeps a new limit, applies it at once, and says what was removed", async () => {
      const limit = config.memorySizeLimitChoices[0] ?? 0;
      memory.nextTrim = { removed: 2, withinLimit: true };
      const trim = vi.spyOn(memory, "trim");
      await page.setSizeLimit(limit);
      expect(settings.memorySizeLimit).toBe(limit);
      expect(trim).toHaveBeenCalledWith(limit);
      expect(page.state.status).toBe(`Size limit set to ${formatBytes(limit)}. Removed the 2 oldest requests.`);
      // Read again afterwards, under the new limit.
      expect(page.state.sizeLimit).toBe(limit);
      expect(page.state.usage?.docs).toBe(3);
    });

    test("says one request, and nothing removed, plainly", async () => {
      memory.nextTrim = { removed: 1, withinLimit: true };
      await page.setSizeLimit(GB);
      expect(page.state.status).toBe("Size limit set to 1 GB. Removed the oldest request.");
      await page.setSizeLimit(5 * GB);
      expect(page.state.status).toBe("Size limit set to 5 GB.");
    });

    test("says more go later when the helper ran out of time", async () => {
      memory.nextTrim = { removed: 4, withinLimit: false };
      await page.setSizeLimit(100 * MB);
      expect(page.state.status).toBe("Size limit set to 100 MB. Removed the 4 oldest requests. More are removed as new requests are kept.");
      memory.nextTrim = { removed: 0, withinLimit: false };
      await page.setSizeLimit(100 * MB);
      expect(page.state.status).toBe("Size limit set to 100 MB. More are removed as new requests are kept.");
    });

    test("keeps the limit and says when it applies when the helper can't trim now", async () => {
      const error = vi.spyOn(log, "error").mockImplementation(() => {});
      memory.failing = true;
      await page.setSizeLimit(250 * MB);
      expect(settings.memorySizeLimit).toBe(250 * MB);
      expect(page.state.status).toBe("Size limit set to 250 MB. It applies with the next request kept.");
      error.mockRestore();
    });

    test("before anything is kept, saves the limit without starting the helper", async () => {
      exists = false;
      const trim = vi.spyOn(memory, "trim");
      await page.setSizeLimit(500 * MB);
      expect(trim).not.toHaveBeenCalled();
      expect(page.state.status).toBe("Size limit set to 500 MB.");
    });

    test("refuses a limit it can't save, trimming nothing", async () => {
      const trim = vi.spyOn(memory, "trim");
      await expect(page.setSizeLimit(123)).rejects.toThrow("That size limit couldn't be saved. Try again.");
      expect(trim).not.toHaveBeenCalled();
      expect(settings.memorySizeLimit).toBe(config.memorySizeLimitDefault);
    });
  });

  test("removes one request and reads memory again", async () => {
    await page.load();
    await page.remove("turn:1");
    expect(memory.rows.map((row) => row.memId)).toEqual(["turn:0", "turn:2"]);
    expect(page.state.entries.map((entry) => entry.memId)).toEqual(["turn:2", "turn:0"]);
    expect(page.state.status).toBeNull();
  });

  test("Clear All removes everything, and before anything is kept asks nothing", async () => {
    await page.clear();
    expect(memory.rows).toEqual([]);
    expect(page.state).toMatchObject({ status: "Memory cleared.", usage: { docs: 0, usedBytes: 0 }, entries: [] });
    exists = false;
    const clear = vi.spyOn(memory, "clear");
    await page.clear();
    expect(clear).not.toHaveBeenCalled();
  });

  test("never says memory is cleared while it still holds requests", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    await page.load();
    memory.clearFailing = true;
    await expect(page.clear()).rejects.toThrow("Memory couldn't be cleared. Try again.");
    expect(page.state.status).toBeNull();
    expect(page.state.usage?.docs).toBe(3);
    expect(page.state.entries).toHaveLength(3);
    expect(error).toHaveBeenCalledWith("MemoryPage: memory couldn't be cleared: HelperError.exited(memoryClear)");
    error.mockRestore();
  });
});
