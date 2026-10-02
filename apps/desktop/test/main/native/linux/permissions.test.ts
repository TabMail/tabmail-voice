// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { expect, test, vi } from "vitest";
import { LinuxPermissions } from "../../../../src/main/native/linux/permissions.js";
import type { HelperClient } from "../../../../src/main/native/helperClient.js";

function fixture() {
  let event: (message: Record<string, unknown>) => void = () => {};
  const request = vi.fn<HelperClient["request"]>();
  const helper = { request, on: (_name: string, handler: typeof event) => { event = handler; } };
  let shortcutEvent: (message: Record<string, unknown>) => void = () => {};
  const shortcutRequest = vi.fn<HelperClient["request"]>().mockResolvedValue({ installed: true });
  const shortcut = { request: shortcutRequest, on: (_name: string, handler: typeof shortcutEvent) => { shortcutEvent = handler; } };
  const permissions = new LinuxPermissions(helper as unknown as HelperClient, shortcut as unknown as HelperClient);
  shortcutEvent({ installed: true });
  const change = vi.fn(); permissions.onChange = change;
  return { permissions, request, change, shortcutRequest, shortcutEvent, event: (granted: unknown) => event({ granted }) };
}

test("keyboard permission follows native grants and revocation, never truthy malformed events", () => {
  const f = fixture();
  expect(f.permissions.readAccessibility()).toBe(false);
  f.event("true"); expect(f.change).not.toHaveBeenCalled();
  f.event(true); expect(f.permissions.readAccessibility()).toBe(true); expect(f.change).toHaveBeenCalledTimes(1);
  f.event(true); expect(f.change).toHaveBeenCalledTimes(1);
  f.event(false); expect(f.permissions.readAccessibility()).toBe(false); expect(f.change).toHaveBeenCalledTimes(2);
  f.event(true); f.permissions.reset(); expect(f.permissions.readAccessibility()).toBe(false);
});

test("repeated onboarding clicks share one pending portal request; denial permits retry", async () => {
  const f = fixture();
  let deny: (error: Error) => void = () => {};
  f.request.mockImplementation(() => new Promise((_resolve, reject) => { deny = reject; }));
  expect(f.permissions.askForAccessibility()).toBe(false);
  f.permissions.askForAccessibility();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenCalledWith("requestInsertion", { parent: "" }, 185000);
  deny(new Error("Synthetic denial"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.permissions.askForAccessibility(); expect(f.request).toHaveBeenCalledTimes(2);
  f.event(true); expect(f.permissions.askForAccessibility()).toBe(true); expect(f.request).toHaveBeenCalledTimes(2);
  deny(new Error("Synthetic cleanup"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});


test("paste permission alone does not make the shortcut ready", async () => {
  const f = fixture(); f.permissions.resetHotkey(); f.event(true);
  expect(f.permissions.readAccessibility()).toBe(false);
  f.shortcutRequest.mockResolvedValue({ installed: false });
  f.permissions.askForAccessibility();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.request).not.toHaveBeenCalled();
  expect(f.permissions.readAccessibility()).toBe(false);
  f.shortcutRequest.mockImplementation(async () => { f.shortcutEvent({ installed: true }); return { installed: true }; });
  f.permissions.askForAccessibility();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.permissions.readAccessibility()).toBe(true);
  f.shortcutEvent({ installed: false }); expect(f.permissions.readAccessibility()).toBe(false);
});


test("startup restores an existing paste grant, but still requires a shortcut grant", async () => {
  const f = fixture(); f.permissions.resetHotkey();
  f.request.mockImplementation(async () => { f.event(true); return { granted: true }; });
  f.permissions.restore();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.request).toHaveBeenCalledWith("restoreInsertion", {}, 185000);
  expect(f.permissions.readAccessibility()).toBe(false);
  f.shortcutEvent({ installed: true }); expect(f.permissions.readAccessibility()).toBe(true);
});
