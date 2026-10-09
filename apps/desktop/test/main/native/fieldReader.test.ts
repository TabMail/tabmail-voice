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
function reader(platform: NodeJS.Platform = "win32", identity: (target: number) => number | null = (target) => target) {
  const calls: unknown[][] = [];
  const settle: Settle[] = [];
  const helper = {
    request: (...args: unknown[]) => {
      calls.push(["request", ...args]);
      return new Promise((resolve, reject) => settle.push({ resolve, reject }));
    },
    restart: () => void calls.push(["restart"]),
  };
  return { field: new FieldReader(helper as unknown as HelperClient, platform, identity), calls, settle };
}
const exclusions = { apps: ["Example.exe"], sites: ["example.com"] };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const kinds = (calls: unknown[][]) => calls.map(([kind]) => kind);

/** The field read is of the paste's own target, by the identity both programs share: the process on
 * macOS and Linux, the window's handle on Windows; on Linux the main helper's window token is mapped to
 * its process (`LinuxSystem.appOf`), since tokens are each process's own. */
test.each([
  ["darwin", "pid", 42],
  ["win32", "window", 42],
  ["linux", "pid", 4242],
] as const)("on %s the field is read by the target's %s", async (platform, key, own) => {
  const mapped: number[] = [];
  const { field, calls, settle } = reader(platform, (target) => (mapped.push(target), platform === "linux" ? 4242 : target));
  const value = field.value(42, exclusions);
  settle[0]!.resolve({ value: "Meet Xyvora." });
  expect(await value).toBe("Meet Xyvora.");
  expect(mapped).toEqual([42]);
  expect(calls).toEqual([
    ["request", "focusedFieldValue", { [key]: own, maxLength: config.correctionMaxFieldLength, excludedAppIDs: ["Example.exe"], excludedHosts: ["example.com"] }, config.fieldReaderTimeout],
  ]);
  expect(config.fieldReaderTimeout).toBe(config.correctionWatchDuration);
});

/** A target the reader has no identity for (a Linux window whose process is unknown) is no field. */
test("a target with no identity in the reader reads nothing", async () => {
  const { field, calls } = reader("linux", () => null);
  expect(await field.value(42, exclusions)).toBeNull();
  expect(calls).toEqual([]);
});

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

/** A read asked while the last is still going is a new watch's (a slow terminal read when the next
 * dictation was pasted; reads within one watch come one after another): the last is no longer wanted,
 * so the reader starts afresh first. */
test("a new read while one is still going ends the reader first", async () => {
  const { field, calls, settle } = reader();
  void field.value(42, exclusions).catch(() => undefined);
  void field.value(43, exclusions);
  expect(kinds(calls)).toEqual(["request", "restart", "request"]);
  // Reads within one watch come one after another: none is still going when the next is asked.
  settle[1]!.resolve({ value: "" });
  await flush();
  void field.value(43, exclusions);
  expect(kinds(calls)).toEqual(["request", "restart", "request", "request"]);
});

test.each([
  ["a newer watch", async (field: FieldReader) => void field.value(44, exclusions)],
  ["its time", async (_field: FieldReader, settle: Settle[]) => settle[1]!.reject(new HelperError("timeout", "focusedFieldValue"))],
])("a read that superseded another is still ended by %s after the other settles", async (_name, end) => {
  const { field, calls, settle } = reader();
  void field.value(42, exclusions).catch(() => undefined);
  void field.value(43, exclusions).catch(() => undefined);
  // The superseded read settles after the new one started: the new one, still going, stays tracked.
  settle[0]!.reject(new HelperError("exited", "focusedFieldValue"));
  await flush();
  await end(field, settle);
  await flush();
  expect(kinds(calls).slice(0, 4)).toEqual(["request", "restart", "request", "restart"]);
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
  void field.value(43, exclusions);
  expect(kinds(calls)).toEqual(["request", "request"]);
});

test("a read past its time ends the reader, so a stuck provider can't hold the next watch", async () => {
  const { field, calls, settle } = reader();
  const value = field.value(42, exclusions);
  settle[0]!.reject(new HelperError("timeout", "focusedFieldValue"));
  await expect(value).rejects.toThrow(HelperError);
  expect(kinds(calls)).toEqual(["request", "restart"]);
  void field.value(43, exclusions);
  expect(kinds(calls)).toEqual(["request", "restart", "request"]);
});

test("an old read timing out after a newer request started leaves the newer one alone", async () => {
  const { field, calls, settle } = reader();
  void field.value(42, exclusions).catch(() => undefined);
  void field.value(43, exclusions);
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
    void field.value(43, exclusions);
    settle[0]!.reject(new HelperError("exited", "focusedFieldValue"));
    settle[1]!.resolve(null);
    await flush();
  } finally {
    configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
  }
  expect(lines).toEqual([
    "FieldReader: the last read is still going; restarting the reader",
    expect.stringMatching(/^FieldReader: focusedFieldValue failed \(HelperError\.exited\(focusedFieldValue\)\) after \d+ms$/),
    expect.stringMatching(/^FieldReader: focusedFieldValue answered in \d+ms$/),
  ]);
});
