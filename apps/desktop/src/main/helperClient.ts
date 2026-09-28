// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as config from "../core/config.js";
import { log } from "../core/log.js";

export type HelperFailureKind = "timeout" | "exited" | "failed";

/** A helper request that got no result: it timed out, the helper exited first, or the helper
 * answered with an error. The helper's error message is not shown: it is for the log. */
export class HelperFailure extends Error {
  constructor(
    readonly kind: HelperFailureKind,
    readonly method: string,
    /** For `failed`: the helper's message, which names the problem, never user content. */
    readonly helperMessage?: string,
  ) {
    super("Something went wrong. Try again.");
    this.name = "HelperFailure";
  }

  get description(): string {
    return `HelperFailure.${this.kind}(${this.method}${this.helperMessage ? `: ${this.helperMessage}` : ""})`;
  }
}

export interface HelperOptions {
  /** For the log. */
  name: string;
  executable: string;
  args?: string[];
  /** Debug builds pass `TABMAIL_VOICE_DEBUG=1`, which turns the helper's debug lines on. */
  env?: NodeJS.ProcessEnv;
  requestTimeout?: number;
  restartDelay?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The app's side of a native helper's pipe (`HelperChannel` in the helper): requests
 * `{"id", "method", "params"}` one a line on its stdin; replies `{"id", "result"}` or
 * `{"id", "error": {"message"}}` and events `{"event", ...}` one a line on its stdout; its stderr
 * lines (`debug …`, `error …`) go to the app's log. A helper that exits is started again after
 * `restartDelay`, and `onStart` runs each time it starts, so it can be configured afresh.
 */
export class HelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextID = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Map<string, (message: Record<string, unknown>) => void>();
  private stopped = true;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Requests made while the helper restarts, written to it once it has. */
  private waiting: { id: number; line: string }[] = [];
  /** Runs each time the helper starts, the first time included. */
  onStart: (() => void) | undefined;
  /** Runs each time the helper exits unasked (it is then started again). */
  onExit: (() => void) | undefined;

  constructor(private readonly options: HelperOptions) {}

  start(): void {
    this.stopped = false;
    this.launch();
  }

  /** Stops the helper for good: closing its stdin ends it. */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.stdin.end();
    this.child = null;
    this.failPending("exited");
  }

  /** Runs `handler` for each `event` the helper sends. */
  on(event: string, handler: (message: Record<string, unknown>) => void): void {
    this.eventHandlers.set(event, handler);
  }

  /** Asks the helper; rejects with `HelperFailure` when it answers with an error, takes longer than
   * `timeout`, or is not running. While it restarts, the request waits for it (within `timeout`), so
   * what a crash sets off (sending what was said, then pasting it) still reaches the helper. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeout = this.options.requestTimeout ?? config.helperRequestTimeout): Promise<T> {
    const child = this.child;
    if (!child && this.restartTimer === null) return Promise.reject(new HelperFailure("exited", method));
    const id = this.nextID;
    this.nextID += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperFailure("timeout", method));
      }, timeout);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      const line = `${JSON.stringify({ id, method, params })}\n`;
      if (child) child.stdin.write(line);
      else this.waiting.push({ id, line });
    });
  }

  private launch(): void {
    const { name, executable, args = [], env } = this.options;
    const child = spawn(executable, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.startsWith("error ")) log.error(`${name}: ${line.slice("error ".length)}`);
      else log.debug(`${name}: ${line.startsWith("debug ") ? line.slice("debug ".length) : line}`);
    });
    // A failed spawn (a missing executable) reports here only: Node sends no exit for it, so the
    // helper isn't restarted (it would fail the same way) and its requests time out.
    child.on("error", (error) => log.error(`${name}: could not run: ${error.name}`));
    child.stdin.on("error", () => {});
    // Those that timed out while it restarted are dropped: their callers have given up.
    for (const { id, line } of this.waiting.splice(0)) if (this.pending.has(id)) child.stdin.write(line);
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.failPending("exited");
      if (this.stopped) return;
      log.error(`${name}: exited (${signal ?? code}); restarting`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.stopped) this.launch();
      }, this.options.restartDelay ?? config.helperRestartDelay);
      // After the restart is due, so nothing the exit sets off can keep the helper down.
      this.onExit?.();
    });
    log.debug(`${name}: started`);
    this.onStart?.();
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") return;
      message = parsed as Record<string, unknown>;
    } catch {
      log.error(`${this.options.name}: unreadable line (${line.length} chars)`);
      return;
    }
    if (typeof message.event === "string") {
      this.eventHandlers.get(message.event)?.(message);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    const error = message.error as { message?: unknown } | undefined;
    if (error) pending.reject(new HelperFailure("failed", pending.method, typeof error.message === "string" ? error.message : undefined));
    else pending.resolve(message.result ?? null);
  }

  private failPending(kind: HelperFailureKind): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new HelperFailure(kind, pending.method));
    }
  }
}
