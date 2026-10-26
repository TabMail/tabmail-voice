// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "vitest";
import { PasteTargetError } from "../../../src/core/dictation/targetWindow.js";
import { CancellationError } from "../../../src/core/util/timeout.js";
import { HelperError, type HelperClient } from "../../../src/main/native/helperClient.js";
import { ScreenReader } from "../../../src/main/native/screenReader.js";
import { TargetWindows } from "../../../src/main/native/targetWindow.js";

function setup(platform: NodeJS.Platform) {
  const calls: { helper: string; method: string; params: unknown }[] = [];
  const native = { window: platform === "darwin" ? "00000000-0000-0000-0000-000000000001" : 42, pid: 123 };
  const replies = new Map<string, unknown>([["captureTarget", native], ["preparePaste", { transaction: 7 }]]);
  const failures = new Map<string, Error>();
  const helper = (name: string) => ({
    request: async (method: string, params: unknown) => {
      calls.push({ helper: name, method, params });
      if (failures.has(method)) throw failures.get(method);
      return await replies.get(method) ?? null;
    },
    restart: () => calls.push({ helper: name, method: "restart", params: undefined }),
  } as unknown as HelperClient);
  const main = helper("system");
  const reader = new ScreenReader(helper("reader"));
  return { targets: new TargetWindows(main, reader, platform), native, calls, replies, failures, reader };
}

test.each(["darwin", "win32", "linux"] as const)("%s uses the same captured native identity for paste and correction learning", async (platform) => {
  const { targets, native, calls } = setup(platform);
  const handle = await targets.capture();
  expect(handle).not.toBeNull();
  expect(targets.native(handle)).toEqual(native);
  expect(targets.appOf(handle!)).toBe(native.pid);
  await targets.paste("Synthetic text", new AbortController().signal, handle!);
  expect(calls.find(call => call.method === (platform === "darwin" ? "pasteTarget" : "insert"))?.params).toMatchObject({ target: native });
  if (platform === "darwin") {
    expect(calls.map(call => [call.helper, call.method])).toEqual([
      ["reader", "captureTarget"], ["system", "preparePaste"], ["reader", "pasteTarget"], ["system", "finishPaste"],
    ]);
  }
});

test.each(["pasteTarget", "insert"])("a refused %s reports an unavailable target and finishes a prepared clipboard", async (method) => {
  const { targets, calls, failures } = setup(method === "insert" ? "win32" : "darwin");
  const handle = await targets.capture();
  failures.set(method, new HelperError("failed", method));
  await expect(targets.paste("Synthetic text", new AbortController().signal, handle!)).rejects.toBeInstanceOf(PasteTargetError);
  if (method === "pasteTarget") expect(calls.at(-1)).toMatchObject({ method: "finishPaste", params: { transaction: 7 } });
});

test("a failed clipboard preparation sends no paste keys and needs no finish", async () => {
  const { targets, calls, failures } = setup("darwin");
  const handle = await targets.capture();
  failures.set("preparePaste", new HelperError("failed", "preparePaste"));
  await expect(targets.paste("Synthetic text", new AbortController().signal, handle!)).rejects.toBeInstanceOf(HelperError);
  expect(calls.map(call => call.method)).toEqual(["captureTarget", "preparePaste"]);
});

test("a new key-down invalidates the old target, including when its capture fails", async () => {
  const { targets, replies } = setup("win32");
  const first = await targets.capture();
  replies.set("captureTarget", null);
  expect(await targets.capture()).toBeNull();
  expect(targets.native(first)).toBeNull();
  await expect(targets.paste("Synthetic text", new AbortController().signal, first!)).rejects.toBeInstanceOf(PasteTargetError);
});

test.each([null, {}, { window: 0, pid: 123 }, { window: 42, pid: 0 }])("an unreadable identity is not a target: %j", async (reply) => {
  const { targets, replies } = setup("linux");
  replies.set("captureTarget", reply);
  expect(await targets.capture()).toBeNull();
});

test("a canceled paste mutates no clipboard and posts no keys", async () => {
  const { targets, calls } = setup("darwin");
  const handle = await targets.capture();
  const cancel = new AbortController();
  cancel.abort();
  await expect(targets.paste("Synthetic text", cancel.signal, handle!)).rejects.toBeInstanceOf(CancellationError);
  expect(calls.map(call => call.method)).toEqual(["captureTarget"]);
});

test("a delayed old capture cannot replace the next dictation's window", async () => {
  const { targets, replies, native } = setup("win32");
  let settle!: (value: unknown) => void;
  replies.set("captureTarget", new Promise(resolve => { settle = resolve; }));
  const old = targets.capture();
  replies.set("captureTarget", { window: 84, pid: 456 });
  const current = await targets.capture();
  settle(native);
  expect(await old).toBeNull();
  expect(targets.native(current)).toEqual({ window: 84, pid: 456 });
});
