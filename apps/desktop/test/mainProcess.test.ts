// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configureLog } from "../src/core/log.js";
import { CancellationError } from "../src/core/timeout.js";
import { FileStore } from "../src/main/fileStore.js";
import { HelperClient, HelperFailure } from "../src/main/helperClient.js";
import { LogFile } from "../src/main/logFile.js";
import { eventually } from "./support.js";

const folders: string[] = [];
function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"));
  folders.push(folder);
  return folder;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
});

/** The debug log file, written in a scratch folder: lines are appended in order, and a file past its
 * size limit is moved aside (replacing the earlier one) before the next line starts a new file. */
describe("LogFile", () => {
  test("appends lines in order, creating the folder", async () => {
    const path = join(scratch(), "Logs/Test.log");
    await LogFile.write("one\n", path, 1_000);
    await LogFile.write("two\n", path, 1_000);
    expect(read(path)).toBe("one\ntwo\n");
  });

  test("a full file is moved aside and a new one started", async () => {
    const path = join(scratch(), "Logs/Test.log");
    const previous = LogFile.previousPath(path);
    expect(previous.endsWith("/Logs/Test.1.log")).toBe(true);
    await LogFile.write("0123456789\n", path, 10);
    await LogFile.write("second\n", path, 10);
    expect(read(previous)).toBe("0123456789\n");
    expect(read(path)).toBe("second\n");
    // Within the limit nothing moves; past it again, the earlier file is replaced.
    await LogFile.write("third\n", path, 10);
    expect(read(path)).toBe("second\nthird\n");
    await LogFile.write("fourth\n", path, 10);
    expect(read(previous)).toBe("second\nthird\n");
    expect(read(path)).toBe("fourth\n");
  });

  /** Each line carries its time and level, in the order appended. */
  test("appended lines are stamped and kept in order", async () => {
    const file = new LogFile(join(scratch(), "Test.log"), 1_000_000);
    for (let index = 0; index < 20; index += 1) file.append("debug", `line ${index}`);
    file.append("ERROR", "last");
    await file.flush();
    const lines = (read(file.path) ?? "").trimEnd().split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2}) debug line 0$/);
    expect(lines.map((line) => line.split(" ").slice(2).join(" "))).toEqual([...Array.from({ length: 20 }, (_, index) => `line ${index}`), "last"]);
  });
});

describe("FileStore", () => {
  test("values are kept across launches", () => {
    const path = join(scratch(), "Preferences/settings.json");
    const store = new FileStore(path);
    store.set("dictationHotkey", "function");
    store.set("tip.switchMode.displays", 3);
    store.set("gone", true);
    store.remove("gone");

    const relaunched = new FileStore(path);
    expect(relaunched.get("dictationHotkey")).toBe("function");
    expect(relaunched.get("tip.switchMode.displays")).toBe(3);
    expect(relaunched.get("gone")).toBeUndefined();
  });

  test.each(["not json", "[1, 2]", "null"])("an unreadable file (%j) starts empty", (contents) => {
    const path = join(scratch(), "settings.json");
    writeFileSync(path, contents);
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => errors.push(text) } });

    const store = new FileStore(path);
    expect(store.snapshot()).toEqual({});
    expect(errors).toEqual(["FileStore: unreadable preferences file; starting empty"]);
    store.set("readsScreen", false);
    expect(new FileStore(path).get("readsScreen")).toBe(false);
  });
});

/** The app's side of a helper's pipe, against a stand-in helper run by Node. */
describe("HelperClient", () => {
  const fakeHelper = join(__dirname, "fixtures/fakeHelper.mjs");
  const clients: HelperClient[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.stop();
  });

  function helper(options: { requestTimeout?: number; restartDelay?: number } = {}): HelperClient {
    const client = new HelperClient({ name: "fake-helper", executable: process.execPath, args: [fakeHelper], ...options });
    clients.push(client);
    client.start();
    return client;
  }

  async function failure(promise: Promise<unknown>): Promise<HelperFailure> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HelperFailure) return error;
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
    expect(error.description).toBe("HelperFailure.failed(fail: fail needs nothing)");
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

  /** One whose caller gave up while it waited, timed out or cancelled (a dictation cancelled after
   * its paste was asked for), is never sent, so the helper never acts on it; one already cancelled
   * isn't taken; and stopping fails whatever still waits. */
  test("a request given up while the helper restarts is never sent", async () => {
    const client = helper({ restartDelay: 150 });
    const actions: unknown[] = [];
    client.on("action", (message) => actions.push(message.action));
    await failure(client.request("exit"));

    const operation = new AbortController();
    expect((await failure(client.request("emit", { action: "timed out" }, 30, operation.signal))).kind).toBe("timeout");
    const cancelled = client.request("emit", { action: "cancelled" }, undefined, operation.signal);
    operation.abort();
    await expect(cancelled).rejects.toBeInstanceOf(CancellationError);
    await expect(client.request("emit", { action: "already cancelled" }, undefined, operation.signal)).rejects.toBeInstanceOf(CancellationError);
    await client.request("echo", {}, undefined, new AbortController().signal);
    expect(actions).toEqual([]);

    await failure(client.request("exit"));
    const waiting = client.request("echo", {}, undefined, new AbortController().signal);
    client.stop();
    expect((await failure(waiting)).kind).toBe("exited");
  });

  /** Written to the restarted helper, a request is the helper's to carry out: cancelling it then
   * changes nothing, and it ends as any written request does (here, unanswered, in its timeout). */
  test("a request cancelled once written to the restarted helper is not called off", async () => {
    const client = helper({ restartDelay: 50 });
    await failure(client.request("exit"));
    const operation = new AbortController();
    const written = client.request("silent", {}, 200, operation.signal);
    await client.request("echo", {}, undefined, new AbortController().signal);

    operation.abort();
    expect((await failure(written)).kind).toBe("timeout");
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
