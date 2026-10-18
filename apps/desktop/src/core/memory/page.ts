// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { errorName, log } from "../log.js";
import { Observable } from "../util/observable.js";
import type { MemoryStats, AgentMemory } from "./store.js";

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
  /** The memory helper couldn't answer. */
  unavailable: boolean;
  /** The search typed, empty for the newest exchanges. */
  query: string;
  /** The exchanges listed: the newest first, or the best matches. */
  entries: MemoryEntry[];
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
 * Settings › Memory (ADR-DESK-060), a port of Thunderbird's Chat History tab: how much memory holds
 * against the size limit, the limit to choose, the exchanges (searchable), each removable, and a
 * Clear All. Read when the page shows; before any agent request was kept there is nothing to read,
 * and the helper isn't started for it (its first start downloads its model).
 */
export class MemoryPage extends Observable {
  private current: MemoryPageState;
  /** Counts the reads, so only the latest one shows. */
  private reads = 0;

  constructor(
    private readonly store: AgentMemory,
    /** Whether memory has ever kept anything on this computer. */
    private readonly exists: () => boolean,
    private readonly settings: { readonly memorySizeLimit: number; setMemorySizeLimit(value: number): boolean },
  ) {
    super();
    this.current = { sizeLimit: settings.memorySizeLimit, usage: null, unavailable: false, query: "", entries: [], status: null };
  }

  get state(): MemoryPageState {
    return this.current;
  }

  /** Reads memory afresh, for the search shown (`query`; the one shown when omitted). */
  async load(query = this.current.query): Promise<void> {
    this.reads += 1;
    const read = this.reads;
    this.update({ query, sizeLimit: this.settings.memorySizeLimit });
    if (!this.exists()) {
      this.update({ usage: { docs: 0, usedBytes: 0 }, unavailable: false, entries: [] });
      return;
    }
    try {
      const [usage, hits] = await Promise.all([this.store.stats(), this.store.search({ query: query.trim(), from: "", to: "", limit: config.memoryListLimit })]);
      if (read !== this.reads) return;
      this.update({ usage, unavailable: false, entries: hits.map(({ memId, dateMs, content }) => ({ memId, dateMs, content })) });
    } catch (error) {
      if (read !== this.reads) return;
      log.error(`MemoryPage: memory couldn't be read: ${errorName(error)}`);
      this.update({ usage: null, unavailable: true, entries: [] });
    }
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

  async clear(): Promise<void> {
    if (this.exists()) await this.store.clear();
    this.update({ status: "Memory cleared." });
    await this.load();
  }

  private update(change: Partial<MemoryPageState>): void {
    this.current = { ...this.current, ...change };
    this.changed();
  }
}
