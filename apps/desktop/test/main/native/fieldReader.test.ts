// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { configureLog } from "../../../src/core/log.js";
import { type HelperClient, HelperError } from "../../../src/main/native/helperClient.js";
import { FieldReader } from "../../../src/main/native/fieldReader.js";

type Settle = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** voice-field-reader: each request waits until the test settles it; `calls` records requests and
 * restarts in order. */
function reader(platform: NodeJS.Platform = "win32") {
  const calls: unknown[][] = [];
  const settle: Settle[] = [];
  const helper = {
    request: (...args: unknown[]) => {
      calls.push(["request", ...args]);
      return new Promise((resolve, reject) => settle.push({ resolve, reject }));
    },
    restart: () => void calls.push(["restart"]),
  };
  return { field: new FieldReader(helper as unknown as HelperClient, platform), calls, settle };
}
const exclusions = { apps: ["Example.exe"], sites: ["example.com"] };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const kinds = (calls: unknown[][]) => calls.map(([kind]) => kind);

/** The reader's own identity of what is in front: a process on macOS, a window elsewhere (on Linux the
 * reader's own window token), named as the main helper names it on each platform. */
test.each([
  ["darwin", "pid"],
  ["win32", "window"],
  ["linux", "window"],
] as const)("on %s the target is the reader's frontmost %s, and the field is read by it", async (platform, key) => {
  const { field, calls, settle } = reader(platform);
  const target = field.target();
  settle[0]!.resolve({ [key]: 42 });
  expect(await target).toBe(42);
  const value = field.value(42, exclusions);
  settle[1]!.resolve({ value: "Meet Xyvora." });
  expect(await value).toBe("Meet Xyvora.");
  expect(calls).toEqual([
    ["request", "frontmostApp", {}, config.fieldReaderTimeout],
    ["request", "focusedFieldValue", { [key]: 42, maxLength: config.correctionMaxFieldLength, excludedAppIDs: ["Example.exe"], excludedHosts: ["example.com"] }, config.fieldReaderTimeout],
  ]);
  expect(config.fieldReaderTimeout).toBe(config.correctionWatchDuration);
});

test.each([null, {}, { window: 0 }, { window: -1 }, { window: 0.5 }, { window: Number.MAX_SAFE_INTEGER + 1 }, { window: "42" }, { pid: 42 }])(
  "no target in %j is none",
  async (reply) => {
    const { field, settle } = reader("win32");
    const target = field.target();
    settle[0]!.resolve(reply);
    expect(await target).toBeNull();
  },
);

test.each([null, {}, { value: null }, { value: 10 }, { value: "a".repeat(config.correctionMaxFieldLength + 1) }])("no text in %j is none", async (reply) => {
  const { field, settle } = reader();
  const value = field.value(42, exclusions);
  settle[0]!.resolve(reply);
  expect(await value).toBeNull();
});

test("an empty field is its text, and a field at the cap is read whole", async () => {
  const { field, settle } = reader();
  const empty = field.value(42, exclusions);
  settle[0]!.resolve({ value: "" });
  expect(await empty).toBe("");
  const full = field.value(42, exclusions);
  settle[1]!.resolve({ value: "a".repeat(config.correctionMaxFieldLength) });
  expect(await full).toHaveLength(config.correctionMaxFieldLength);
});

/** A watch that starts while the last watch's read is still going (a slow terminal read when the next
 * dictation was pasted): that read is no longer wanted, so the reader starts afresh first. */
test("a new watch while a read is still going ends the reader before asking what is in front", async () => {
  const { field, calls, settle } = reader();
  void field.value(42, exclusions).catch(() => undefined);
  void field.target();
  expect(kinds(calls)).toEqual(["request", "restart", "request"]);
  // Reads within one watch come one after another: none is still going when the next is asked.
  settle[1]!.resolve({ window: 42 });
  await flush();
  void field.value(42, exclusions);
  expect(kinds(calls)).toEqual(["request", "restart", "request", "request"]);
});

test.each([
  ["answered", (settle: Settle) => settle.resolve(null)],
  ["refused", (settle: Settle) => settle.reject(new HelperError("failed", "focusedFieldValue"))],
  ["ended with its process", (settle: Settle) => settle.reject(new HelperError("exited", "focusedFieldValue"))],
])("a read %s leaves the reader running for the next watch", async (_name, end) => {
  const { field, calls, settle } = reader();
  void field.value(42, exclusions).catch(() => undefined);
  end(settle[0]!);
  await flush();
  void field.target();
  expect(kinds(calls)).toEqual(["request", "request"]);
});

test("a read past its time ends the reader, so a stuck provider can't hold the next watch", async () => {
  const { field, calls, settle } = reader();
  const value = field.value(42, exclusions);
  settle[0]!.reject(new HelperError("timeout", "focusedFieldValue"));
  await expect(value).rejects.toThrow(HelperError);
  expect(kinds(calls)).toEqual(["request", "restart"]);
  void field.target();
  expect(kinds(calls)).toEqual(["request", "restart", "request"]);
});

test("an old read timing out after a newer request started leaves the newer one alone", async () => {
  const { field, calls, settle } = reader();
  void field.value(42, exclusions).catch(() => undefined);
  void field.target();
  settle[0]!.reject(new HelperError("timeout", "focusedFieldValue"));
  await flush();
  expect(kinds(calls)).toEqual(["request", "restart", "request"]);
});

/** The reader receives the entire policy, including exclusions past the old cap. */
test("every saved exclusion reaches the reader", async () => {
  const { field, calls, settle } = reader();
  const apps = Array.from({ length: 1000 }, (_, index) => `Synthetic${index}.exe`);
  const sites = Array.from({ length: 1000 }, (_, index) => `site${index}.example.test`);
  const value = field.value(101, { apps, sites });
  settle[0]!.resolve(null);
  expect(await value).toBeNull();
  expect(calls[0]?.[2]).toStrictEqual({ window: 101, maxLength: config.correctionMaxFieldLength, excludedAppIDs: apps, excludedHosts: sites });
});

test("the debug log times each request and says when a watch restarts the reader", async () => {
  const lines: string[] = [];
  configureLog({ isDebugBuild: true, sinks: { file: (_level, text) => lines.push(text), error: () => {} } });
  try {
    const { field, settle } = reader();
    void field.value(42, exclusions).catch(() => undefined);
    void field.target();
    settle[0]!.reject(new HelperError("exited", "focusedFieldValue"));
    settle[1]!.resolve(null);
    await flush();
  } finally {
    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
  }
  expect(lines).toEqual([
    "FieldReader: the last read is still going; restarting the reader",
    expect.stringMatching(/^FieldReader: focusedFieldValue failed \(HelperError\.exited\(focusedFieldValue\)\) after \d+ms$/),
    expect.stringMatching(/^FieldReader: frontmostApp answered in \d+ms$/),
  ]);
});
