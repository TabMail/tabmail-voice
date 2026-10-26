// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { join } from "node:path";
import { expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { configureLog } from "../../../src/core/log.js";
import { HelperClient, HelperError } from "../../../src/main/native/helperClient.js";
import { ScreenReader } from "../../../src/main/native/screenReader.js";

/** The reader's helper: each request waits until the test settles it; `calls` records requests and
 * restarts in order. */
function reader() {
  const calls: unknown[][] = [];
  const settle: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const helper = {
    request: (...args: unknown[]) => {
      calls.push(["request", ...args]);
      return new Promise((resolve, reject) => settle.push({ resolve, reject }));
    },
    restart: () => void calls.push(["restart"]),
  };
  return { screen: new ScreenReader(helper as unknown as HelperClient), calls, settle };
}
const exclusions = { apps: ["Example.exe"], sites: ["example.com"] };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a read asks the reader for the screen with the exclusions, waiting as long as the longest dictation", async () => {
  const { screen, calls, settle } = reader();
  const read = screen.read(exclusions);
  settle[0]!.resolve({ hidden: true });

  expect(await read).toEqual({ hidden: true });
  expect(calls).toEqual([["request", "readScreen", { excludedAppIDs: ["Example.exe"], excludedHosts: ["example.com"], read: 1, wholeWindow: false }, config.screenReaderTimeout]]);
  expect(config.screenReaderTimeout).toBe(config.maxRecordingDuration);
});

/** A read takes what the window shows unless asked for the whole window (ADR-DESK-016, 2026-10-25),
 * which the agent reads only when it asks (`screen_read`): the whole window of the window an earlier
 * read read, bound to that read by its number (`sameWindowAs`), so the helper reads nothing if
 * another window came to the front since. The whole window of a read this reader did not make is
 * not read at all. */
test("a read asks for the whole window only when told to, of the window an earlier read read", async () => {
  const { screen, calls, settle } = reader();
  const shown = screen.read(exclusions);
  settle[0]!.resolve(null);
  await shown;
  const whole = screen.read(exclusions, shown);
  settle[1]!.resolve(null);
  await whole;
  expect(await screen.read(exclusions, Promise.resolve(null))).toBeNull();

  expect(calls.map((call) => call[2])).toEqual([
    { excludedAppIDs: ["Example.exe"], excludedHosts: ["example.com"], read: 1, wholeWindow: false },
    { excludedAppIDs: ["Example.exe"], excludedHosts: ["example.com"], read: 2, wholeWindow: true, sameWindowAs: 1 },
  ]);
});

test("a read still going when the next starts is ended: the reader starts afresh before the new one", async () => {
  const { screen, calls, settle } = reader();
  void screen.read(exclusions);
  void screen.read(exclusions);

  expect(calls.map(([kind]) => kind)).toEqual(["request", "restart", "request"]);
  // The second, still going too, is ended by a third.
  settle[0]!.reject(new HelperError("exited", "readScreen"));
  await flush();
  void screen.read(exclusions);
  expect(calls.map(([kind]) => kind)).toEqual(["request", "restart", "request", "restart", "request"]);
});

test.each([
  ["answered", (settle: { resolve: (value: unknown) => void; reject: (error: Error) => void }) => settle.resolve(null)],
  ["refused", (settle: { resolve: (value: unknown) => void; reject: (error: Error) => void }) => settle.reject(new HelperError("failed", "readScreen"))],
  ["ended with its process", (settle: { resolve: (value: unknown) => void; reject: (error: Error) => void }) => settle.reject(new HelperError("exited", "readScreen"))],
])("a read %s leaves the reader running for the next", async (_name, end) => {
  const { screen, calls, settle } = reader();
  void screen.read(exclusions).catch(() => undefined);
  end(settle[0]!);
  await flush();
  void screen.read(exclusions);

  expect(calls.map(([kind]) => kind)).toEqual(["request", "request"]);
});

test("a read past its time ends the reader, so a stuck provider can't hold the next read", async () => {
  const { screen, calls, settle } = reader();
  const read = screen.read(exclusions);
  settle[0]!.reject(new HelperError("timeout", "readScreen"));

  await expect(read).rejects.toThrow(HelperError);
  expect(calls.map(([kind]) => kind)).toEqual(["request", "restart"]);
  void screen.read(exclusions);
  expect(calls.map(([kind]) => kind)).toEqual(["request", "restart", "request"]);
});

test("an old read timing out after a newer one started leaves the newer one alone", async () => {
  const { screen, calls, settle } = reader();
  void screen.read(exclusions).catch(() => undefined);
  void screen.read(exclusions);
  settle[0]!.reject(new HelperError("timeout", "readScreen"));
  await flush();

  expect(calls.map(([kind]) => kind)).toEqual(["request", "restart", "request"]);
});

