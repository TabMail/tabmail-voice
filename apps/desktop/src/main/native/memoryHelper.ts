// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as config from "../../core/config.js";
import { errorName, log } from "../../core/log.js";
import type { AgentMemory, MemoryHit, MemoryRow, MemorySearch, MemoryStats, MemoryTrim } from "../../core/memory/store.js";
import { HelperError, onLines } from "./helperClient.js";

export interface MemoryHelperOptions {
  executable: string;
  /** Arguments before the helper's own (a test runs a script under Node). */
  args?: readonly string[];
  /** Memory's folder, this app's alone: the database, the embedding model and the helper's logs go
   * in it. */
  directory: string;
  idleTimeout?: number;
  initTimeout?: number;
  requestTimeout?: number;
}

interface Pending {
  method: string;
  /** The helper it was written to: only its exit fails it. */
  child: ChildProcessWithoutNullStreams;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Memory's folder's layout: the helper's database folder (`profilePath`; it keeps the database at
 * `tabmail_fts/memory.db` in it), its model and its logs. */
export function memoryFolders(directory: string): { database: string; models: string; logs: string; databaseFile: string } {
  const database = join(directory, "database");
  return { database, models: join(directory, "models"), logs: join(directory, "logs"), databaseFile: join(database, "tabmail_fts", "memory.db") };
}

/** The size of a native-messaging message's length prefix (bytes). */
const lengthPrefix = 4;

/**
 * Memory kept by `voice-memory`, Thunderbird's search helper (`tabmail-native-fts`) built for this
 * app from its repository at the revision `native/memory/native-fts.json` pins (ADR-DESK-060). It
 * speaks Thunderbird's native messaging: each message a 4-byte little-endian length, then that much
 * JSON; requests `{"id", "method", "params"}`, replies `{"id", "result"}` or `{"id", "error"}`, by
 * id. It starts when memory is first used, is told where everything goes (`init`), and ends after
 * `idleTimeout` with nothing asked: closing its stdin ends it. It is never asked to update itself:
 * the app ships the build it runs.
 */
