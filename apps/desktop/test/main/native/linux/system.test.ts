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


const caret = { x: 979, y: 312, width: 2, height: 19 };
const imRect = { x: 721, y: 312, width: 1, height: 18 };

/** A helper answering `caretAnchor` with `reply`, or failing with it. */
function helperWith(reply: unknown) {
  return vi.fn().mockImplementation((method: string) => {
    expect(method).toBe("caretAnchor");
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
}

test.each([null, {}, { x: NaN, y: 1, width: 1, height: 20 }, { x: 1, y: 1, width: 0, height: 20 }, { x: 1, y: 1, width: 1, height: -1 }])("unusable geometry from both falls back: %j", async (rect) => {
  const request = helperWith(rect), geometry = helperWith(rect);
  const system = new LinuxSystem({ request } as unknown as HelperClient, { request: geometry } as unknown as HelperClient);
  expect(await system.caretAnchor()).toBeNull();
  expect(request).toHaveBeenCalledExactlyOnceWith("caretAnchor", {}, 200);
  expect(geometry).toHaveBeenCalledExactlyOnceWith("caretAnchor", {}, 200);
});

test("the focused element's own caret wins over the input-method rectangle", async () => {
  const system = new LinuxSystem({ request: helperWith(caret) } as unknown as HelperClient, { request: helperWith(imRect) } as unknown as HelperClient);
  expect(await system.caretAnchor()).toEqual(caret);
});

test.each([null, { x: 1, y: 1, width: 0, height: 20 }, new HelperError("timeout", "caretAnchor")])("without an accessible caret (%j) the input-method rectangle places the pill", async (reply) => {
  const system = new LinuxSystem({ request: helperWith(reply) } as unknown as HelperClient, { request: helperWith(imRect) } as unknown as HelperClient);
  expect(await system.caretAnchor()).toEqual(imRect);
});

test("compositor coordinates stay logical and its transport timeout reaches the overlay fallback", async () => {
  const failure = new HelperError("timeout", "caretAnchor");
  const system = new LinuxSystem({ request: helperWith(null) } as unknown as HelperClient, { request: helperWith(failure) } as unknown as HelperClient);
  await expect(system.caretAnchor()).rejects.toBe(failure);
});

test("both are asked at once, so a screen read occupying the accessibility helper delays neither request", () => {
  const request = vi.fn().mockImplementation(() => new Promise(() => {}));
  const geometry = vi.fn().mockImplementation(() => new Promise(() => {}));
  const system = new LinuxSystem({ request } as unknown as HelperClient, { request: geometry } as unknown as HelperClient);
  void system.caretAnchor();
  expect(request).toHaveBeenCalledExactlyOnceWith("caretAnchor", {}, 200);
  expect(geometry).toHaveBeenCalledExactlyOnceWith("caretAnchor", {}, 200);
});

/** With the focused element's caret found, a compositor that then times out is no concern of the
 * pill's, and leaves no unhandled rejection in the main process. */
test("a compositor failing after the caret was found is ignored", async () => {
  let fail!: (error: Error) => void;
  // A plain function: a mock would watch the promise it returns, and so handle the rejection itself.
  const pending = new Promise((_resolve, reject) => { fail = reject; });
  const geometry = () => pending;
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const system = new LinuxSystem({ request: helperWith(caret) } as unknown as HelperClient, { request: geometry } as unknown as HelperClient);
    expect(await system.caretAnchor()).toEqual(caret);
    fail(new HelperError("timeout", "caretAnchor"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listener);
  }
});
