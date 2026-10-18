// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { errorName, log } from "../log.js";
import { type MemoryHit, type AgentMemory, memoryDate } from "./store.js";

/**
 * The agent loop's memory tools, run on this computer: `memory_search` finds past exchanges, and
 * `memory_read` reads those around one it found (ADR-DESK-060). A port of Thunderbird's tools of the
 * same names: the same arguments, paging, result text and errors, and, as there, each result is the
 * JSON of what the tool answers. One instance serves one request, so a search's pages last as long as
 * the request (Thunderbird resets them each turn).
 */
export class MemoryTools {
  /** The tools' names, as the loop offers them. */
  static readonly names: readonly string[] = [config.memorySearchTool, config.memoryReadTool];

  /** Each search's results, by its arguments, for its later pages. */
  private readonly searches = new Map<string, MemoryHit[]>();

  constructor(private readonly store: AgentMemory) {}

  static handles(name: string): boolean {
    return MemoryTools.names.includes(name);
  }

  /** Runs the tool `name` with `args` (the call's parsed arguments), and returns what the model reads. */
  async run(name: string, args: Record<string, unknown>): Promise<string> {
    const result = name === config.memorySearchTool ? await this.search(args) : await this.read(args);
    return JSON.stringify(result);
  }

  private async search(args: Record<string, unknown>): Promise<unknown> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query === "") {
      log.error(`MemoryTools: ${config.memorySearchTool} called without a query`);
      return { error: "missing query" };
    }
    const fromText = typeof args.from_date === "string" ? args.from_date : "";
    const toText = typeof args.to_date === "string" ? args.to_date : "";
    const key = JSON.stringify({ query, from_date: fromText, to_date: toText });
    let hits = this.searches.get(key);
    if (hits === undefined) {
      const from = isoDate(fromText);
      const to = isoDate(toText);
      const limit = Math.min(config.memorySearchPageSize * config.memorySearchPrefetchPages, config.memorySearchFetchMax);
      try {
        hits = (await this.store.search({ query, from, to, limit })).slice(0, limit);
      } catch (error) {
        log.error(`MemoryTools: ${config.memorySearchTool} failed: ${errorName(error)}`);
        return { error: `memory search failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      log.debug(`MemoryTools: ${config.memorySearchTool} found ${hits.length}`);
      this.searches.set(key, hits);
    }
    const pageSize = config.memorySearchPageSize;
    const total = hits.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const asked = typeof args.page_index === "number" && Number.isFinite(args.page_index) ? args.page_index : 1;
    const page = Math.min(Math.max(0, asked - 1), totalPages - 1);
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
            totalPages,
            totalItems: total,
            hint: `Use ${config.memoryReadTool} with a timestamp value to get the full conversation.`,
          };
    if (page + 1 < totalPages) result.comment = `There are more pages of results. To get the next page, call this tool again with page_index: ${page + 2}`;
    return result;
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
      return { error: `Failed to read memory: ${error instanceof Error ? error.message : String(error)}` };
    }
    log.debug(`MemoryTools: ${config.memoryReadTool} read ${hits.length}`);
    if (hits.length === 0) return "No conversation found around this timestamp.";
    return centred(hits, timestamp, maxTurns)
      .map((hit) => `--- Conversation from ${memoryDate(hit.dateMs)} ---\n${hit.content || "(empty)"}`)
      .join("\n\n");
  }
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

/** A date the model wrote, as the helper takes it (ISO, to the second); empty when it isn't one. */
function isoDate(text: string): string {
  if (text === "") return "";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A positive number the model gave, or null. */
function positive(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}