test("every saved exclusion reaches the reader, past the old cap", async () => {
  const { screen, calls, settle } = reader();
  const apps = Array.from({ length: 1000 }, (_, index) => `Synthetic${index}.exe`);
  const sites = Array.from({ length: 1000 }, (_, index) => `site${index}.example.test`);
  const read = screen.read({ apps, sites });
  settle[0]!.resolve(null);

  expect(await read).toBeNull();
  expect(calls[0]?.[2]).toStrictEqual({ excludedAppIDs: apps, excludedHosts: sites, read: 1, wholeWindow: false });
});

test("a stop asks the read still going, by its number, to answer with what it has read so far", async () => {
  const { screen, calls, settle } = reader();
  void screen.read(exclusions);
  settle[0]!.resolve(null);
  await flush();
  const read = screen.read(exclusions);
  screen.stop(read);
  settle[1]!.resolve({ renderedText: "so far" });

  expect(await read).toEqual({ renderedText: "so far" });
  expect(calls.slice(1)).toEqual([
    ["request", "readScreen", { excludedAppIDs: ["Example.exe"], excludedHosts: ["example.com"], read: 2, wholeWindow: false }, config.screenReaderTimeout],
    ["request", "readScreenStop", { read: 2 }],
  ]);
});

test("a stop for a read that has answered, or that a newer read replaced, asks nothing", async () => {
  const { screen, calls, settle } = reader();
  const answered = screen.read(exclusions);
  settle[0]!.resolve(null);
  await answered;
  screen.stop(answered);
  const replaced = screen.read(exclusions);
  replaced.catch(() => undefined);
  void screen.read(exclusions);
  screen.stop(replaced);

  expect(calls.map(([kind, method]) => (kind === "request" ? method : kind))).toEqual(["readScreen", "readScreen", "restart", "readScreen"]);
});

test("a stop the reader refuses only logs: the read goes on", async () => {
  const { screen, calls, settle } = reader();
  const read = screen.read(exclusions);
  screen.stop(read);
  settle[1]!.reject(new HelperError("failed", "readScreenStop"));
  await flush();
  settle[0]!.resolve(null);

  expect(await read).toBeNull();
  expect(calls).toHaveLength(2);
});

test("the debug log times each read and says when a read restarts the reader", async () => {
  const lines: string[] = [];
  configureLog({ isDebugBuild: true, sinks: { file: (_level, text) => lines.push(text), error: () => {} } });
  try {
    const { screen, settle } = reader();
    void screen.read(exclusions).catch(() => undefined);
    void screen.read(exclusions);
    settle[0]!.reject(new HelperError("exited", "readScreen"));
    settle[1]!.resolve(null);
    await flush();
  } finally {
    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
  }
  expect(lines).toEqual([
    "ScreenReader: the last read is still going; restarting the reader",
    expect.stringMatching(/^ScreenReader: read failed \(HelperError\.exited\(readScreen\)\) after \d+ms$/),
    expect.stringMatching(/^ScreenReader: read answered in \d+ms$/),
  ]);
});

test("a new target survives reader restart and both scopes read it after focus moves", async () => {
  let epoch = 0;
  let release!: (value: null) => void;
  const oldRead = new Promise<null>(resolve => { release = resolve; });
  const identity = () => ({ window: `00000000-0000-0000-0000-${String(epoch).padStart(12, "0")}`, pid: 123 });
  let first = true;
  let foreground = "Captured";
  const helper = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "captureTarget") return identity();
      if (method !== "readScreen") return null;
      if (first) { first = false; return oldRead; }
      const target = params.target as { window?: string } | undefined;
      if (target && target.window !== identity().window) return null;
      return { renderedText: `${target ? "Captured" : foreground} ${params.wholeWindow ? "whole" : "shown"}` };
    },
    restart: () => { epoch += 1; release(null); },
  } as unknown as HelperClient;
  const screen = new ScreenReader(helper);
  const superseded = screen.read(exclusions);
  const target = await screen.captureTarget();
  await superseded;
  foreground = "Competing";
  const shown = screen.read(exclusions, undefined, Promise.resolve(target));
  expect((await shown as { renderedText: string } | null)?.renderedText).toBe("Captured shown");
  const whole = await screen.read(exclusions, shown);
  expect((whole as { renderedText: string } | null)?.renderedText).toBe("Captured whole");
  expect(JSON.stringify([await shown, whole])).not.toContain("Competing");
});

for (const canceling of [false, true]) test(`the activated captured target posts only for a live operation: canceled=${canceling}`, async () => {
  const helper = new HelperClient({ name: "target-paste-fixture", executable: process.execPath,
    args: [join(__dirname, "../../support/targetPasteHelper.mjs")] });
  helper.start();
  try {
    const reader = new ScreenReader(helper);
    const target = await reader.captureTarget();
    const abort = new AbortController();
    const pasting = reader.pasteTarget(target!, 7, Date.now() + 1000, abort.signal).catch(error => error);
    const before = await helper.request<{pending: boolean; addressed: unknown}>("state");
    expect(before).toMatchObject({ pending: true, addressed: target });
    if (canceling) abort.abort();
    await helper.request("advance");
    await pasting;
    const after = await helper.request("state");
    expect(after).toMatchObject({ pending: false, canceled: canceling, keys: canceling ? 0 : 1, addressed: target });
  } finally { helper.stop(); }
});
