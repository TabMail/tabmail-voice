// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.


/**
 * Memory: every agent-mode request and what came of it, kept on this computer so the agent can
 * look back at it (`memory_search`, `memory_read`), and listed in Settings (ADR-DESK-061). Kept and
 * searched by Thunderbird's own search helper, in rows shaped as Thunderbird's add-on writes them:
 * one per exchange, `[USER]: …` then `[AGENT]: …`. Plain dictation is never kept, nor the screen,
 * the selection being edited, the tools' calls and results, or audio.
 */

/** One exchange as the helper stores it (Thunderbird's chat memory row). */
export interface MemoryRow {
  memId: string;
  role: "session";
  content: string;
  sessionId: string;
  turnIndex: number;
  dateMs: number;
}

/** An exchange the helper found or read back. */
export interface MemoryHit {
  memId: string;
  content: string;
  /** The words around the match, for a search; empty or absent otherwise. */
  snippet?: string | null;
  dateMs: number;
}

export interface MemoryStats {
  /** Exchanges kept. */
  docs: number;
  /** The space they take (bytes), the measure the size limit counts. */
  usedBytes: number;
}

/** What a trim did: how many exchanges it removed, and whether memory is now within the limit
 * (false when the helper ran out of time; the next exchange kept continues it). */
export interface MemoryTrim {
  removed: number;
  withinLimit: boolean;
}

/** A search: `query` empty lists the newest first; `from` and `to` are ISO dates, both empty for
 * any date; `previewChars`, the most of each exchange's content the reply carries (whole without it). */
export interface MemorySearch {
  query: string;
  from: string;
  to: string;
  limit: number;
  previewChars?: number;
}

/**
 * The memory helper refused a request (its error reply): `reason` is its text, which can quote what
 * was asked (SQLite quotes a query it can't parse), so it goes to the model as Thunderbird's tools
 * give it and never to the log; `description`, what `errorName` logs, names only the request.
 */
export class MemoryError extends Error {
  constructor(
    readonly method: string,
    readonly reason: string,
  ) {
    super("Something went wrong. Try again.");
    this.name = "MemoryError";
  }

  get description(): string {
    return `MemoryError(${this.method})`;
  }
}

/** Where memory is kept: the memory helper (`MemoryHelper`), or a stand-in in tests. Every method
 * rejects when the helper can't answer, with `MemoryError` when it refused. */
export interface AgentMemory {
  /** Starts the helper ahead of a request that may use it, so its start-up overlaps the request's
   * own wait. Best effort: nothing waits for it. */
  prepare(): void;
  /** Keeps `rows`, then removes the oldest until memory is within `maxBytes`. */
  index(rows: readonly MemoryRow[], maxBytes: number): Promise<void>;
  search(search: MemorySearch): Promise<MemoryHit[]>;
  /** The exchanges within `toleranceMs` of `timestampMs`, oldest first. */
  read(timestampMs: number, toleranceMs: number): Promise<MemoryHit[]>;
  stats(): Promise<MemoryStats>;
  /** Removes the oldest exchanges until memory is within `maxBytes`, or as many as the helper's time
   * allows. The space they took is reused for new exchanges; the file keeps its size. */
  trim(maxBytes: number): Promise<MemoryTrim>;
  /** Removes the exchanges `memIDs` names; how many there were. */
  remove(memIDs: readonly string[]): Promise<number>;
  /** Removes every exchange; resolves only once none is left. */
  clear(): Promise<void>;
}

/** The session every row is filed under: Voice's exchanges are one stream, as Thunderbird's chat. */
export const memorySessionID = "voice_agent";

/** What the agent did, as a row says it: the reply, or the text a writing tool wrote, with where it
 * went (`caption`, the chat window's "Pasted at the cursor") and the app it went into. */
export function agentPart(text: string, caption: string | null, appName: string | null): string {
  if (caption === null) return text;
  return `${caption}${appName ? ` in ${appName}` : ""}:\n${text}`;
}

/** The row for one agent-mode request: what the user asked (`request`, as transcribed) and what the
 * agent did (`agent`, from `agentPart`), at `dateMs`, under `memID` (unique). */
export function memoryRow(request: string, agent: string, dateMs: number, memID: string): MemoryRow {
  return {
    memId: `turn:${memID}`,
    role: "session",
    content: `[USER]: ${request}\n\n[AGENT]: ${agent}`,
    sessionId: memorySessionID,
    turnIndex: 0,
    dateMs,
  };
}

/** A row's `content` split back into what the user asked and what the agent did, for Settings; a row
 * not shaped as `memoryRow` writes them is all `agent`. */
export function memoryExchange(content: string): { request: string; agent: string } {
  const match = /^\[USER\]: ([\s\S]*?)\n\n\[AGENT\]: ([\s\S]*)$/.exec(content);
  return match ? { request: match[1] ?? "", agent: match[2] ?? "" } : { request: "", agent: content };
}

/** A date as the memory tools and Settings show it: "Oct 17, 2026, 09:41 AM", in the local zone. */
export function memoryDate(dateMs: number): string {
  return dateMs
    ? new Date(dateMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
}
