// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import { CancellationError } from "../../../src/core/util/timeout.js";
import { HelperClient, HelperError } from "../../../src/main/native/helperClient.js";
import { eventually } from "../../support/stubs.js";

afterEach(() => {
  configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
});

/** The app's side of a helper's pipe, against a stand-in helper run by Node. */
describe("HelperClient", () => {
  const fakeHelper = join(__dirname, "../../support/fakeHelper.mjs");
  const clients: HelperClient[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.stop();
  });

  function helper(options: { requestTimeout?: number; restartDelay?: number; restartExitCode?: number } = {}): HelperClient {
    const client = new HelperClient({ name: "fake-helper", executable: process.execPath, args: [fakeHelper], ...options });
    clients.push(client);
    client.start();
    return client;
  }

  async function failure(promise: Promise<unknown>): Promise<HelperError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HelperError) return error;
      throw error;
    }
    throw new Error("resolved");
  }

  test("answers requests, each with its own result, in any order", async () => {
    const client = helper();
    const results = await Promise.all([1, 2, 3].map((n) => client.request("echo", { n })));
    expect(results).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test("a helper's error is a failure naming it, for the log", async () => {
    const error = await failure(helper().request("fail"));
    expect(error.kind).toBe("failed");
    expect(error.description).toBe("HelperError.failed(fail: fail needs nothing)");
  });

  test("a request that gets no answer times out", async () => {
    const error = await failure(helper({ requestTimeout: 100 }).request("silent"));
    expect(error.kind).toBe("timeout");
  });

  test("events reach their handler", async () => {
    const client = helper();
    const actions: unknown[] = [];
    client.on("action", (message) => actions.push(message.action));
    await client.request("emit", { action: "start" });
    await client.request("emit", { action: "finish" });
    expect(actions).toEqual(["start", "finish"]);
  });

  /** Its stderr lines reach the app's log: debug lines in debug builds, errors always. */
  test("the helper's log lines go to the app's log", async () => {
    const file: string[] = [];
    const errors: string[] = [];
    configureLog({ isDebugBuild: true, sinks: { file: (level, text) => file.push(`${level} ${text}`), error: (text) => errors.push(text) } });
    await helper().request("log");
    expect(await eventually(() => errors.length === 1)).toBe(true);
    expect(errors).toEqual(["fake-helper: something failed"]);
    expect(file).toContain("debug fake-helper: something happened");
  });

  /** A helper that can't be spawned (no `voice-macos` off macOS) still runs `onStart`, once: the
   * app's launch-time setup (preparing the microphone) hangs off it. */
  test("a helper that can't be spawned still runs onStart once", async () => {
    const client = new HelperClient({ name: "fake-helper", executable: join(__dirname, "../../support/no-such-helper"), restartDelay: 50 });
    clients.push(client);
    let starts = 0;
    client.onStart = () => {
      starts += 1;
    };
    client.start();
    expect(starts).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(starts).toBe(1);
  });

  /** A helper that exits fails what was asked of it, and is started again, configured afresh. */
  test("an exited helper fails its requests and is restarted", async () => {
    const client = new HelperClient({ name: "fake-helper", executable: process.execPath, args: [fakeHelper], restartDelay: 50 });
    clients.push(client);
    let starts = 0;
    let exits = 0;
    client.onStart = () => {
      starts += 1;
    };
    client.onExit = () => {
      exits += 1;
    };
    client.start();
    const { pid } = await client.request<{ pid: number }>("pid");

    const silent = client.request("silent");
    const exit = client.request("exit");
    expect((await failure(silent)).kind).toBe("exited");
    expect((await failure(exit)).kind).toBe("exited");
    expect(await eventually(() => starts === 2)).toBe(true);
    expect(exits).toBe(1);
    const restarted = await client.request<{ pid: number }>("pid");
    expect(restarted.pid).not.toBe(pid);
  });

  /** A helper that exits with its `restartExitCode` asks to be started afresh (the microphone's,
   * when the input changes): it is started again at once, not after `restartDelay`, so a request
   * made on the exit goes to the new one without an operation's signal; `onExit` runs as for any
   * exit, and it is no error. Any other exit code waits out `restartDelay`. */
  test("a helper that exits with its restart code is started again at once, without an error", async () => {
    const errors: string[] = [];
    const file: string[] = [];
    configureLog({ isDebugBuild: true, sinks: { file: (level, text) => file.push(`${level} ${text}`), error: (text) => errors.push(text) } });
    const client = helper({ restartDelay: 60_000, restartExitCode: 75 });
    const { pid } = await client.request<{ pid: number }>("pid");
    let starts = 0;
    client.onStart = () => {
      starts += 1;
    };
    let onExit: Promise<{ pid: number }> | undefined;
    client.onExit = () => {
      onExit = client.request<{ pid: number }>("pid");
    };

    expect((await failure(client.request("exit", { code: 75 }))).kind).toBe("exited");
    expect(starts).toBe(1);
    expect((await onExit)?.pid).not.toBe(pid);
    expect(errors).toEqual([]);
    expect(file).toContain("debug fake-helper: exited to start afresh");

    client.onExit = undefined;
    expect((await failure(client.request("exit", { code: 3 }))).kind).toBe("exited");
    expect(starts).toBe(1);
    expect((await failure(client.request("pid"))).kind).toBe("exited");
    expect(errors).toEqual(["fake-helper: exited (3); restarting"]);
  });

  /** What a crash sets off reaches the restarted helper: a request made for an operation (with its
   * signal) on the exit, or while the helper restarts, waits for it (the paste of what was said after
   * the microphone is lost), and the restart is due before `onExit` runs, so a request made there
   * isn't refused. */
  test("an operation's request made while the helper restarts is answered by the restarted helper", async () => {
    const client = helper({ restartDelay: 100 });
    const { signal } = new AbortController();
    const { pid } = await client.request<{ pid: number }>("pid");
    let onExit: Promise<{ pid: number }> | undefined;
    client.onExit = () => {
      onExit = client.request<{ pid: number }>("pid", {}, undefined, signal);
    };

    expect((await failure(client.request("exit"))).kind).toBe("exited");
    const during = client.request<{ pid: number }>("pid", {}, undefined, signal);

    const [first, second] = await Promise.all([onExit, during]);
    expect(first?.pid).not.toBe(pid);
    expect(second.pid).toBe(first?.pid);
  });

  /** Any other request fails at once while the helper restarts, as when it isn't running: only an
   * operation that can be called off waits. */
  test("a request with no operation's signal fails at once while the helper restarts", async () => {
    const client = helper({ restartDelay: 100 });
    await failure(client.request("exit"));

    const started = Date.now();
    expect((await failure(client.request("echo"))).kind).toBe("exited");
    expect(Date.now() - started).toBeLessThan(100);
  });

  /** One whose caller gave up while it waited, timed out or canceled (a dictation canceled after
   * its paste was asked for), is never sent, so the helper never acts on it; one already canceled
   * isn't taken; and stopping fails whatever still waits. */
  test("a request given up while the helper restarts is never sent", async () => {
    const client = helper({ restartDelay: 150 });
    const actions: unknown[] = [];
    client.on("action", (message) => actions.push(message.action));
    await failure(client.request("exit"));

    const operation = new AbortController();
    expect((await failure(client.request("emit", { action: "timed out" }, 30, operation.signal))).kind).toBe("timeout");
    const canceled = client.request("emit", { action: "canceled" }, undefined, operation.signal);
    operation.abort();
    await expect(canceled).rejects.toBeInstanceOf(CancellationError);
    await expect(client.request("emit", { action: "already canceled" }, undefined, operation.signal)).rejects.toBeInstanceOf(CancellationError);
    await client.request("echo", {}, undefined, new AbortController().signal);
    expect(actions).toEqual([]);

    await failure(client.request("exit"));
    const waiting = client.request("echo", {}, undefined, new AbortController().signal);
    client.stop();
    expect((await failure(waiting)).kind).toBe("exited");
  });

  /** Written to the restarted helper, a request is the helper's to carry out: canceling it then
   * changes nothing, and it ends as any written request does (here, unanswered, in its timeout). */
  test("a request canceled once written to the restarted helper is not called off", async () => {
    const client = helper({ restartDelay: 50 });
    await failure(client.request("exit"));
    const operation = new AbortController();
    // Its timeout runs from the request, through the restart, so it is long enough to outlast a slow
    // one; its failure is caught from the start, so one that comes early is reported, not unhandled.
    let settled = false;
    const written = failure(client.request("silent", {}, 1_000, operation.signal)).finally(() => {
      settled = true;
    });
    await client.request("echo", {}, undefined, new AbortController().signal);

    expect(settled).toBe(false);
    operation.abort();
    expect((await written).kind).toBe("timeout");
  });

  test("a cancellable helper calls off a written mutation on abort and on timeout", async () => {
    const client = new HelperClient({ name: "fake-helper", executable: process.execPath, args: [fakeHelper], cancelRequests: true });
    clients.push(client);
    const queued: number[] = [], canceled: number[] = [], actions: unknown[] = [];
    client.on("queued", (message) => queued.push(message.request as number));
    client.on("canceled", (message) => canceled.push(message.request as number));
    client.on("action", (message) => actions.push(message.action));
    client.start();
    const operation = new AbortController();
    const written = client.request("deferred", { delay: 300, action: "aborted" }, 1000, operation.signal);
    const rejected = expect(written).rejects.toBeInstanceOf(CancellationError);
    expect(await eventually(() => queued.length === 1)).toBe(true);
    operation.abort();
    await rejected;
    expect((await failure(client.request("deferred", { delay: 300, action: "timed out" }, 100))).kind).toBe("timeout");
    expect(await eventually(() => canceled.length === 2)).toBe(true);
    expect(canceled).toEqual(queued);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(actions).toEqual([]);
    await client.request("deferred", { delay: 1, action: "completed" }, 1000);
    expect(actions).toEqual(["completed"]);
    expect(await client.request("echo", { recovery: true })).toEqual({ recovery: true });
  });

  test("a stopped helper is not restarted and answers nothing", async () => {
    const client = helper({ restartDelay: 10 });
    let exits = 0;
    client.onExit = () => {
      exits += 1;
    };
    await client.request("echo");
    client.stop();
    expect((await failure(client.request("echo"))).kind).toBe("exited");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await failure(client.request("echo"))).kind).toBe("exited");
    // An operation's request waits only for a restart that is due: stopped, or never started, the
    // helper refuses it at once too.
    const started = Date.now();
    expect((await failure(client.request("echo", {}, 1_000, new AbortController().signal))).kind).toBe("exited");
    const unstarted = new HelperClient({ name: "fake-helper", executable: process.execPath, args: [fakeHelper] });
    expect((await failure(unstarted.request("echo", {}, 1_000, new AbortController().signal))).kind).toBe("exited");
    expect(Date.now() - started).toBeLessThan(500);
    // Stopped when asked: no exit to report.
    expect(exits).toBe(0);
  });
});
