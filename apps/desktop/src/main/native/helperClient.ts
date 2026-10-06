// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as config from "../../core/config.js";
import { log } from "../../core/log.js";
import { CancellationError } from "../../core/util/timeout.js";

export type HelperErrorKind = "timeout" | "exited" | "failed";

/** A helper request that got no result: it timed out, the helper exited first, or the helper
 * answered with an error. The helper's error message is not shown: it is for the log. */
export class HelperError extends Error {
  constructor(
    readonly kind: HelperErrorKind,
    readonly method: string,
    /** For `failed`: the helper's message, which names the problem, never user content. */
    readonly helperMessage?: string,
  ) {
    super("Something went wrong. Try again.");
    this.name = "HelperError";
  }

  get description(): string {
    return `HelperError.${this.kind}(${this.method}${this.helperMessage ? `: ${this.helperMessage}` : ""})`;
  }
}

export interface HelperOptions {
  /** For the log. */
  name: string;
  executable: string;
  args?: string[];
  requestTimeout?: number;
  restartDelay?: number;
  /** The helper exits with this code to be started afresh: it is then restarted at once, and the
   * exit is not an error. */
  restartExitCode?: number;
  /** Helper implements fire-and-forget cancel requests for queued native mutations. */
  cancelRequests?: boolean;
  /** The helper holds nothing to clean up (the screen reader): `stop` ends it at once rather than
   * closing its stdin, so work under way can't outlive the app. */
  stopEndsAtOnce?: boolean;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  drop?: () => void;
}

/**
 * The app's side of a native helper's pipe (`HelperChannel` in the helper): requests
 * `{"id", "method", "params"}` one a line on its stdin; replies `{"id", "result"}` or
 * `{"id", "error": {"message"}}` and events `{"event", ...}` one a line on its stdout; its stderr
 * lines (`debug …`, `error …`) go to the app's log. A helper that exits is started again after
 * `restartDelay` (at once when it exits with `restartExitCode`), and `onStart` runs each time it
 * starts, so it can be configured afresh.
 */
export class HelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextID = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Map<string, (message: Record<string, unknown>) => void>();
  private stopped = true;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Requests made while the helper restarts, written to it once it has; `drop` stops listening for
   * the request's cancellation. */
  private waiting: { id: number; line: string; drop: () => void }[] = [];
  /** Runs each time the helper starts, the first time included. */
  onStart: (() => void) | undefined;
  /** Runs each time the helper exits unasked (it is then started again). */
  onExit: (() => void) | undefined;

  constructor(private readonly options: HelperOptions) {}

  start(): void {
    this.stopped = false;
    this.launch();
  }

  /** Stops the helper for good: closing its stdin ends it (`stopEndsAtOnce`: it is killed). */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.options.stopEndsAtOnce) this.child?.kill("SIGKILL");
    else this.child?.stdin.end();
    this.child = null;
    this.failPending("exited");
  }

  /** Ends the running helper at once, whatever it is doing, and starts it afresh; its requests
   * fail as `exited`. */
  restart(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.failPending("exited");
    child.kill("SIGKILL");
    this.launch();
  }

  /** Runs `handler` for each `event` the helper sends. */
  on(event: string, handler: (message: Record<string, unknown>) => void): void {
    this.eventHandlers.set(event, handler);
  }

  /** Asks the helper; rejects with `HelperError` when it answers with an error, takes longer than
   * `timeout`, or is not running. A request given its operation's `signal` waits instead while the
   * helper restarts (within `timeout`), so what a crash sets off (sending what was said, then pasting
   * it) still reaches the helper; if the signal aborts first it is never sent and rejects with a
   * `CancellationError`. With `cancelRequests`, aborts and timeouts also notify the native helper
   * after writing; it must check cancellation before committing its mutation. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeout = this.options.requestTimeout ?? config.helperRequestTimeout, signal?: AbortSignal): Promise<T> {
    const child = this.child;
    if (!child && (this.restartTimer === null || signal === undefined)) return Promise.reject(new HelperError("exited", method));
    if (signal?.aborted) return Promise.reject(new CancellationError());
    const id = this.nextID;
    this.nextID += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.get(id)?.drop?.();
        this.pending.delete(id);
        if (this.options.cancelRequests) this.cancelWritten(id);
        reject(new HelperError("timeout", method));
      }, timeout);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      const line = `${JSON.stringify({ id, method, params })}\n`;
      const cancel = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.drop?.();
        this.pending.delete(id);
        clearTimeout(timer);
        if (this.options.cancelRequests) this.cancelWritten(id);
        reject(new CancellationError());
      };
      const drop = () => signal?.removeEventListener("abort", cancel);
      if (signal && (this.options.cancelRequests || !child)) {
        signal.addEventListener("abort", cancel, { once: true });
        if (this.options.cancelRequests) {
          const pending = this.pending.get(id);
          if (pending) pending.drop = drop;
        }
      }
      if (child) child.stdin.write(line);
      else if (signal) this.waiting.push({ id, line, drop: this.options.cancelRequests ? () => {} : drop });
    });
  }

  private cancelWritten(id: number): void {
    this.child?.stdin.write(`${JSON.stringify({ method: "cancel", params: { id } })}\n`);
  }

  private launch(): void {
    const { name, executable, args = [] } = this.options;
    // The Windows helpers are console programs. Electron already starts every child with its console
    // hidden; `windowsHide` makes that explicit, as at the app's other launch sites, and hides it
    // under plain Node too (the native test scripts).
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
    // Those that timed out or were canceled while it restarted are dropped: their callers have
    // given up. Once written, a request goes through.
    for (const { id, line, drop } of this.waiting.splice(0)) {
      drop();
      if (this.pending.has(id)) child.stdin.write(line);
    }
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.failPending("exited");
      if (this.stopped) return;
      if (code !== null && code === this.options.restartExitCode) {
        log.debug(`${name}: exited to start afresh`);
        this.launch();
      } else {
        log.error(`${name}: exited (${signal ?? code}); restarting`);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.stopped) this.launch();
        }, this.options.restartDelay ?? config.helperRestartDelay);
      }
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
    pending.drop?.();
    const error = message.error as { message?: unknown } | undefined;
    if (error) pending.reject(new HelperError("failed", pending.method, typeof error.message === "string" ? error.message : undefined));
    else pending.resolve(message.result ?? null);
  }

  private failPending(kind: HelperErrorKind): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.drop?.();
      this.pending.delete(id);
      pending.reject(new HelperError(kind, pending.method));
    }
  }
}
