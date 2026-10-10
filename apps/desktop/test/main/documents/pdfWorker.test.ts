// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EventEmitter } from "node:events";
import { afterAll, afterEach, expect, test, vi } from "vitest";

const realm = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock("../../../src/main/documents/pdfRealm.js", () => ({ extractPDFInRealm: realm.extract }));

const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
const original = { parentPort: (process as { parentPort?: unknown }).parentPort, fetch: globalThis.fetch };
// The worker's timer outlives its reply, as in its process until the parent kills it: ended here.
const intervals = vi.spyOn(globalThis, "setInterval");
afterEach(() => {
  for (const result of intervals.mock.results) clearInterval(result.value as NodeJS.Timeout);
  intervals.mockClear();
});
afterAll(() => {
  intervals.mockRestore();
  (process as { parentPort?: unknown }).parentPort = original.parentPort;
  globalThis.fetch = original.fetch;
});

/** The worker handles one document: load it with the request, wait for its one reply. */
async function reply(outcome: () => Promise<unknown>): Promise<unknown> {
  vi.resetModules();
  port.removeAllListeners();
  port.postMessage.mockReset();
  realm.extract.mockReset().mockImplementation(outcome);
  (process as { parentPort?: unknown }).parentPort = port;
  await import("../../../src/main/documents/pdfWorker.js");
  port.emit("message", { data: { bytes: new Uint8Array([1]), range: { startPage: 1, pageCount: 1 } } });
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
  return port.postMessage.mock.calls[0]?.[0];
}

test("returns the realm's text", async () => {
  const result = { totalPages: 1, pages: [{ number: 1, text: "synthetic" }], nextPage: null, truncated: false, before: "", after: "" };
  expect(await reply(async () => result)).toEqual({ ok: true, result });
  expect(realm.extract).toHaveBeenCalledWith(new Uint8Array([1]), { startPage: 1, pageCount: 1 });
});

test("reports a password-protected PDF by reason only", async () => {
  expect(await reply(async () => { throw new Error("This PDF requires a password."); })).toEqual({ ok: false, reason: "password" });
});

test("any other failure is unreadable, without its message", async () => {
  const message = await reply(async () => { throw new Error("syntheticPrivate123 parser detail"); });
  expect(message).toEqual({ ok: false, reason: "unreadable" });
  expect(JSON.stringify(message)).not.toContain("syntheticPrivate123");
});

test("the network is off in the worker", async () => {
  await reply(async () => ({ totalPages: 1, pages: [], nextPage: null, truncated: false, before: "", after: "" }));
  await expect(globalThis.fetch("https://example.com/")).rejects.toThrow("disabled");
});

test("keeps the process running while it reads and after it replies, for the parent to end", async () => {
  // A pending WebAssembly compile holds no handle of the event loop: something else must, or the
  // process ends mid-read with no reply; and a process ending right after its reply can reach the
  // parent as an exit before the reply. Waited on with immediates, which are no timers.
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const settle = async () => { for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve)); };
  vi.resetModules();
  port.removeAllListeners();
  port.postMessage.mockReset();
  let release: (value: unknown) => void = () => {};
  realm.extract.mockReset().mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  (process as { parentPort?: unknown }).parentPort = port;
  await import("../../../src/main/documents/pdfWorker.js");
  const idle = timers();
  port.emit("message", { data: { bytes: new Uint8Array([1]), range: { startPage: 1, pageCount: 1 } } });
  await settle();
  expect(realm.extract).toHaveBeenCalledOnce();
  expect(timers()).toBeGreaterThan(idle);
  release({ totalPages: 1, pages: [], nextPage: null, truncated: false, before: "", after: "" });
  await settle();
  expect(port.postMessage).toHaveBeenCalledOnce();
  expect(timers()).toBeGreaterThan(idle);
});
