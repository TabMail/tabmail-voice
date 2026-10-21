// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { log } from "../../../src/core/log.js";
import { MemoryError, memoryDate, memoryRow } from "../../../src/core/memory/store.js";
import { MemoryTools } from "../../../src/core/memory/tools.js";
import { FakeMemory } from "../../support/fakeMemory.js";

const minute = 60 * 1_000;
const day = 24 * 60 * minute;
/** How far ahead a test looks for a daylight-saving day: past two years, so every zone's next ones. */
const transitionSearchDays = 800;

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
    /** Every page of a listing (`args`, with no query), walked from the first until one says no more
     * follow: each exchange's request, in the order listed, and the last page's answer. */
    async function listAll(args: Record<string, unknown>): Promise<{ requests: string[]; stamps: number[]; last: Record<string, unknown> }> {
      const requests: string[] = [];
      const stamps: number[] = [];
      // Every exchange listed once fills at most this many pages; one more says more follow wrongly.
      const most = Math.ceil(memory.rows.length / config.memorySearchPageSize) + 1;
      for (let page = 1; page <= most; page += 1) {
        const result = (await run(config.memorySearchTool, { ...args, page_index: page })) as Record<string, unknown> & { results: string };
        expect(result.page).toBe(page);
        expect(listed(result.results)).toEqual(Array.from({ length: listed(result.results).length }, (_, i) => (page - 1) * config.memorySearchPageSize + i + 1));
        requests.push(...[...result.results.matchAll(/^\[USER\]: (.+)$/gm)].map((m) => m[1]!));
        stamps.push(...[...result.results.matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1])));
        if (result.comment === undefined) return { requests, stamps, last: result };
        expect(result.comment).toBe(`There are more pages of results. To get the next page, call this tool again with page_index: ${page + 1}`);
        expect(listed(result.results)).toHaveLength(config.memorySearchPageSize);
      }
      throw new Error(`more pages than ${most} for ${memory.rows.length} exchanges`);
    }

    /** Asks for at most `memoryListFetchRows` exchanges more than it has already listed at the
     * millisecond it continues from, and one to know whether more follow. */
    function expectSmallRequests(): void {
      expect(memory.searches.length).toBeGreaterThan(0);
      for (const search of memory.searches) {
        expect(search.query).toBe("");
        const listedAt = memory.rows.filter((row) => search.to !== "" && row.dateMs === Date.parse(search.to)).length;
        expect(search.limit).toBeLessThanOrEqual(config.memoryListFetchRows + listedAt + 1);
      }
    }

    /** "What have we discussed" names no topic: with no query the tool lists the most recent
     * exchanges, newest first, a page at a time (the helper lists the newest for an empty query). Each
     * exchange comes in full, so the helper is asked for a few at a time, never for every page at once. */
    test("with no query lists the most recent exchanges, newest first, fetching a few at a time", async () => {
      const total = config.memorySearchPageSize * 2 + 3;
      keep(total - 1, "budget");
      keep(1, "travel", () => "travel today");
      memory.rows[memory.rows.length - 1]!.dateMs = now;
      const newestFirst = [...memory.rows].sort((x, y) => y.dateMs - x.dateMs);
      for (const args of [{}, { query: "" }, { query: "   " }, { query: 42 }]) {
        tools = new MemoryTools(memory);
        memory.searches.length = 0;
        const first = (await run(config.memorySearchTool, args)) as Record<string, unknown> & { results: string };
        // How many there are isn't known until all are listed.
        expect(first).toMatchObject({ page: 1, comment: "There are more pages of results. To get the next page, call this tool again with page_index: 2" });
        expect(first.totalPages).toBeUndefined();
        expect(first.totalItems).toBeUndefined();
        expect(memory.searches.length).toBeLessThan(config.memorySearchPageSize);
        tools = new MemoryTools(memory);
        memory.searches.length = 0;
        const { stamps, last } = await listAll(args);
        expect(stamps).toEqual(newestFirst.map((row) => row.dateMs));
        expect(stamps[0]).toBe(now);
        expect(last).toMatchObject({ page: 3, totalPages: 3, totalItems: total });
        expectSmallRequests();
        // Each continues from the last exchange listed.
        expect(memory.searches.map((search) => search.to)).toEqual(["", ...memory.searches.slice(1).map((_, i) => new Date(stamps[(i + 1) * config.memoryListFetchRows - 1]!).toISOString())]);
      }
    });

    /** The helper orders a listing by date alone, so exchanges kept in the same millisecond can come
     * in any order, in a different one each time: across the requests that list them, each is listed
     * once, none left out. */
    test("with no query lists exchanges of the same millisecond once each, in whatever order the helper gives them", async () => {
      const stamp = now - day;
      for (let i = 0; i < config.memoryListFetchRows * 3 + 2; i += 1) memory.rows.push(memoryRow(`same ${i}`, `answer ${i}`, stamp, `same-${String(i).padStart(2, "0")}`));
      keep(config.memorySearchPageSize, "older", (i) => `older ${i}`);
      for (const row of memory.rows.filter((row) => row.memId.startsWith("turn:older"))) row.dateMs -= day;
      const search = memory.search.bind(memory);
      let calls = 0;
      vi.spyOn(memory, "search").mockImplementation(async (asked) => {
        calls += 1;
        const all = await search({ ...asked, limit: Number.MAX_SAFE_INTEGER });
        const direction = calls % 2 === 0 ? 1 : -1;
        return all.sort((x, y) => y.dateMs - x.dateMs || direction * x.memId.localeCompare(y.memId)).slice(0, asked.limit);
      });
      const { requests, last } = await listAll({});
      expect(requests).toHaveLength(memory.rows.length);
      expect(new Set(requests)).toEqual(new Set(memory.rows.map((row) => row.content.match(/^\[USER\]: (.+)$/m)![1])));
      expect(requests.slice(-config.memorySearchPageSize)).toEqual(Array.from({ length: config.memorySearchPageSize }, (_, i) => `older ${i}`));
      expect(last).toMatchObject({ totalItems: memory.rows.length });
      expect(calls).toBeGreaterThan(3);
      const asked = vi.mocked(memory.search).mock.calls.map(([call]) => call);
      for (const call of asked) {
        const listedAt = call.to === "" ? 0 : memory.rows.filter((row) => row.dateMs === Date.parse(call.to)).length;
        expect(call.limit).toBeLessThanOrEqual(config.memoryListFetchRows + listedAt + 1);
      }
    });

    /** Paged, a listing still keeps to the dates asked, on every page. */
    test("with no query keeps to the dates asked on every page", async () => {
      keep(config.memorySearchPageSize * 2 + 10, "budget");
      const from = now - (config.memorySearchPageSize * 2 + 4.5) * day;
      const to = now - 3.5 * day;
      const inside = memory.rows.filter((row) => row.dateMs >= from && row.dateMs <= to).sort((x, y) => y.dateMs - x.dateMs);
      const { stamps, last } = await listAll({ from_date: new Date(from).toISOString(), to_date: new Date(to).toISOString() });
      expect(stamps).toEqual(inside.map((row) => row.dateMs));
      expect(last).toMatchObject({ totalItems: inside.length });
      for (const search of memory.searches) {
        expect(search.from).toBe(new Date(from).toISOString());
        expect(Date.parse(search.to)).toBeLessThanOrEqual(to);
      }
      expectSmallRequests();
    });

    /** A page asked for directly is listed as if every page before it had been. */
    test("with no query lists a later page asked for first, and keeps a page asked for within the pages there are", async () => {
      keep(config.memorySearchPageSize * 2 + 3, "budget");
      const newestFirst = [...memory.rows].sort((x, y) => y.dateMs - x.dateMs);
      const second = (await run(config.memorySearchTool, { page_index: 2 })) as { results: string; page: number };
      expect(second.page).toBe(2);
      expect([...second.results.matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1]))).toEqual(
        newestFirst.slice(config.memorySearchPageSize, config.memorySearchPageSize * 2).map((row) => row.dateMs),
      );
      expect(await run(config.memorySearchTool, { page_index: 99 })).toMatchObject({ page: 3, totalPages: 3, totalItems: newestFirst.length });
      expect(await run(config.memorySearchTool, { page_index: 0 })).toMatchObject({ page: 1, totalPages: 3 });
      expectSmallRequests();
    });

    /** A listing ends where the exchanges do, an empty one too: whole pages, the last with the
     * totals and no "more pages", each exchange once, newest first, none removed. */
    test.each([0, config.memorySearchPageSize, config.memorySearchPageSize * 2])("with no query lists %i exchanges to their end", async (count) => {
      keep(count, "budget");
      const newestFirst = [...memory.rows].sort((x, y) => y.dateMs - x.dateMs).map((row) => row.dateMs);
      if (count === 0) {
        expect(await run(config.memorySearchTool, {})).toEqual({ results: "No relevant memories found for this query.", page: 1, totalPages: 1, pageCount: 0, totalItems: 0 });
        expect(memory.searches.length).toBeGreaterThan(0);
        return;
      }
      const { stamps, last } = await listAll({});
      expect(stamps).toEqual(newestFirst);
      expect(last).toMatchObject({ page: count / config.memorySearchPageSize, totalPages: count / config.memorySearchPageSize, totalItems: count });
      expect(memory.rows).toHaveLength(count);
    });

    /** A listing ends where a search does (its pages times its page size): a far page asked for lists
     * the newest that many, a few at a time, never the whole memory. */
    test("with no query lists at most a search's worth for a far page", async () => {
      const max = Math.min(config.memorySearchPageSize * config.memorySearchPrefetchPages, config.memorySearchFetchMax);
      keep(max + config.memoryListFetchRows * 3, "budget");
      const newestFirst = [...memory.rows].sort((x, y) => y.dateMs - x.dateMs).map((row) => row.dateMs);
      const pages = max / config.memorySearchPageSize;
      const far = (await run(config.memorySearchTool, { page_index: 1e9 })) as Record<string, unknown> & { results: string };
      expect(far).toMatchObject({ page: pages, totalPages: pages, totalItems: max });
      expect(far.comment).toBeUndefined();
      expect([...far.results.matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1]))).toEqual(newestFirst.slice(max - config.memorySearchPageSize, max));
      expect(memory.searches.length).toBeLessThanOrEqual(max / config.memoryListFetchRows + 1);
      expectSmallRequests();
    });

    /** A first request that fails is the tool's error; asked again in the same request, the listing
     * starts over and lists every exchange. */
    test("with no query lists every exchange after its first request failed", async () => {
      keep(config.memorySearchPageSize + 3, "budget");
      const newestFirst = [...memory.rows].sort((x, y) => y.dateMs - x.dateMs).map((row) => row.dateMs);
      memory.failing = true;
      expect(await run(config.memorySearchTool, {})).toEqual({ error: "memory search failed" });
      memory.failing = false;
      const { stamps, last } = await listAll({});
      expect(stamps).toEqual(newestFirst);
      expect(last).toMatchObject({ totalItems: newestFirst.length });
    });

    /** A request that fails mid-listing is the tool's error; the next call goes on from where the
     * listing got to, leaving none out and listing none twice. */
    test("with no query reports a failed request, and goes on from where it got to", async () => {
      keep(config.memorySearchPageSize * 2 + 3, "budget");
      const newestFirst = [...memory.rows].sort((x, y) => y.dateMs - x.dateMs).map((row) => row.dateMs);
      await run(config.memorySearchTool, {});
      memory.failing = true;
      expect(await run(config.memorySearchTool, { page_index: 2 })).toEqual({ error: "memory search failed" });
      memory.failing = false;
      // Kept before the retry, an exchange newer than the listing's first page shows in the next
      // listing, not this one: the retry goes on from the page it had, listing none twice.
      memory.rows.push(memoryRow("budget question kept late", "About budget: answer late", now, "budget-late"));
      const stamps: number[] = [];
      for (const page of [1, 2, 3]) {
        const result = (await run(config.memorySearchTool, { page_index: page })) as { results: string };
        stamps.push(...[...result.results.matchAll(/\[timestamp: (\d+)\]/g)].map((m) => Number(m[1])));
      }
      expect(stamps).toEqual(newestFirst);
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

    /** A day alone, as `time_delta` gives "yesterday", is the user's whole local day: west of UTC
     * its evening falls in the next UTC day, east of it its morning in the previous one, and its
     * last second still counts. */
    describe.each(["America/Vancouver", "Asia/Tokyo", "UTC"])("in %s", (zone) => {
      let savedZone: string | undefined;
      beforeEach(() => {
        savedZone = process.env.TZ;
        process.env.TZ = zone;
      });
      afterEach(() => {
        if (savedZone === undefined) delete process.env.TZ;
        else process.env.TZ = savedZone;
      });

      test.each<[string, (day: string) => Record<string, string>, string[]]>([
        ["that day as start and end", (day) => ({ from_date: day, to_date: day }), ["last second", "evening", "morning", "midnight"]],
        ["that day as the end", (day) => ({ to_date: day }), ["last second", "evening", "morning", "midnight", "the night before"]],
        ["that day as the start", (day) => ({ from_date: day }), ["today", "last second", "evening", "morning", "midnight"]],
      ])("with no query lists the whole of a day asked as a date: %s", async (_name, dates, expected) => {
        const today = new Date();
        const at = (days: number, hour: number, minute = 0, second = 0, ms = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + days, hour, minute, second, ms).getTime();
        const exchanges: [string, number][] = [
          ["the night before", at(-2, 23)],
          ["midnight", at(-1, 0)],
          ["morning", at(-1, 2)],
          ["evening", at(-1, 22)],
          ["last second", at(-1, 23, 59, 59, 500)],
          ["today", at(0, 0)],
        ];
        for (const [name, dateMs] of exchanges) memory.rows.push(memoryRow(`${name} question`, `About ${name}`, dateMs, name));
        const yesterday = new Date(at(-1, 12));
        const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
        const result = (await run(config.memorySearchTool, dates(day))) as { results: string; totalItems: number };
        expect(result.totalItems).toBe(expected.length);
        expect([...result.results.matchAll(/^\[AGENT\]: About (.+)$/gm)].map((m) => m[1])).toEqual(expected);
      });
    });

    /** A day is the user's whole local day however long daylight saving makes it (23 or 25 hours, or
     * starting at 01:00 where midnight is skipped), and a time given is that instant: each bound
     * included, the moment either side of it not. */
    describe("date bounds, exactly", () => {
      let savedZone: string | undefined;
      beforeEach(() => {
        savedZone = process.env.TZ;
      });
      afterEach(() => {
        if (savedZone === undefined) delete process.env.TZ;
        else process.env.TZ = savedZone;
      });

      const dayText = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

      /** The next day in `zone` that lasts `hours`, and, when `skipsMidnight`, starts after midnight. */
      function transitionDay(zone: string, hours: number, skipsMidnight: boolean): Date {
        process.env.TZ = zone;
        const today = new Date();
        for (let i = 0; i < transitionSearchDays; i += 1) {
          const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
          const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
          if ((next.getTime() - start.getTime()) / (60 * minute) === hours && (start.getHours() !== 0) === skipsMidnight) return start;
        }
        throw new Error(`no ${hours}-hour day in ${zone}`);
      }

      /** Lists exactly the exchanges from `from` to `to` (milliseconds, both included). */
      async function expectListed(from: number, to: number, args: Record<string, string>): Promise<void> {
        const exchanges: [string, number][] = [["before", from - 1], ["start", from], ["inside", Math.floor((from + to) / 2)], ["end", to], ["after", to + 1]];
        for (const [name, dateMs] of exchanges) memory.rows.push(memoryRow(`${name} question`, name, dateMs, name));
        const result = (await run(config.memorySearchTool, args)) as { results: string };
        expect([...result.results.matchAll(/^\[AGENT\]: (.+)$/gm)].map((m) => m[1])).toEqual(["end", "inside", "start"]);
        expect(memory.rows).toHaveLength(exchanges.length);
      }

      test.each<[string, number, boolean]>([
        ["America/Vancouver", 23, false],
        ["America/Vancouver", 25, false],
        ["America/Santiago", 23, true],
      ])("a day in %s of %s hours (midnight skipped: %s) is that whole day", async (zone, hours, skipsMidnight) => {
        const start = transitionDay(zone, hours, skipsMidnight);
        const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
        await expectListed(start.getTime(), next.getTime() - 1, { from_date: dayText(start), to_date: dayText(start) });
      });

      test.each(["", "Z", "+09:00"])("a time with offset %j is that instant", async (offset) => {
        process.env.TZ = "America/Vancouver";
        const day = dayText(new Date());
        const from = `${day}T10:15:00${offset}`;
        const to = `${day}T11:15:00${offset}`;
        await expectListed(Date.parse(from), Date.parse(to), { from_date: from, to_date: to });
      });
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

    test("passes dates as ISO times to the millisecond, drops one that isn't a date, and searches afresh for other dates", async () => {
      keep(1, "budget");
      const from = new Date(now - 7 * day);
      await run(config.memorySearchTool, { query: "budget", from_date: from.toISOString(), to_date: "last week" });
      await run(config.memorySearchTool, { query: "budget", from_date: from.toISOString(), to_date: "last week" });
      await run(config.memorySearchTool, { query: "budget" });
      expect(memory.searches.map(({ from, to }) => ({ from, to }))).toEqual([
        { from: from.toISOString(), to: "" },
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
