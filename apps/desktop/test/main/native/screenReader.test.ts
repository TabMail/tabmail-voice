// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { type HelperClient, HelperError } from "../../../src/main/native/helperClient.js";
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
  expect(calls).toEqual([["request", "readScreen", { excludedAppIDs: ["Example.exe"], excludedHosts: ["example.com"] }, config.screenReaderTimeout]]);
  expect(config.screenReaderTimeout).toBe(config.maxRecordingDuration);
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
  expect(calls[0]?.[2]).toStrictEqual({ excludedAppIDs: apps, excludedHosts: sites });
});
