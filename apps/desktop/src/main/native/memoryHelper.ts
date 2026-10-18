// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as config from "../../core/config.js";
import { errorName, isDebugLogging, log } from "../../core/log.js";
import { type AgentMemory, type MemoryHit, MemoryError, type MemoryRow, type MemorySearch, type MemoryStats, type MemoryTrim } from "../../core/memory/store.js";
import { HelperError, onLines } from "./helperClient.js";

export interface MemoryHelperOptions {
  executable: string;
  /** Arguments before the helper's own (a test runs a script under Node). */
  args?: readonly string[];
  /** Memory's folder, this app's alone: the database, the embedding model and the helper's logs go
   * in it. */
  directory: string;
  idleTimeout?: number;
  exitTimeout?: number;
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

/** Memory's folder's layout: the helper's database folder (`profilePath`; it keeps its databases in
 * `tabmail_fts` there, memory's at `tabmail_fts/memory.db`), its model and its logs. */
export function memoryFolders(directory: string): { database: string; databases: string; models: string; logs: string; databaseFile: string } {
  const database = join(directory, "database");
  const databases = join(database, "tabmail_fts");
  return { database, databases, models: join(directory, "models"), logs: join(directory, "logs"), databaseFile: join(databases, "memory.db") };
}

/** The size of a native-messaging message's length prefix (bytes). */
const lengthPrefix = 4;

/**
 * Memory kept by `voice-memory`, Thunderbird's search helper (`tabmail-native-fts`) built for this
 * app from its repository at the revision `native/memory/native-fts.json` pins (ADR-DESK-060). It
 * speaks Thunderbird's native messaging: each message a 4-byte little-endian length, then that much
 * JSON; requests `{"id", "method", "params"}`, replies `{"id", "result"}` or `{"id", "error"}`, by
 * id. It starts when memory is first used, is told where everything goes (`init`; it makes the
 * folders), and ends after `idleTimeout` with nothing asked, once its embedding model has loaded:
 * closing its stdin ends it. Its `init` downloads the model when it isn't there yet, so one that
 * started without it is kept until the app quits, trying once per run as Thunderbird's does, rather
 * than downloading again at every start. It is never asked to update itself:
 * the app ships the build it runs. It writes its own log file, which can hold what memory was asked,
 * only while debug logging is on (as the app's debug log), decided when it starts.
 */
export class MemoryHelper implements AgentMemory {
  private child: ChildProcessWithoutNullStreams | null = null;
  /** The running helper's `init`: every request waits for it. */
  private initialized: Promise<void> | null = null;
  /** Whether the running helper ends when idle: once its `init` said the model loaded. */
  private endsWhenIdle = false;
  private readonly pending = new Map<string, Pending>();
  private nextID = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Every helper started that hasn't exited yet, and its exit: one ended may still be writing. */
  private readonly running = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  /** Clear All under way: requests wait for it, so none reaches a helper on the files it deletes. */
  private clearing: Promise<void> | null = null;

  constructor(private readonly options: MemoryHelperOptions) {}

  prepare(): void {
    if (this.clearing !== null) return;
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

  /** Removes everything memory holds by deleting its database, with the helper ended first: the
   * helper's own `memoryClear` deletes the files while its other connection holds them open, which
   * Windows refuses, and it still answers ok. The helper's logs go too. The next request starts a
   * helper on an empty database. */
  clear(): Promise<void> {
    if (this.clearing === null) {
      this.clearing = this.deleteAll().finally(() => {
        this.clearing = null;
      });
    }
    return this.clearing;
  }

  private async deleteAll(): Promise<void> {
    this.end();
    await this.exits();
    const { databases, logs } = memoryFolders(this.options.directory);
    rmSync(databases, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
    log.debug("MemoryHelper: cleared");
  }

  /** Waits for every helper started to exit, ending outright one still running `exitTimeout` after
   * its stdin closed. */
  private async exits(): Promise<void> {
    await Promise.all(
      [...this.running].map(async ([child, exited]) => {
        const timer = setTimeout(() => {
          log.error("MemoryHelper: still running after its stdin closed; ending it");
          child.kill();
        }, this.options.exitTimeout ?? config.memoryHelperExitTimeout);
        await exited;
        clearTimeout(timer);
      }),
    );
  }

  /** Ends the helper for good (the app quits): closing its stdin ends it once its work under way is
   * written. */
  stop(): void {
    this.stopped = true;
    this.end();
  }

  /** Asks the running helper, started and initialized first if it isn't. */
  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    while (this.clearing !== null) await this.clearing.catch(() => undefined);
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
    try {
      this.launch(logs);
    } catch (error) {
      // Spawning throws for what Node doesn't report as an `error` event (out of memory, too long an
      // argument list; a missing executable or too many open files are `error` events, below):
      // memory is unavailable, and the request fails as any failed start does, naming no path.
      log.error(`MemoryHelper: couldn't run: ${errorName(error)}`);
      return Promise.reject(new HelperError("failed", "init"));
    }
    this.endsWhenIdle = false;
    const initialized = this.send("init", { profilePath: database, modelDir: models }, this.options.initTimeout ?? config.memoryInitTimeout).then(
      (result: unknown) => {
        this.endsWhenIdle = isObject(result) && result.hasEmbeddings === true;
        log.debug(`MemoryHelper: ready (model ${this.endsWhenIdle ? "loaded" : "not loaded"})`);
        // An idle end that came while it was starting was skipped; the wait starts now.
        if (this.initialized === initialized) this.idleSoon();
      },
      (error: unknown) => {
        if (this.initialized === initialized) this.end();
        throw error;
      },
    );
    this.initialized = initialized;
    this.idleSoon();
    return initialized;
  }

  /** Starts a helper and makes it the running one. A spawn that throws starts none. */
  private launch(logs: string): void {
    // Its log names what memory was asked: kept only while debug logging is on, as the app's debug
    // log; "off" writes no log file anywhere.
    const level = isDebugLogging() ? "debug" : "off";
    const child = spawn(this.options.executable, [...(this.options.args ?? []), "--log-dir", logs, "--log-level", level], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    // A failed spawn (a missing executable) reports here only, with no exit: its requests fail now
    // rather than at their timeouts, and the next request tries again. Listened to first, so a
    // spawn that fails before its streams exist still reports here.
    child.on("error", (error) => {
      log.error(`voice-memory: could not run: ${error.name}`);
      this.ended(child);
    });
    this.running.set(
      child,
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      }).then(() => {
        this.running.delete(child);
      }),
    );
    this.listen(child);
    this.child = child;
    log.debug("MemoryHelper: started");
  }

  private listen(child: ChildProcessWithoutNullStreams): void {
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
    if (message.error !== undefined && message.error !== null) pending.reject(new MemoryError(pending.method, String(message.error)));
    else pending.resolve(message.result);
  }

  /** The helper ends `idleTimeout` after its last request, unless one is under way. */
  private idleSoon(): void {
    this.cancelIdle();
    if (this.child === null || this.stopped) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.endsWhenIdle) return;
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
