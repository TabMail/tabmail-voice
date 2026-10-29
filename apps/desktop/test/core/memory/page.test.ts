// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { log } from "../../../src/core/log.js";
import { formatBytes, MemoryPage, memoryHighlights } from "../../../src/core/memory/page.js";
import { AppSettings } from "../../../src/core/settings.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";
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

    /** A limit the settings file couldn't keep is not applied: a relaunch would bring back the one
     * saved, so nothing is trimmed to this one and Settings says it wasn't saved. */
    test("refuses a valid limit the settings file can't keep, trimming nothing", async () => {
      // As `JSONFileStore` when its file can't be written: the value is held, and reported unsaved.
      class UnwritableStore extends MemoryStore {
        override set(key: string, value: unknown): boolean {
          super.set(key, value);
          return false;
        }
      }
      const app = new AppSettings(new UnwritableStore({ memorySizeLimit: config.memorySizeLimitDefault }), () => true);
      const smaller = config.memorySizeLimitChoices[0] ?? 0;
      page = new MemoryPage(memory, () => true, app);
      const trim = vi.spyOn(memory, "trim");

      await expect(page.setSizeLimit(smaller)).rejects.toThrow("That size limit couldn't be saved. Try again.");

      expect(trim).not.toHaveBeenCalled();
      expect(app.memorySizeLimit).toBe(config.memorySizeLimitDefault);
      expect(page.state.status).toBeNull();
    });
  });

  test("removes one request, reads memory again, and the last change's line goes", async () => {
    await page.load();
    await page.setSizeLimit(GB);
    expect(page.state.status).not.toBeNull();
    await page.remove("turn:1");
    expect(memory.rows.map((row) => row.memId)).toEqual(["turn:0", "turn:2"]);
    expect(page.state.entries.map((entry) => entry.memId)).toEqual(["turn:2", "turn:0"]);
    expect(page.state.status).toBeNull();
  });

  /** Remove Old (#247), as Thunderbird's Delete Old. */
  describe("removing the old requests", () => {
    const cutoff = (days: number) => now - days * day;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      memory.rows = [];
    });
    afterEach(() => vi.useRealTimers());

    test("removes every request older than the days given, keeps the rest, says how many and lists memory again", async () => {
      memory.rows.push(memoryRow("kept", "", cutoff(30), "at"), memoryRow("kept", "", cutoff(29), "newer"), memoryRow("old", "", cutoff(30) - 1, "just"), memoryRow("old", "", cutoff(400), "far"));
      await page.removeOlderThan(30);
      expect(memory.rows.map((row) => row.memId).sort()).toEqual(["turn:at", "turn:newer"]);
      expect(page.state.status).toBe("Removed 2 requests older than 30 days.");
      expect(page.state.entries.map((entry) => entry.memId)).toEqual(["turn:newer", "turn:at"]);
      memory.rows = [memoryRow("old", "", cutoff(2), "one"), memoryRow("kept", "", cutoff(1), "day")];
      await page.removeOlderThan(1);
      expect(memory.rows.map((row) => row.memId)).toEqual(["turn:day"]);
      expect(page.state.status).toBe("Removed 1 request older than 1 day.");
    });

    test("lists the old requests a page at a time, the newest first, with the shortest preview, each page removed as it comes", async () => {
      const rows = config.memoryRemoveOldFetchRows;
      for (let i = 0; i < 2 * rows + 3; i += 1) memory.rows.push(memoryRow(`old ${i}`, "a reply", cutoff(31) - i * 1_000, String(i)));
      memory.rows.push(memoryRow("new", "", now, "new"));
      const removals = vi.spyOn(memory, "remove");
      await page.removeOlderThan(30);
      expect(memory.rows.map((row) => row.memId)).toEqual(["turn:new"]);
      expect(page.state.status).toBe(`Removed ${2 * rows + 3} requests older than 30 days.`);
      const asked = memory.searches.filter((search) => search.previewChars !== undefined);
      expect(asked).toHaveLength(3);
      for (const search of asked) expect(search).toEqual({ query: "", from: "", to: new Date(cutoff(30) - 1).toISOString(), limit: rows, previewChars: config.memoryRemoveOldPreviewChars });
      expect(removals.mock.calls.map(([ids]) => ids.length)).toEqual([rows, rows, 3]);
      expect(removals.mock.calls[0]?.[0][0]).toBe("turn:0");
    });

    test("with none older, or no memory yet, says there are none", async () => {
      memory.rows.push(memoryRow("kept", "", cutoff(1), "kept"));
      await page.removeOlderThan(7);
      expect(page.state.status).toBe("No requests older than 7 days.");
      expect(memory.rows).toHaveLength(1);
      exists = false;
      const search = vi.spyOn(memory, "search");
      await page.removeOlderThan(7);
      expect(search).not.toHaveBeenCalled();
      expect(page.state.status).toBe("No requests older than 7 days.");
    });

    test("stopped by a failure, says how many went before it, and lists memory again", async () => {
      const error = vi.spyOn(log, "error").mockImplementation(() => {});
      const rows = config.memoryRemoveOldFetchRows;
      for (let i = 0; i < rows + 1; i += 1) memory.rows.push(memoryRow(`old ${i}`, "", cutoff(31) - i, String(i)));
      const search = memory.search.bind(memory);
      vi.spyOn(memory, "search").mockImplementation(async (asked) => {
        if (asked.previewChars !== undefined && memory.rows.length <= 1) throw new HelperError("exited", "memorySearch");
        return search(asked);
      });
      await page.removeOlderThan(400);
      expect(page.state.status).toBe("No requests older than 400 days.");
      await expect(page.removeOlderThan(30)).rejects.toThrow(`Removed ${rows} requests older than 30 days, then stopped. Try again.`);
      expect(page.state.status).toBeNull();
      expect(page.state.entries.map((entry) => entry.memId)).toEqual([`turn:${rows}`]);
      expect(error).toHaveBeenCalledWith("MemoryPage: old requests couldn't be removed: HelperError.exited(memorySearch)");
      memory.failing = true;
      await expect(page.removeOlderThan(30)).rejects.toThrow("Requests older than 30 days couldn't be removed. Try again.");
      error.mockRestore();
    });

    /** With AI on, the list read again is the one shown: a search stays, with its words marked. */
    test.each([false, true])("keeps the search shown, done or failed (failed: %s)", async (fails) => {
      memory.rows.push(memoryRow("needle old", "", cutoff(40), "old"), memoryRow("needle kept", "", now, "kept"), memoryRow("unrelated", "", now - 1_000, "other"));
      await page.load("needle");
      expect(page.state.entries.map((entry) => entry.memId)).toEqual(["turn:kept", "turn:old"]);
      if (fails) {
        vi.spyOn(log, "error").mockImplementation(() => {});
        const search = memory.search.bind(memory);
        vi.spyOn(memory, "search").mockImplementation(async (asked) => {
          if (asked.previewChars !== undefined) throw new HelperError("exited", "memorySearch");
          return search(asked);
        });
        await expect(page.removeOlderThan(30)).rejects.toThrow("couldn't be removed");
      } else {
        await page.removeOlderThan(30);
      }
      expect(page.state.query).toBe("needle");
      expect(page.state.entries.map((entry) => entry.memId)).toEqual(fails ? ["turn:kept", "turn:old"] : ["turn:kept"]);
      expect(page.state.usage?.docs).toBe(memory.rows.length);
    });

    test("a full page that removes nothing ends it, rather than listing the same requests forever", async () => {
      const error = vi.spyOn(log, "error").mockImplementation(() => {});
      for (let i = 0; i < config.memoryRemoveOldFetchRows; i += 1) memory.rows.push(memoryRow(`old ${i}`, "", cutoff(31) - i, String(i)));
      const remove = vi.spyOn(memory, "remove").mockResolvedValue(0);
      await expect(page.removeOlderThan(30)).rejects.toThrow("Requests older than 30 days couldn't be removed. Try again.");
      expect(remove).toHaveBeenCalledTimes(1);
      error.mockRestore();
    });
  });

  test("Clear All removes everything, and asks memory even with no database (a clear cut short can leave its write-ahead log)", async () => {
    await page.clear();
    expect(memory.rows).toEqual([]);
    expect(page.state).toMatchObject({ status: "Memory cleared.", usage: { docs: 0, usedBytes: 0 }, entries: [] });
    exists = false;
    const clear = vi.spyOn(memory, "clear");
    await page.clear();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(page.state.status).toBe("Memory cleared.");
  });

  test("says memory is cleared only once it is, never while a clear runs or after one that fails", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    await page.load();
    const said: (string | null)[] = [];
    page.observe(() => said.push(page.state.status));
    memory.clearFailing = true;
    await expect(page.clear()).rejects.toThrow("Memory couldn't be cleared. Try again.");
    expect(said).not.toContain("Memory cleared.");
    memory.clearFailing = false;
    let finish = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const clear = memory.clear.bind(memory);
    vi.spyOn(memory, "clear").mockImplementation(async () => {
      await held;
      await clear();
    });
    const clearing = page.clear();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(said).not.toContain("Memory cleared.");
    finish();
    await clearing;
    expect(page.state.status).toBe("Memory cleared.");
    error.mockRestore();
  });

  test("never says memory is cleared while it still holds requests", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    await page.load();
    // Cleared once, then a request kept, then a clear that fails: "Memory cleared." goes.
    await page.clear();
    expect(page.state.status).toBe("Memory cleared.");
    await memory.index([memoryRow("request after", "reply after", now, "after")], GB);
    memory.clearFailing = true;
    await expect(page.clear()).rejects.toThrow("Memory couldn't be cleared. Try again.");
    expect(page.state.status).toBeNull();
    expect(page.state.usage?.docs).toBe(1);
    expect(page.state.entries.map((entry) => entry.memId)).toEqual(["turn:after"]);
    expect(error).toHaveBeenCalledWith("MemoryPage: memory couldn't be cleared: HelperError.exited(memoryClear)");
    error.mockRestore();
  });
});

