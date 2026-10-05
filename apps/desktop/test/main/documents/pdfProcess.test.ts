// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const electron = vi.hoisted(() => ({ fork: vi.fn(), metrics: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: { fork: electron.fork }, app: { getAppMetrics: electron.metrics } }));
import { documentMaxBytes, pdfProcessMemoryKiB, pdfProcessPollInterval, pdfProcessTimeout, pdfRedactionContext } from "../../../src/core/config.js";
import { parsePDF } from "../../../src/main/documents/pdfProcess.js";

let alive: boolean;
let child: EventEmitter & { pid: number | undefined; kill: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };
const range = { startPage: 1, pageCount: 1 };
const result = { totalPages: 1, pages: [{ number: 1, text: "synthetic" }], nextPage: null, truncated: false, before: "", after: "" };
beforeEach(() => {
  vi.useFakeTimers();
  alive = false;
  child = Object.assign(new EventEmitter(), {
    pid: undefined as number | undefined,
    kill: vi.fn(() => {
      if (child.pid === undefined) return false;
      alive = false;
      child.pid = undefined;
      return true;
    }),
    postMessage: vi.fn(),
  });
  electron.fork.mockReturnValue(child);
  electron.metrics.mockReturnValue([{ pid: 123, memory: { workingSetSize: 1024 } }]);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function spawn() {
  child.pid = 123;
  alive = true;
  child.emit("spawn");
}

function start() {
  const abort = new AbortController();
  const promise = parsePDF(new Uint8Array([1]), range, abort.signal);
  spawn();
  return { promise, abort };
}

test("uses a disposable process with suppressed logs and bounded heap", async () => {
  const { promise } = start();
  expect(electron.fork.mock.calls[0]?.[2]).toMatchObject({ stdio: "ignore", execArgv: ["--max-old-space-size=256"] });
  expect(child.postMessage).toHaveBeenCalledWith({ bytes: new Uint8Array([1]), range });
  child.emit("message", { ok: true, result });
  expect(await promise).toEqual(result);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["timeout", "memory", "cancel", "exit", "monitor"])("terminates on %s", async (reason) => {
  const { promise, abort } = start();
  const rejected = expect(promise).rejects.toThrow();
  if (reason === "timeout") await vi.advanceTimersByTimeAsync(pdfProcessTimeout);
  if (reason === "memory") {
    electron.metrics.mockReturnValue([{ pid: 123, memory: { workingSetSize: pdfProcessMemoryKiB + 1 } }]);
    await vi.advanceTimersByTimeAsync(pdfProcessPollInterval);
  }
  if (reason === "cancel") abort.abort();
  if (reason === "exit") child.emit("exit", 1);
  if (reason === "monitor") {
    electron.metrics.mockImplementationOnce(() => { throw new Error("unavailable"); });
    await vi.advanceTimersByTimeAsync(pdfProcessPollInterval);
  }
  await rejected;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  child.emit("message", { ok: true, result });
  expect(child.kill).toHaveBeenCalledOnce();
});

test.each([null, { ok: true, result: { ...result, pages: [{ number: 1, text: "a".repeat(65537) }] } }, { ok: true, result: { ...result, nextPage: 7 } }, { ok: false, reason: "private parser details" }])("refuses invalid or failed IPC without exposing parser details", async (message) => {
  const { promise } = start();
  child.emit("message", message);
  await expect(promise).rejects.toThrow(/^(?:This )?PDF /u);
  expect(child.kill).toHaveBeenCalledOnce();
});

/** The parser of hostile bytes gets none of the app's environment: only what Windows needs to run. */
test("the worker starts with an empty environment", () => {
  void start().promise.catch(() => {});
  const expected = process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  expect(electron.fork.mock.calls[0]?.[2]?.env).toEqual(expected);
});

test("input past the file size limit starts no process", async () => {
  await expect(parsePDF(new Uint8Array(documentMaxBytes + 1), range, new AbortController().signal)).rejects.toThrow("exceeds the file size limit");
  expect(electron.fork).not.toHaveBeenCalled();
});

test("pre-canceled input starts no process", async () => {
  const abort = new AbortController(); abort.abort();
  await expect(parsePDF(new Uint8Array([1]), range, abort.signal)).rejects.toThrow();
  expect(electron.fork).not.toHaveBeenCalled();
});


test.each(["cancel", "timeout", "monitor"])("a worker spawned after %s does not survive or receive document bytes", async (reason) => {
  const abort = new AbortController();
  const pending = parsePDF(new Uint8Array([1]), range, abort.signal);
  const rejected = expect(pending).rejects.toThrow();
  if (reason === "cancel") abort.abort();
  if (reason === "timeout") await vi.advanceTimersByTimeAsync(pdfProcessTimeout);
  if (reason === "monitor") {
    electron.metrics.mockImplementationOnce(() => { throw new Error("unavailable"); });
    await vi.advanceTimersByTimeAsync(pdfProcessPollInterval);
  }
  await rejected;
  expect(child.kill.mock.results[0]?.value).toBe(false);
  spawn();
  expect(alive).toBe(false);
  expect(child.postMessage).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("an active worker receives approved bytes, returns text, and terminates", async () => {
  const pending = parsePDF(new Uint8Array([1]), range, new AbortController().signal);
  spawn();
  expect(alive).toBe(true);
  expect(child.postMessage).toHaveBeenCalledWith({ bytes: new Uint8Array([1]), range });
  child.emit("message", { ok: true, result });
  expect(await pending).toEqual(result);
  expect(alive).toBe(false);
});

/** The worker's reason reaches the agent: a password-protected PDF says so, not "could not be read". */
test("a password refusal from the worker is reported as one", async () => {
  const { promise } = start();
  child.emit("message", { ok: false, reason: "password" });
  await expect(promise).rejects.toThrow(/^This PDF requires a password\.$/u);
});

/** The worker has just parsed a hostile file: its pages must be the ones asked for, in order. */
test.each([
  ["a page out of sequence", { startPage: 1, pageCount: 2 }, { totalPages: 3, pages: [{ number: 1, text: "a" }, { number: 3, text: "b" }], nextPage: 3, truncated: false, before: "", after: "" }],
  ["a first page that wasn't asked for", { startPage: 2, pageCount: 1 }, { totalPages: 3, pages: [{ number: 1, text: "a" }], nextPage: 3, truncated: false, before: "", after: "" }],
  ["more pages than asked for", { startPage: 1, pageCount: 1 }, { totalPages: 3, pages: [{ number: 1, text: "a" }, { number: 2, text: "b" }], nextPage: 3, truncated: false, before: "", after: "" }],
  ["a page past the PDF's end", { startPage: 1, pageCount: 2 }, { totalPages: 1, pages: [{ number: 1, text: "a" }, { number: 2, text: "b" }], nextPage: null, truncated: false, before: "", after: "" }],
  ["no pages within the PDF", { startPage: 1, pageCount: 1 }, { totalPages: 3, pages: [], nextPage: null, truncated: false, before: "", after: "" }],
  ["no pages past the end, but a next page", { startPage: 5, pageCount: 1 }, { totalPages: 3, pages: [], nextPage: 6, truncated: false, before: "", after: "" }],
])("refuses a worker reply with %s", async (_name, asked, reply) => {
  const pending = parsePDF(new Uint8Array([1]), asked, new AbortController().signal);
  spawn();
  child.emit("message", { ok: true, result: reply });
  await expect(pending).rejects.toThrow(/^This PDF could not be read\.$/u);
});

test("accepts no pages for a start past the PDF's end", async () => {
  const pending = parsePDF(new Uint8Array([1]), { startPage: 5, pageCount: 1 }, new AbortController().signal);
  spawn();
  const reply = { totalPages: 3, pages: [], nextPage: null, truncated: false, before: "", after: "" };
  child.emit("message", { ok: true, result: reply });
  expect(await pending).toEqual(reply);
});

/** The redactor's context is bounded too: a hostile worker cannot make it the bulk of a reply. */
test.each([
  ["no context", { before: undefined, after: "" }],
  ["context that is not text", { before: "", after: 1 }],
  ["context past its limit", { before: "a".repeat(pdfRedactionContext + 3), after: "" }],
])("refuses a worker reply with %s", async (_name, context) => {
  const pending = parsePDF(new Uint8Array([1]), range, new AbortController().signal);
  spawn();
  child.emit("message", { ok: true, result: { ...result, ...context } });
  await expect(pending).rejects.toThrow(/^This PDF could not be read\.$/u);
});

test("accepts context at its limit, joined to the range by a blank line", async () => {
  const pending = parsePDF(new Uint8Array([1]), range, new AbortController().signal);
  spawn();
  const reply = { ...result, before: `${"a".repeat(pdfRedactionContext)}\n\n`, after: `\n\n${"b".repeat(pdfRedactionContext)}` };
  child.emit("message", { ok: true, result: reply });
  expect(await pending).toEqual(reply);
});
