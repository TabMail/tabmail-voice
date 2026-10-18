// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { errorName, log } from "../log.js";
import { Observable } from "../util/observable.js";
import { type AgentMemory, MemoryError, type MemoryStats } from "./store.js";

/** An exchange Settings › Memory lists. */
export interface MemoryEntry {
  memId: string;
  dateMs: number;
  content: string;
}

/** Settings › Memory, as the window shows it. */
export interface MemoryPageState {
  /** The size limit chosen (bytes). */
  sizeLimit: number;
  /** What memory holds; null while it is read, or when it couldn't be (`unavailable`). */
  usage: MemoryStats | null;
  /** The memory helper couldn't say what memory holds. */
  unavailable: boolean;
  /** The search typed, empty for the newest exchanges. */
  query: string;
  /** The exchanges listed: the newest first, or the best matches. */
  entries: MemoryEntry[];
  /** The list couldn't be read: `refused`, the helper refused the search (words its search can't
   * take, such as "re: invoice" or "50%"); `failed`, it couldn't answer. What memory holds still
   * shows. */
  searchFailed: "refused" | "failed" | null;
  /** What the last change did ("Size limit set to 100 MB."), until the next. */
  status: string | null;
}

/** A size as Settings shows it, as Thunderbird's Chat History does: "1.9 MB", "1 GB". */
export function formatBytes(bytes: number): string {
  const units = ["KB", "MB", "GB"];
  let value = Math.max(0, bytes) / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit] ?? ""}`;
}

/**
 * Settings › Memory (ADR-DESK-061), a port of Thunderbird's Chat History tab: how much memory holds
 * against the size limit, the limit to choose, the exchanges (searchable), each removable, and a
 * Clear All. Read when the page shows; before the helper first ran (agent mode never chosen) there is
 * nothing to read, and the helper isn't started for it (its first start downloads its model).
 */
export class MemoryPage extends Observable {
  private current: MemoryPageState;
  /** Counts the reads, so only the latest one shows. */
  private reads = 0;

  constructor(
    private readonly store: AgentMemory,
    /** Whether memory's database exists on this computer (the helper has ever run). */
    private readonly exists: () => boolean,
    private readonly settings: { readonly memorySizeLimit: number; setMemorySizeLimit(value: number): boolean },
  ) {
    super();
    this.current = { sizeLimit: settings.memorySizeLimit, usage: null, unavailable: false, query: "", entries: [], searchFailed: null, status: null };
  }

  get state(): MemoryPageState {
    return this.current;
  }

  /** Reads memory afresh, for the search shown (`query`; the one shown when omitted). What memory
   * holds and the list are read apart: a search the helper refuses empties only the list. */
  async load(query = this.current.query): Promise<void> {
    this.reads += 1;
    const read = this.reads;
    this.update({ query, sizeLimit: this.settings.memorySizeLimit });
    if (!this.exists()) {
      this.update({ usage: { docs: 0, usedBytes: 0 }, unavailable: false, entries: [], searchFailed: null });
      return;
    }
    const [usage, hits] = await Promise.allSettled([this.store.stats(), this.store.search({ query: query.trim(), from: "", to: "", limit: config.memoryListLimit })]);
    if (read !== this.reads) return;
    if (usage.status === "rejected") log.error(`MemoryPage: memory couldn't be read: ${errorName(usage.reason)}`);
    if (hits.status === "rejected") log.error(`MemoryPage: memory couldn't be searched: ${errorName(hits.reason)}`);
    this.update({
      usage: usage.status === "fulfilled" ? usage.value : null,
      unavailable: usage.status === "rejected",
      entries: hits.status === "fulfilled" ? hits.value.map(({ memId, dateMs, content }) => ({ memId, dateMs, content })) : [],
      searchFailed: hits.status === "fulfilled" ? null : hits.reason instanceof MemoryError ? "refused" : "failed",
    });
  }

  /** Keeps `value` as the size limit, and applies it now: the oldest exchanges go until memory fits,
   * or as many as the helper's time allows, and the rest go with the next requests kept. */
  async setSizeLimit(value: number): Promise<void> {
    if (!this.settings.setMemorySizeLimit(value)) throw new Error("That size limit couldn't be saved. Try again.");
    const size = formatBytes(value);
    let status = `Size limit set to ${size}.`;
    if (this.exists()) {
      try {
        const { removed, withinLimit } = await this.store.trim(value);
        if (removed > 0) status += removed === 1 ? " Removed the oldest request." : ` Removed the ${removed} oldest requests.`;
        if (!withinLimit) status += " More are removed as new requests are kept.";
      } catch (error) {
        log.error(`MemoryPage: the size limit couldn't be applied: ${errorName(error)}`);
        status = `Size limit set to ${size}. It applies with the next request kept.`;
      }
    }
    this.update({ status });
    await this.load();
  }

  async remove(memID: string): Promise<void> {
    await this.store.remove([memID]);
    this.update({ status: null });
    await this.load();
  }

  /** Removes everything memory holds; says so only once it is done. Asked of memory whether or not
   * its database exists: a clear cut short can have deleted the database and left the helper's logs,
   * which name what memory was asked, and the next Clear All must remove them. */
  async clear(): Promise<void> {
    try {
      await this.store.clear();
    } catch (error) {
      log.error(`MemoryPage: memory couldn't be cleared: ${errorName(error)}`);
      this.update({ status: null });
      await this.load();
      throw new Error("Memory couldn't be cleared. Try again.", { cause: error });
    }
    this.update({ status: "Memory cleared." });
    await this.load();
  }

  private update(change: Partial<MemoryPageState>): void {
    this.current = { ...this.current, ...change };
    this.changed();
  }
}
