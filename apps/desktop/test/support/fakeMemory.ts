// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AgentMemory, MemoryError, type MemoryHit, type MemoryRow, type MemorySearch, type MemoryStats, type MemoryTrim } from "../../src/core/memory/store.js";
import { HelperError } from "../../src/main/native/helperClient.js";

/**
 * Memory held in a list, as the memory helper keeps it: a search finds the rows whose content holds
 * every word of the query, the newest first (an empty query lists them all so); a read gives those
 * within the tolerance, the oldest first; a row's size is its content's length, and a limit removes
 * the oldest first. Its failures are `MemoryHelper`'s: a search its full-text query syntax can't take
 * (`re: invoice`, `50%`, `(x`, `x AND`) is refused with a `MemoryError` quoting the query, as SQLite's
 * error does; `failing` makes every call reject as a helper that can't start does (`HelperError`), and
 * `clearFailing` only Clear All.
 */
export class FakeMemory implements AgentMemory {
  rows: MemoryRow[] = [];
  prepared = 0;
  failing = false;
  clearFailing = false;
  /** Every search asked, and every `maxBytes` an index was given. */
  readonly searches: MemorySearch[] = [];
  readonly limits: number[] = [];

  prepare(): void {
    this.prepared += 1;
  }

  async index(rows: readonly MemoryRow[], maxBytes: number): Promise<void> {
    this.check();
    this.limits.push(maxBytes);
    this.rows.push(...rows);
    this.trimTo(maxBytes);
  }

  async search(search: MemorySearch): Promise<MemoryHit[]> {
    this.check();
    this.searches.push(search);
    if (/[%():]/.test(search.query) || /(^|\s)(AND|OR|NOT|NEAR)(\s|$)/.test(search.query)) throw new MemoryError("memorySearch", `fts5: syntax error near "${search.query}"`);
    const words = search.query.toLowerCase().split(/\s+/).filter((word) => word !== "");
    return this.rows
      .filter((row) => words.every((word) => row.content.toLowerCase().includes(word)))
      .sort((a, b) => b.dateMs - a.dateMs)
      .slice(0, search.limit)
      .map(hit);
  }

  async read(timestampMs: number, toleranceMs: number): Promise<MemoryHit[]> {
    this.check();
    return this.rows.filter((row) => Math.abs(row.dateMs - timestampMs) <= toleranceMs).sort((a, b) => a.dateMs - b.dateMs).map(hit);
  }

  async stats(): Promise<MemoryStats> {
    this.check();
    return { docs: this.rows.length, usedBytes: this.usedBytes() };
  }

  /** What the next trim answers instead of trimming (a helper that ran out of time). */
  nextTrim: MemoryTrim | null = null;

  async trim(maxBytes: number): Promise<MemoryTrim> {
    this.check();
    const answer = this.nextTrim;
    this.nextTrim = null;
    if (answer !== null) return answer;
    return { removed: this.trimTo(maxBytes), withinLimit: this.usedBytes() <= maxBytes };
  }

  async remove(memIDs: readonly string[]): Promise<number> {
    this.check();
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !memIDs.includes(row.memId));
    return before - this.rows.length;
  }

  async clear(): Promise<void> {
    this.check();
    if (this.clearFailing) throw new HelperError("exited", "memoryClear");
    this.rows = [];
  }

  private usedBytes(): number {
    return this.rows.reduce((total, row) => total + row.content.length, 0);
  }

  private trimTo(maxBytes: number): number {
    let removed = 0;
    this.rows.sort((a, b) => a.dateMs - b.dateMs);
    while (this.rows.length > 0 && this.usedBytes() > maxBytes) {
      this.rows.shift();
      removed += 1;
    }
    return removed;
  }

  private check(): void {
    if (this.failing) throw new HelperError("exited", "memory");
  }
}

function hit(row: MemoryRow): MemoryHit {
  return { memId: row.memId, content: row.content, snippet: null, dateMs: row.dateMs };
}