/** The search's words marked in a listed request or reply (#246), as Thunderbird's Chat History marks
 * them. */
describe("memoryHighlights", () => {
  /** The parts, a marked one in brackets. */
  const shown = (text: string, query: string) => memoryHighlights(text, query).map((part) => (part.match ? `[${part.text}]` : part.text)).join("");

  test("marks each search word wherever it occurs, whatever its case, keeping the text's own", () => {
    expect(shown("The quick brown fox, the Fox.", "fox quick")).toBe("The [quick] brown [fox], the [Fox].");
    expect(memoryHighlights("say hello", "HELLO")).toEqual([
      { text: "say ", match: false },
      { text: "hello", match: true },
    ]);
  });

  test("the search's words are split at any white space, as Thunderbird splits them", () => {
    expect(shown("friday review", "friday\treview")).toBe("[friday] [review]");
    expect(shown("friday review", "friday\u00a0review")).toBe("[friday] [review]");
  });

  test("a word shorter than the shortest marked is not marked", () => {
    const short = "x".repeat(config.memoryHighlightMinLength - 1);
    const long = "y".repeat(config.memoryHighlightMinLength);
    expect(shown(`${short} ${long}`, `${short} ${long}`)).toBe(`${short} [${long}]`);
    // Two letters, as Thunderbird: a word of two is marked, a lone letter isn't.
    expect(shown("Go do it", "go d")).toBe("[Go] do it");
  });

  test("without a word to mark, or with none found, the text is one unmarked part", () => {
    for (const query of ["", "   ", "a", "absent"]) expect(memoryHighlights("hello world", query)).toEqual([{ text: "hello world", match: false }]);
    expect(memoryHighlights("", "hello")).toEqual([]);
  });

  test("a word is matched as written, its regular-expression characters too", () => {
    expect(shown("It was $10.99, not $10199.", "$10.99")).toBe("It was [$10.99], not $10199.");
    expect(shown("a (b) and a|b", "(b) a|b")).toBe("a [(b)] and [a|b]");
    for (const path of [String.raw`C:\temp`, "folder\\"]) expect(shown(`${path} C:temp`, path)).toBe(`[${path}] C:temp`);
  });

  test("where two words start at one place, the longer is marked", () => {
    expect(shown("planning the plan", "plan planning")).toBe("[planning] the [plan]");
  });

  test("letters beyond ASCII match whatever their case", () => {
    expect(shown("Über die Straße", "über STRASSE straße")).toBe("[Über] die [Straße]");
  });
});
