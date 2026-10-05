// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, expect, test, vi } from "vitest";
import { WindowsSystem } from "../../../../src/main/native/windows/system.js";
import type { HelperClient } from "../../../../src/main/native/helperClient.js";

const mocks = vi.hoisted(() => ({ convert: vi.fn(), request: vi.fn() }));
vi.mock("electron", () => ({ screen: { screenToDipRect: mocks.convert } }));
const system = new WindowsSystem({ request: mocks.request } as unknown as HelperClient);
beforeEach(() => { mocks.request.mockReset(); mocks.convert.mockReset(); });

test.each([null, {}, { window: null }, { window: -1 }, { window: 0 }, { window: 0.5 }, { window: Number.MAX_SAFE_INTEGER + 1 }, { window: "101" }])("unknown foreground identity fails closed: %j", async (reply) => {
  mocks.request.mockResolvedValue(reply);
  expect(await system.frontmostApp()).toBeNull();
});

test("keeps a positive window identity separate from a process id", async () => {
  mocks.request.mockResolvedValue({ window: 123456, pid: 5 });
  expect(await system.frontmostApp()).toBe(123456);
  expect(mocks.request).toHaveBeenCalledWith("frontmostApp");
});

test("converts native physical caret geometry to Electron display points", async () => {
  const physical = { x: 150, y: 300, width: 0, height: 30 };
  const points = { x: 100, y: 200, width: 0, height: 20 };
  mocks.request.mockResolvedValue(physical);
  mocks.convert.mockReturnValue(points);
  expect(await system.caretAnchor(101)).toEqual(points);
  expect(mocks.request).toHaveBeenCalledWith("caretAnchor", { window: 101 });
  expect(mocks.convert).toHaveBeenCalledWith(null, physical);
});

test("missing or malformed caret geometry does not reach Electron", async () => {
  for (const rect of [null, { x: 0, y: 0, width: -1, height: 1 }, { x: NaN, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 0, height: 0 }]) {
    mocks.request.mockResolvedValue(rect);
    expect(await system.caretAnchor(101)).toBeNull();
  }
  expect(await system.caretAnchor(0)).toBeNull();
  expect(mocks.convert).not.toHaveBeenCalled();
});

test("paste carries the original target, deadline, restore delay and cancellation", async () => {
  const operation = new AbortController();
  mocks.request.mockResolvedValue({});
  const before = Date.now();
  await system.paste("Synthetic text", operation.signal, 101);
  const [method, params, timeout, signal] = mocks.request.mock.calls[0] ?? [];
  expect(method).toBe("insert");
  expect(params).toMatchObject({ text: "Synthetic text", window: 101, restoreDelay: 500 });
  expect(params.deadline).toBeGreaterThanOrEqual(before + 3000);
  expect(params.deadline).toBeLessThanOrEqual(Date.now() + 3000);
  expect(timeout).toBe(3500);
  expect(signal).toBe(operation.signal);
});

test("paste refuses ambiguous targets before any helper mutation", async () => {
  for (const window of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(system.paste("Synthetic text", new AbortController().signal, window)).rejects.toMatchObject({ name: "HelperError" });
  }
  expect(mocks.request).not.toHaveBeenCalled();
});

test("correction learning reads the complete bounded field from its original window", async () => {
  mocks.request.mockResolvedValue({ value: "Before Synthetic after." });
  expect(await system.focusedFieldValue(101, { apps: ["Synthetic.exe"], sites: ["example.com"] })).toBe("Before Synthetic after.");
  expect(mocks.request).toHaveBeenCalledWith("focusedFieldValue", { window: 101, maxLength: 20_000, excludedAppIDs: ["Synthetic.exe"], excludedHosts: ["example.com"] });
});

test("correction learning refuses invalid targets and malformed or over-limit replies", async () => {
  for (const target of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(await system.focusedFieldValue(target, { apps: ["Synthetic.exe"], sites: ["example.com"] })).toBeNull();
  expect(mocks.request).not.toHaveBeenCalled();
  for (const reply of [null, {}, { value: 10 }, { value: "a".repeat(20_001) }]) {
    mocks.request.mockResolvedValue(reply);
    expect(await system.focusedFieldValue(101, { apps: ["Synthetic.exe"], sites: ["example.com"] })).toBeNull();
  }
  mocks.request.mockResolvedValue({ value: "" });
  expect(await system.focusedFieldValue(101, { apps: ["Synthetic.exe"], sites: ["example.com"] })).toBe("");
});

/** The native reader receives the entire enlarged policy, including exclusions past the old cap
 * (the screen read's: `screenReader.test.ts`). */
test("correction learning forwards every saved exclusion", async () => {
  const apps = Array.from({ length: 1000 }, (_, index) => `Synthetic${index}.exe`);
  const sites = Array.from({ length: 1000 }, (_, index) => `site${index}.example.test`);
  const policy = { apps, sites };
  mocks.request.mockResolvedValue(null);
  await system.focusedFieldValue(101, policy);
  expect(mocks.request.mock.calls).toEqual([
    ["focusedFieldValue", { window: 101, maxLength: 20_000, excludedAppIDs: apps, excludedHosts: sites }],
  ]);
});

test("foreground caret is one native request and retains physical-to-DIP conversion", async () => {
  const physical = { x: 150, y: 300, width: 1, height: 30 };
  const points = { x: 100, y: 200, width: 1, height: 20 };
  mocks.request.mockResolvedValue(physical);
  mocks.convert.mockReturnValue(points);
  expect(await system.caretAnchor()).toEqual(points);
  expect(mocks.request.mock.calls).toEqual([["caretAnchor", {}]]);
  expect(mocks.convert).toHaveBeenCalledWith(null, physical);
});
