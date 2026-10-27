// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { errorName, log } from "../log.js";
import { type MemoryHit, type AgentMemory, MemoryError, memoryDate } from "./store.js";
import { LocalDateTime } from "../util/localDateTime.js";

/**
 * The agent loop's memory tools, run on this computer: `memory_search` finds past exchanges, and
 * `memory_read` reads those around one it found (ADR-DESK-061). A port of Thunderbird's tools of the
 * same names: the same arguments, paging, result text and errors (with no query it lists the most
 * recent exchanges, as Thunderbird will once its own change lands), and, as there, each result is the
 * JSON of what the tool answers. One instance serves one request, so a search's pages last as long as
 * the request (Thunderbird resets them each turn).
 */
export class MemoryTools {
  /** The tools' names, as the loop offers them. */
  static readonly names: readonly string[] = [config.memorySearchTool, config.memoryReadTool];

  /** Each search's results so far, by its arguments, for its later pages. */
  private readonly searches = new Map<string, Search>();

  constructor(private readonly store: AgentMemory) {}

  /** Runs the tool `name` with `args` (the call's parsed arguments), and returns what the model reads. */
  async run(name: string, args: Record<string, unknown>): Promise<string> {
    const result = name === config.memorySearchTool ? await this.search(args) : await this.read(args);
    return JSON.stringify(result);
  }

  private async search(args: Record<string, unknown>): Promise<unknown> {
    // No query lists the most recent exchanges, newest first ("what have we discussed").
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const fromText = typeof args.from_date === "string" ? args.from_date : "";
    const toText = typeof args.to_date === "string" ? args.to_date : "";
    const key = JSON.stringify({ query, from_date: fromText, to_date: toText });
    let search = this.searches.get(key);
    if (search === undefined) {
      const from = isoDate(fromText, false);
      const to = isoDate(toText, true);
      if (query === "") {
        // A listing has no relevance cut and each exchange comes in full, so it is fetched a few at a
        // time, as its pages are asked for.
        search = { hits: [], done: false, from, to };
      } else {
        const limit = config.memorySearchMaxResults;
        let hits: MemoryHit[];
        try {
          hits = (await this.store.search({ query, from, to, limit })).slice(0, limit);
        } catch (error) {
          return searchFailed(error);
        }
        log.debug(`MemoryTools: ${config.memorySearchTool} found ${hits.length}`);
        search = { hits, done: true, from, to };
      }
      this.searches.set(key, search);
    }
    const pageSize = config.memorySearchPageSize;
    const asked = typeof args.page_index === "number" && Number.isFinite(args.page_index) ? args.page_index : 1;
    const wanted = Math.max(0, asked - 1);
    // The loop runs one tool call at a time, so no other call lists this search meanwhile.
    while (!search.done && search.hits.length < (wanted + 1) * pageSize) {
      try {
        await this.listMore(search);
      } catch (error) {
        return searchFailed(error);
      }
    }
    const { hits, done } = search;
    const total = hits.length;
    const knownPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(wanted, knownPages - 1);
    const start = page * pageSize;
    const result: Record<string, unknown> =
      total === 0
        ? { results: "No relevant memories found for this query.", page: 1, totalPages: 1, pageCount: 0, totalItems: 0 }
        : {
            results: hits
              .slice(start, start + pageSize)
              .map((hit, index) => `${start + index + 1}. [timestamp: ${hit.dateMs || 0}] ${memoryDate(hit.dateMs)}\n${hit.snippet || hit.content.slice(0, config.memorySearchPreviewLength)}`)
              .join("\n\n"),
            page: page + 1,
            // How many there are is known once all are listed.
            ...(done ? { totalPages: knownPages, totalItems: total } : {}),
            hint: `Use ${config.memoryReadTool} with a timestamp value to get the full conversation.`,
          };
    if (total > start + pageSize || !done) result.comment = `There are more pages of results. To get the next page, call this tool again with page_index: ${page + 2}`;
    return result;
  }