export class MemoryHelper implements AgentMemory {
  private child: ChildProcessWithoutNullStreams | null = null;
  /** The running helper's `init`: every request waits for it. */
  private initialized: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextID = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: MemoryHelperOptions) {}

  prepare(): void {
    this.started().catch((error: unknown) => log.error(`MemoryHelper: couldn't start: ${errorName(error)}`));
  }

  async index(rows: readonly MemoryRow[], maxBytes: number): Promise<void> {
    await this.request("memoryIndexBatch", { rows, maxBytes });
  }

  async search({ query, from, to, limit }: MemorySearch): Promise<MemoryHit[]> {
    return hits(await this.request("memorySearch", { q: query, from, to, limit, ignoreDate: from === "" && to === "" }), "memorySearch");
  }

  async read(timestampMs: number, toleranceMs: number): Promise<MemoryHit[]> {
    return hits(await this.request("memoryRead", { timestampMs, toleranceMs }), "memoryRead");
  }

  async stats(): Promise<MemoryStats> {
    const result = await this.request("memoryStats", {});
    const fields = isObject(result) ? result : {};
    if (typeof fields.docs !== "number" || typeof fields.usedBytes !== "number") throw new HelperError("failed", "memoryStats", "unexpected reply");
    return { docs: fields.docs, usedBytes: fields.usedBytes };
  }

  async trim(maxBytes: number): Promise<MemoryTrim> {
    const result = await this.request("memoryTrim", { maxBytes });
    if (!isObject(result) || typeof result.trimmed !== "number" || typeof result.withinLimit !== "boolean") {
      throw new HelperError("failed", "memoryTrim", "unexpected reply");
    }
    return { removed: result.trimmed, withinLimit: result.withinLimit };
  }

  async remove(memIDs: readonly string[]): Promise<number> {
    const result = await this.request("memoryRemoveBatch", { ids: memIDs });
    return isObject(result) && typeof result.count === "number" ? result.count : 0;
  }

  async clear(): Promise<void> {
    await this.request("memoryClear", {});
  }

  /** Ends the helper for good (the app quits): closing its stdin ends it once its work under way is
   * written. */
  stop(): void {
    this.stopped = true;
    this.end();
  }

  /** Asks the running helper, started and initialized first if it isn't. */
  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.cancelIdle();
    try {
      await this.started();
      return await this.send(method, params, this.options.requestTimeout ?? config.memoryRequestTimeout);
    } finally {
      this.idleSoon();
    }
  }

  /** The running helper's `init`, starting the helper if none runs. A failed start ends the helper,
   * so the next request starts afresh. */
  private started(): Promise<void> {
    if (this.stopped) return Promise.reject(new HelperError("exited", "init"));
    if (this.initialized !== null) return this.initialized;
    const { database, models, logs } = memoryFolders(this.options.directory);
    for (const folder of [database, models, logs]) mkdirSync(folder, { recursive: true });
    this.launch(logs);
    const initialized = this.send("init", { profilePath: database, modelDir: models }, this.options.initTimeout ?? config.memoryInitTimeout).then(
      () => log.debug("MemoryHelper: ready"),
      (error: unknown) => {
        if (this.initialized === initialized) this.end();
        throw error;
      },
    );
    this.initialized = initialized;
    this.idleSoon();
    return initialized;
  }

  private launch(logs: string): void {
    const child = spawn(this.options.executable, [...(this.options.args ?? []), "--log-dir", logs], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    log.debug("MemoryHelper: started");
    let buffered = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= lengthPrefix) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < lengthPrefix + length) break;
        const body = buffered.subarray(lengthPrefix, lengthPrefix + length).toString("utf8");
        buffered = buffered.subarray(lengthPrefix + length);
        this.receive(body);
      }
    });
    // Its warnings may name what it was asked: the debug log file only.
    onLines(child.stderr, (line) => log.content("voice-memory", line));
    // A failed spawn (a missing executable) reports here only, with no exit: its requests fail now
    // rather than at their timeouts, and the next request tries again.
    child.on("error", (error) => {
      log.error(`voice-memory: could not run: ${error.name}`);
      this.ended(child);
    });
    child.stdin.on("error", () => {});
    child.on("exit", (code, signal) => {
      log.debug(`MemoryHelper: ended (${signal ?? code})`);
      this.ended(child);
    });
  }

  private send(method: string, params: Record<string, unknown>, timeout: number): Promise<unknown> {
    const child = this.child;
    if (child === null) return Promise.reject(new HelperError("exited", method));
    const id = String(this.nextID);
    this.nextID += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError("timeout", method));
      }, timeout);
      this.pending.set(id, { method, child, resolve, reject, timer });
      const body = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
      const prefix = Buffer.alloc(lengthPrefix);
      prefix.writeUInt32LE(body.length, 0);
      child.stdin.write(Buffer.concat([prefix, body]));
    });
  }

  private receive(body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      log.error("MemoryHelper: a reply that isn't JSON");
      return;
    }
    if (!isObject(message) || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined && message.error !== null) pending.reject(new HelperError("failed", pending.method, String(message.error)));
    else pending.resolve(message.result);
  }

  /** The helper ends `idleTimeout` after its last request, unless one is under way. */
  private idleSoon(): void {
    this.cancelIdle();
    if (this.child === null || this.stopped) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size > 0) return this.idleSoon();
      log.debug("MemoryHelper: idle; ending it");
      this.end();
    }, this.options.idleTimeout ?? config.memoryHelperIdleTimeout);
  }

  private cancelIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Ends the running helper by closing its stdin; its requests fail as `exited`. */
  private end(): void {
    this.cancelIdle();
    const child = this.child;
    this.child = null;
    this.initialized = null;
    if (child === null) return;
    child.stdin.end();
    this.failPending(child);
  }

  /** `child` ended, or never started: its requests fail. */
  private ended(child: ChildProcessWithoutNullStreams): void {
    if (this.child === child) {
      this.child = null;
      this.initialized = null;
    }
    this.failPending(child);
  }

  /** Fails the requests written to `child`, which ended. */
  private failPending(child: ChildProcessWithoutNullStreams): void {
    for (const [id, pending] of this.pending) {
      if (pending.child !== child) continue;
      clearTimeout(pending.timer);
      pending.reject(new HelperError("exited", pending.method));
      this.pending.delete(id);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The exchanges a search or a read answered. */
function hits(result: unknown, method: string): MemoryHit[] {
  if (!Array.isArray(result)) throw new HelperError("failed", method, "unexpected reply");
  return result.flatMap((item: unknown) =>
    isObject(item) && typeof item.content === "string"
      ? [{ memId: typeof item.memId === "string" ? item.memId : "", content: item.content, snippet: typeof item.snippet === "string" ? item.snippet : null, dateMs: typeof item.dateMs === "number" ? item.dateMs : 0 }]
      : [],
  );
}
