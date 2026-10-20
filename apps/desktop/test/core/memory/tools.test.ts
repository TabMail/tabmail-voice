// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { log } from "../../../src/core/log.js";
import { MemoryError, memoryDate, memoryRow } from "../../../src/core/memory/store.js";
import { MemoryTools } from "../../../src/core/memory/tools.js";
import { FakeMemory } from "../../support/fakeMemory.js";

const minute = 60 * 1_000;
const day = 24 * 60 * minute;

/** The agent loop's memory tools, run on this computer: the same arguments, paging, results and
 * errors as Thunderbird's tools of the same names, each result the JSON of what the tool answers. */
describe("MemoryTools", () => {
  let memory: FakeMemory;
  let tools: MemoryTools;
  const now = Date.now();

  /** `count` exchanges about `topic`, a day apart, the newest yesterday. */
  function keep(count: number, topic: string, request = (i: number) => `${topic} question ${i}`): void {
    for (let i = 0; i < count; i += 1) {
      memory.rows.push(memoryRow(request(i), `About ${topic}: answer ${i}`, now - (i + 1) * day, `${topic}-${i}`));
    }
  }

  /** The numbers of the results a page lists. */
  const listed = (results: unknown) => [...String(results).matchAll(/^(\d+)\. \[timestamp: /gm)].map((m) => Number(m[1]));

  async function run(name: string, args: Record<string, unknown>): Promise<unknown> {
    return JSON.parse(await tools.run(name, args)) as unknown;
  }

  beforeEach(() => {
    memory = new FakeMemory();
    tools = new MemoryTools(memory);
  });

  test("handles the two memory tools only", () => {
    expect(MemoryTools.handles(config.memorySearchTool)).toBe(true);
    expect(MemoryTools.handles(config.memoryReadTool)).toBe(true);
    expect(MemoryTools.handles("web_search")).toBe(false);
  });

  describe(config.memorySearchTool, () => {
    /** "What have we discussed" names no topic: with no query the tool lists the most recent
     * exchanges, newest first, a page at a time (the helper lists the newest for an empty query). */
    test("with no query lists the most recent exchanges, newest first", async () => {
      keep(config.memorySearchPageSize + 2, "budget");
      keep(1, "travel", () => "travel today");
      memory.rows[memory.rows.length - 1]!.dateMs = now;
      const limit = Math.min(config.memorySearchPageSize * config.memorySearchPrefetchPages, config.memorySearchFetchMax);
      for (const args of [{}, { query: "" }, { query: "   " }, { query: 42 }]) {
        tools = new MemoryTools(memory);
        memory.searches.length = 0;
        const result = (await run(config.memorySearchTool, args)) as { results: string; totalItems: number; totalPages: number };
        expect(memory.searches).toEqual([{ query: "", from: "", to: "", limit }]);
        expect(result.totalItems).toBe(config.memorySearchPageSize + 3);
        expect(result.totalPages).toBe(2);
        expect(listed(result.results)).toHaveLength(config.memorySearchPageSize);
        const stamps = [...result.results.matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1]));
        expect(stamps[0]).toBe(now);
        expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
        // The next page is the next exchanges, from the one listing.
        const next = (await run(config.memorySearchTool, { ...args, page_index: 2 })) as { results: string; page: number };
        expect(next.page).toBe(2);
        expect(listed(next.results)).toEqual([config.memorySearchPageSize + 1, config.memorySearchPageSize + 2, config.memorySearchPageSize + 3]);
        const nextStamps = [...next.results.matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1]));
        expect(nextStamps).toEqual([...nextStamps].sort((a, b) => b - a));
        expect(Math.max(...nextStamps)).toBeLessThan(Math.min(...stamps));
        expect(memory.searches).toHaveLength(1);
      }
    });

    /** The dates bound the listing as they bound a search: from a start, to an end, both, or neither. */
    test.each<[string, Record<string, string>, number[]]>([
      ["a start", { from_date: new Date(now - 3.5 * day).toISOString() }, [0, 1, 2]],
      ["an end", { to_date: new Date(now - 2.5 * day).toISOString() }, [2, 3, 4]],
      ["a start and an end", { from_date: new Date(now - 4.5 * day).toISOString(), to_date: new Date(now - 1.5 * day).toISOString() }, [1, 2, 3]],
      ["no dates", {}, [0, 1, 2, 3, 4]],
    ])("with no query keeps to the dates asked: %s", async (_name, dates, expected) => {
      keep(5, "budget");
      const result = (await run(config.memorySearchTool, dates)) as { results: string; totalItems: number };
      expect(result.totalItems).toBe(expected.length);
      for (let i = 0; i < 5; i += 1) {
        if (expected.includes(i)) expect(result.results).toContain(`budget question ${i}`);
        else expect(result.results).not.toContain(`budget question ${i}`);
      }
      expect(memory.rows).toHaveLength(5);
    });

    test("lists matches, newest first, each with its timestamp, date and text", async () => {
      keep(2, "budget");
      keep(1, "travel");
      const result = await run(config.memorySearchTool, { query: "budget" });
      const [newest, older] = memory.rows.filter((row) => row.content.includes("budget"));
      expect(result).toEqual({
        results: [
          `1. [timestamp: ${newest?.dateMs}] ${memoryDate(newest?.dateMs ?? 0)}\n${newest?.content}`,
          `2. [timestamp: ${older?.dateMs}] ${memoryDate(older?.dateMs ?? 0)}\n${older?.content}`,
        ].join("\n\n"),
        page: 1,
        totalPages: 1,
        totalItems: 2,
        hint: `Use ${config.memoryReadTool} with a timestamp value to get the full conversation.`,
      });
    });

    test("cuts each result's text to the preview length", async () => {
      memory.rows.push(memoryRow("long", "x".repeat(config.memorySearchPreviewLength * 2), now, "long"));
      const result = (await run(config.memorySearchTool, { query: "long" })) as { results: string };
      const text = result.results.split("\n").slice(1).join("\n");
      expect(text).toHaveLength(config.memorySearchPreviewLength);
    });

    /** The helper gives the words around a match, which can lie past the start of a long exchange:
     * that passage is what the result shows; without one, the start of the exchange. */
    test("shows the passage the helper matched, or the exchange's start when it gives none", async () => {
      const content = `[USER]: ${"earlier words ".repeat(60)}\n\n[AGENT]: the launch is on Friday`;
      const snippet = "…the launch is on Friday";
      vi.spyOn(memory, "search").mockResolvedValue([
        { memId: "turn:matched", content, snippet, dateMs: now - day },
        { memId: "turn:plain", content, snippet: "", dateMs: now - 2 * day },
      ]);
      const result = (await run(config.memorySearchTool, { query: "launch" })) as { results: string };
      expect(result.results).toBe(
        [
          `1. [timestamp: ${now - day}] ${memoryDate(now - day)}\n${snippet}`,
          `2. [timestamp: ${now - 2 * day}] ${memoryDate(now - 2 * day)}\n${content.slice(0, config.memorySearchPreviewLength)}`,
        ].join("\n\n"),
      );
    });

    test("says when nothing matches", async () => {
      keep(3, "budget");
      expect(await run(config.memorySearchTool, { query: "holiday" })).toEqual({
        results: "No relevant memories found for this query.",
        page: 1,
        totalPages: 1,
        pageCount: 0,
        totalItems: 0,
      });
    });

    test("fetches up to the prefetch limit once, and serves later pages from it", async () => {
      const total = config.memorySearchPageSize * 2 + 5;
      keep(total, "budget");
      const first = (await run(config.memorySearchTool, { query: "budget" })) as Record<string, unknown>;
      expect(first).toMatchObject({ page: 1, totalPages: 3, totalItems: total });
      expect(first.comment).toBe("There are more pages of results. To get the next page, call this tool again with page_index: 2");
      expect(listed(first.results)).toEqual(Array.from({ length: config.memorySearchPageSize }, (_, i) => i + 1));

      const last = (await run(config.memorySearchTool, { query: "budget", page_index: 3 })) as Record<string, unknown>;
      expect(last).toMatchObject({ page: 3, totalPages: 3 });
      expect(last.comment).toBeUndefined();
      expect(listed(last.results)).toEqual(Array.from({ length: 5 }, (_, i) => config.memorySearchPageSize * 2 + i + 1));

      expect(memory.searches).toEqual([
        { query: "budget", from: "", to: "", limit: Math.min(config.memorySearchPageSize * config.memorySearchPrefetchPages, config.memorySearchFetchMax) },
      ]);
    });

    test("keeps a page asked for within the pages there are", async () => {
      keep(config.memorySearchPageSize + 1, "budget");
      expect(await run(config.memorySearchTool, { query: "budget", page_index: 99 })).toMatchObject({ page: 2 });
      expect(await run(config.memorySearchTool, { query: "budget", page_index: 0 })).toMatchObject({ page: 1 });
      expect(await run(config.memorySearchTool, { query: "budget", page_index: "2" })).toMatchObject({ page: 1 });
    });

    test("passes dates as ISO times to the second, drops one that isn't a date, and searches afresh for other dates", async () => {
      keep(1, "budget");
      const from = new Date(now - 7 * day);
      await run(config.memorySearchTool, { query: "budget", from_date: from.toISOString(), to_date: "last week" });
      await run(config.memorySearchTool, { query: "budget", from_date: from.toISOString(), to_date: "last week" });
      await run(config.memorySearchTool, { query: "budget" });
      expect(memory.searches.map(({ from, to }) => ({ from, to }))).toEqual([
        { from: from.toISOString().replace(/\.\d{3}Z$/, "Z"), to: "" },
        { from: "", to: "" },
      ]);
    });

    test("a new set of tools searches afresh, as a new request does", async () => {
      keep(1, "budget");
      await run(config.memorySearchTool, { query: "budget" });
      tools = new MemoryTools(memory);
      await run(config.memorySearchTool, { query: "budget" });
      expect(memory.searches).toHaveLength(2);
    });

    test("reports a failed search as the tool's error", async () => {
      memory.failing = true;
      expect(await run(config.memorySearchTool, { query: "budget" })).toEqual({ error: "memory search failed" });
      // Not kept: the next call searches again.
      memory.failing = false;
      keep(1, "budget");
      expect(await run(config.memorySearchTool, { query: "budget" })).toMatchObject({ totalItems: 1 });
    });

    /** As Thunderbird's tool: a query the helper refuses comes back with the helper's reason, so the
     * model can rephrase it rather than retry it; the reason quotes the query, so no error log line
     * carries it. */
    test.each(["50% discount", "re: invoice", "budget AND (meeting OR call)"])("gives the helper's reason for a query it refuses (%s)", async (query) => {
      const error = vi.spyOn(log, "error").mockImplementation(() => {});
      expect(await run(config.memorySearchTool, { query })).toEqual({ error: `memory search failed: fts5: syntax error near "${query}"` });
      expect(error.mock.calls.flat().filter((line) => String(line).includes(query))).toEqual([]);
      expect(error).toHaveBeenCalledWith(`MemoryTools: ${config.memorySearchTool} failed: MemoryError(memorySearch)`);
      error.mockRestore();
    });
  });

  describe(config.memoryReadTool, () => {
    test.each([[{}], [{ timestamp: 0 }], [{ timestamp: "123" }], [{ timestamp: Number.NaN }]])("needs a timestamp (%o)", async (args) => {
      expect(await run(config.memoryReadTool, args)).toEqual({
        error: `Invalid or missing timestamp. Use a timestamp value from ${config.memorySearchTool} results.`,
      });
    });

    test("reads the exchanges within ten minutes of the timestamp, oldest first", async () => {
      const at = now - day;
      memory.rows.push(memoryRow("near after", "a", at + 9 * minute, "1"), memoryRow("far", "b", at - 11 * minute, "2"), memoryRow("near before", "c", at - 9 * minute, "3"));
      const read = await run(config.memoryReadTool, { timestamp: at });
      expect(read).toBe(
        [
          `--- Conversation from ${memoryDate(at - 9 * minute)} ---\n[USER]: near before\n\n[AGENT]: c`,
          `--- Conversation from ${memoryDate(at + 9 * minute)} ---\n[USER]: near after\n\n[AGENT]: a`,
        ].join("\n\n"),
      );
    });

    test("takes a wider window when asked, as a number or as text", async () => {
      const at = now - day;
      memory.rows.push(memoryRow("far", "b", at - 25 * minute, "2"));
      expect(await run(config.memoryReadTool, { timestamp: at, tolerance_minutes: "30" })).toContain("[USER]: far");
      expect(await run(config.memoryReadTool, { timestamp: at, tolerance_minutes: -5 })).toBe("No conversation found around this timestamp.");
    });

    test("gives at most twenty exchanges, or as many as asked, centred on the closest", async () => {
      const at = now - day;
      for (let i = -15; i <= 15; i += 1) memory.rows.push(memoryRow(`turn ${i}`, "ok", at + i * 1_000, String(i)));
      const turns = (text: unknown) => [...String(text).matchAll(/\[USER\]: turn (-?\d+)/g)].map((m) => Number(m[1]));
      expect(turns(await run(config.memoryReadTool, { timestamp: at }))).toEqual(Array.from({ length: config.memoryReadMaxTurns }, (_, i) => i - 10));
      expect(turns(await run(config.memoryReadTool, { timestamp: at + 2_000, max_turns: 3 }))).toEqual([1, 2, 3]);
      // At either edge, the window still holds as many as asked.
      expect(turns(await run(config.memoryReadTool, { timestamp: at - 15_000, max_turns: 4.7 }))).toEqual([-15, -14, -13, -12]);
      expect(turns(await run(config.memoryReadTool, { timestamp: at + 15_000, max_turns: 4 }))).toEqual([12, 13, 14, 15]);
      // Less than one asked is one, as Thunderbird's tool gives.
      expect(turns(await run(config.memoryReadTool, { timestamp: at, max_turns: 0.5 }))).toEqual([0]);
    });

    test("says when nothing is near, and marks an empty row", async () => {
      expect(await run(config.memoryReadTool, { timestamp: now })).toBe("No conversation found around this timestamp.");
      memory.rows.push({ ...memoryRow("x", "y", now, "e"), content: "" });
      expect(await run(config.memoryReadTool, { timestamp: now })).toBe(`--- Conversation from ${memoryDate(now)} ---\n(empty)`);
    });

    test("reports a failed read as the tool's error", async () => {
      memory.failing = true;
      expect(await run(config.memoryReadTool, { timestamp: now })).toEqual({ error: "Failed to read memory: Something went wrong. Try again." });
    });

    test("gives the helper's reason when it refuses a read, as Thunderbird's tool does", async () => {
      const error = vi.spyOn(log, "error").mockImplementation(() => {});
      memory.read = () => Promise.reject(new MemoryError("memoryRead", "database is locked"));
      expect(await run(config.memoryReadTool, { timestamp: now })).toEqual({ error: "memory read failed: database is locked" });
      expect(error).toHaveBeenCalledWith(`MemoryTools: ${config.memoryReadTool} failed: MemoryError(memoryRead)`);
      error.mockRestore();
    });
  });
});