  /** Lists the next `memoryListFetchRows` exchanges of `search`, a listing: the newest no newer than
   * the last one listed (the helper's bounds include it), less those already listed at that
   * millisecond, and one more, to know whether more follow. A listing ends at
   * `memorySearchMaxResults` exchanges, as a search does, so a far page asked for never lists the whole memory. */
  private async listMore(search: Search): Promise<void> {
    const rows = config.memoryListFetchRows;
    const last = search.hits.at(-1);
    const listedAtLast = new Set(last === undefined ? [] : search.hits.filter((hit) => hit.dateMs === last.dateMs).map((hit) => hit.memId));
    const to = last === undefined ? search.to : new Date(last.dateMs).toISOString();
    const found = await this.store.search({ query: "", from: search.from, to, limit: rows + listedAtLast.size + 1 });
    const fresh = found.filter((hit) => !listedAtLast.has(hit.memId));
    search.hits.push(...fresh.slice(0, rows));
    search.done = fresh.length <= rows || search.hits.length >= config.memorySearchMaxResults;
    log.debug(`MemoryTools: ${config.memorySearchTool} listed ${search.hits.length}`);
  }

  private async read(args: Record<string, unknown>): Promise<unknown> {
    const timestamp = args.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp === 0) {
      log.error(`MemoryTools: ${config.memoryReadTool} called without a timestamp`);
      return { error: `Invalid or missing timestamp. Use a timestamp value from ${config.memorySearchTool} results.` };
    }
    const minutes = positive(args.tolerance_minutes) ?? config.memoryReadToleranceMinutes;
    const asked = positive(args.max_turns);
    const maxTurns = asked === null ? config.memoryReadMaxTurns : Math.max(1, Math.floor(asked));
    let hits: MemoryHit[];
    try {
      hits = await this.store.read(timestamp, minutes * 60 * 1_000);
    } catch (error) {
      log.error(`MemoryTools: ${config.memoryReadTool} failed: ${errorName(error)}`);
      // As Thunderbird's tool: the helper's refusal as it gave it; a helper that couldn't answer as
      // the error says it.
      if (error instanceof MemoryError) return { error: `memory read failed: ${error.reason}` };
      return { error: `Failed to read memory: ${error instanceof Error ? error.message : String(error)}` };
    }
    log.debug(`MemoryTools: ${config.memoryReadTool} read ${hits.length}`);
    if (hits.length === 0) return "No conversation found around this timestamp.";
    return centred(hits, timestamp, maxTurns)
      .map((hit) => `--- Conversation from ${memoryDate(hit.dateMs)} ---\n${hit.content || "(empty)"}`)
      .join("\n\n");
  }
}

/** One search's results so far: all of them once `done`; a listing (no query) gets more as its pages
 * are asked for, within `from` and `to` (as the helper takes them). */
interface Search {
  hits: MemoryHit[];
  done: boolean;
  from: string;
  to: string;
}

/** As Thunderbird's tool: the helper's refusal (a query it can't parse) as it gave it, so the model can
 * rephrase; any other failure as only that it failed. */
function searchFailed(error: unknown): { error: string } {
  log.error(`MemoryTools: ${config.memorySearchTool} failed: ${errorName(error)}`);
  return { error: error instanceof MemoryError ? `memory search failed: ${error.reason}` : "memory search failed" };
}

/** At most `count` of `hits` (oldest first), centred on the one closest to `timestamp`. */
function centred(hits: MemoryHit[], timestamp: number, count: number): MemoryHit[] {
  if (hits.length <= count) return hits;
  let closest = 0;
  hits.forEach((hit, index) => {
    if (Math.abs((hit.dateMs || 0) - timestamp) < Math.abs((hits[closest]?.dateMs || 0) - timestamp)) closest = index;
  });
  let start = Math.max(0, closest - Math.floor(count / 2));
  const end = Math.min(hits.length, start + count);
  start = Math.max(0, end - count);
  return hits.slice(start, end);
}

/** A date the model wrote, as the helper takes it (ISO, to the millisecond, both bounds included);
 * empty when it isn't one. A day alone is the user's local day, as `time_delta` gives it, however
 * long daylight saving makes it: from its start, or, as the `end` of a range, through its last
 * millisecond. A time without an offset is local
 * too. */
function isoDate(text: string, end: boolean): string {
  if (text === "") return "";
  const local = LocalDateTime.parse(text);
  if (local !== null && !local.hasTime) {
    // The next day's start, not this day's start a day on: where daylight saving skips midnight, a
    // day starts at 01:00 and the next one at 00:00.
    const nextDay = LocalDateTime.startOfDay(LocalDateTime.addingDays(local.date, 1));
    return (end ? new Date(nextDay.getTime() - 1) : local.date).toISOString();
  }
  const date = local?.date ?? new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** A positive number the model gave, or null. */
function positive(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}
