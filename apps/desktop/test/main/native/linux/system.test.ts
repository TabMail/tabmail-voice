// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test, vi } from "vitest";
import { LinuxSystem } from "../../../../src/main/native/linux/system.js";
import { HelperError, type HelperClient } from "../../../../src/main/native/helperClient.js";

test("unknown clipboard offers history recovery without retrying insertion", async () => {
  const request = vi.fn().mockResolvedValue({ status: "clipboard-unavailable" });
  const system = new LinuxSystem({ request } as unknown as HelperClient);
  await expect(system.paste("Synthetic text", new AbortController().signal, 101))
    .rejects.toThrow("Couldn't paste. Your text is saved in history.");
  expect(request).toHaveBeenCalledTimes(1);
});

test("transport failures remain uncertain and are not reclassified or retried", async () => {
  const failure = new HelperError("failed", "insert", "synthetic failure");
  const request = vi.fn().mockRejectedValue(failure);
  const system = new LinuxSystem({ request } as unknown as HelperClient);
  await expect(system.paste("Synthetic text", new AbortController().signal, 101)).rejects.toBe(failure);
  expect(request).toHaveBeenCalledTimes(1);
});

test("successful insertion retains target and cancellation contract", async () => {
  const request = vi.fn().mockResolvedValue({});
  const system = new LinuxSystem({ request } as unknown as HelperClient);
  const signal = new AbortController().signal;
  await system.paste("Synthetic text", signal, 101);
  expect(request).toHaveBeenCalledExactlyOnceWith("insert",
    expect.objectContaining({ text: "Synthetic text", window: 101, deadline: expect.any(Number) }),
    3500, signal);
});


test.each([null, {}, { x: NaN, y: 1, width: 1, height: 20 }, { x: 1, y: 1, width: 0, height: 20 }, { x: 1, y: 1, width: 1, height: -1 }])("unusable compositor geometry falls back: %j", async (rect) => {
  const request = vi.fn().mockResolvedValue(rect);
  const system = new LinuxSystem({ request } as unknown as HelperClient);
  expect(await system.caretAnchor()).toBeNull();
  expect(request).toHaveBeenCalledExactlyOnceWith("caretAnchor", {}, 200);
});

test("compositor coordinates stay logical and transport timeout reaches the overlay fallback", async () => {
  const rect = { x: -100, y: 200, width: 1, height: 20 };
  const failure = new HelperError("timeout", "caretAnchor");
  const request = vi.fn().mockResolvedValueOnce(rect).mockRejectedValueOnce(failure);
  const system = new LinuxSystem({ request } as unknown as HelperClient);
  expect(await system.caretAnchor()).toEqual(rect);
  await expect(system.caretAnchor()).rejects.toBe(failure);
  expect(request).toHaveBeenCalledTimes(2);
});


test("caret lookup uses the hotkey transport independently of blocked screen reads", async () => {
  const request = vi.fn().mockImplementation(() => new Promise(() => {}));
  const rect = { x: 100, y: 200, width: 1, height: 20 };
  const geometry = vi.fn().mockResolvedValue(rect);
  const system = new LinuxSystem({ request } as unknown as HelperClient, { request: geometry } as unknown as HelperClient);
  expect(await system.caretAnchor()).toEqual(rect);
  expect(request).not.toHaveBeenCalled();
  expect(geometry).toHaveBeenCalledExactlyOnceWith("caretAnchor", {}, 200);
});
