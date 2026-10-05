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
  const shortcutEvents = new Map<string, (message: Record<string, unknown>) => void>();
  const shortcutRequest = vi.fn<HelperClient["request"]>().mockResolvedValue({ installed: true });
  const shortcut = { request: shortcutRequest, on: (name: string, handler: (message: Record<string, unknown>) => void) => { shortcutEvents.set(name, handler); } };
  const permissions = new LinuxPermissions(helper as unknown as HelperClient, shortcut as unknown as HelperClient);
  const shortcutEvent = (message: Record<string, unknown>) => shortcutEvents.get("hotkeyInstallationChanged")?.(message);
  shortcutEvent({ installed: true });
  const change = vi.fn(); permissions.onChange = change;
  return { permissions, request, change, shortcutRequest, shortcutEvent, unavailable: () => shortcutEvents.get("hotkeyUnavailable")?.({}), event: (granted: unknown) => event({ granted }) };
}

test("Right Alt the Shell can't hold is reported until a dictation key is held or another is chosen", () => {
  const f = fixture();
  expect(f.permissions.hotkeyUnavailable).toBe(false);
  f.unavailable();
  expect(f.permissions.hotkeyUnavailable).toBe(true); expect(f.change).toHaveBeenCalledTimes(1);
  f.shortcutEvent({ installed: true });
  expect(f.permissions.hotkeyUnavailable).toBe(false);
  f.unavailable(); f.permissions.resetHotkey();
  expect(f.permissions.hotkeyUnavailable).toBe(false);
  f.unavailable(); f.shortcutEvent({ installed: false });
  expect(f.permissions.hotkeyUnavailable).toBe(true);
});

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

/** GNOME integration, as the app's `GnomeIntegration` reports it. */
function gnomeFixture(initial: "checking" | "available" | "restart" | "ready" | "unsupported" | "unavailable", after: typeof initial) {
  const gnome = { state: initial as typeof initial, enable: vi.fn(async () => { gnome.state = after; }) };
  let event: (message: Record<string, unknown>) => void = () => {};
  const request = vi.fn<HelperClient["request"]>().mockImplementation(async () => { event({ granted: true }); return { granted: true }; });
  const helper = { request, on: (_name: string, handler: typeof event) => { event = handler; } };
  const shortcutEvents = new Map<string, (message: Record<string, unknown>) => void>();
  const shortcutEvent = (message: Record<string, unknown>) => shortcutEvents.get("hotkeyInstallationChanged")?.(message);
  const shortcutRequest = vi.fn<HelperClient["request"]>().mockImplementation(async () => { shortcutEvent({ installed: true }); return { installed: true }; });
  const shortcut = { request: shortcutRequest, on: (name: string, handler: (message: Record<string, unknown>) => void) => { shortcutEvents.set(name, handler); } };
  const permissions = new LinuxPermissions(helper as unknown as HelperClient, shortcut as unknown as HelperClient, () => "", gnome);
  return { permissions, gnome, request, shortcutRequest, shortcutEvent: (installed: boolean) => shortcutEvent({ installed }), event: (granted: boolean) => event({ granted }) };
}

test.each(["checking", "available", "restart", "unavailable"] as const)("on GNOME, the keyboard is not ready while GNOME integration is %s", (state) => {
  const f = gnomeFixture(state, state);
  f.shortcutEvent(true); f.event(true);
  expect(f.permissions.readAccessibility()).toBe(false);
  f.gnome.state = "ready";
  expect(f.permissions.readAccessibility()).toBe(true);
});

test("on GNOME, Allow is not granted at once while integration is not on, though the key and pasting are", () => {
  const f = gnomeFixture("available", "restart");
  f.shortcutEvent(true); f.event(true);
  expect(f.permissions.askForAccessibility()).toBe(false);
});

test("GNOME releases without the extension go without it", () => {
  const f = gnomeFixture("unsupported", "unsupported");
  f.shortcutEvent(true); f.event(true);
  expect(f.permissions.readAccessibility()).toBe(true);
});

test("allowing the keyboard turns GNOME integration on first, then asks for the key and keyboard control", async () => {
  const f = gnomeFixture("available", "ready");
  const order: string[] = [];
  f.gnome.enable.mockImplementation(async () => { order.push("enable"); f.gnome.state = "ready"; });
  f.shortcutRequest.mockImplementation(async () => { order.push("requestHotkey"); f.shortcutEvent(true); return { installed: true }; });
  f.request.mockImplementation(async () => { order.push("requestInsertion"); f.event(true); return { granted: true }; });
  expect(f.permissions.askForAccessibility()).toBe(false);
  await vi.waitFor(() => expect(f.permissions.readAccessibility()).toBe(true));
  expect(order).toEqual(["enable", "requestHotkey", "requestInsertion"]);
});

test("GNOME integration that needs a log-out asks for nothing else until it is on", async () => {
  const f = gnomeFixture("available", "restart");
  f.permissions.askForAccessibility();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.gnome.enable).toHaveBeenCalledTimes(1);
  expect(f.shortcutRequest).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.permissions.readAccessibility()).toBe(false);
});

test("GNOME integration already on is not enabled again", async () => {
  const f = gnomeFixture("ready", "ready");
  f.permissions.askForAccessibility();
  await vi.waitFor(() => expect(f.permissions.readAccessibility()).toBe(true));
  expect(f.gnome.enable).not.toHaveBeenCalled();
});
