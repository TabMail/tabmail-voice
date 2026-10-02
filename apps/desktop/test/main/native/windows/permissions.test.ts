// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, expect, test, vi } from "vitest";
import { windowsPermissions } from "../../../../src/main/native/windows/permissions.js";

const mocks = vi.hoisted(() => ({ media: vi.fn(), open: vi.fn() }));
// Deliberately omit macOS-only APIs: invoking them must fail the test.
vi.mock("electron", () => ({ systemPreferences: { getMediaAccessStatus: mocks.media }, shell: { openExternal: mocks.open } }));
beforeEach(() => { mocks.media.mockReset(); mocks.open.mockReset().mockResolvedValue(undefined); });

test.each(["granted", "denied", "restricted", "not-determined", "unknown"] as const)("reads the Windows microphone privacy status: %s", (status) => {
  mocks.media.mockReturnValue(status);
  expect(windowsPermissions.readMicrophone()).toBe(status);
  expect(mocks.media).toHaveBeenCalledWith("microphone");
});

test("microphone consent opens its native Windows settings", async () => {
  await windowsPermissions.askForMicrophone();
  windowsPermissions.openSettings("microphone");
  expect(mocks.open.mock.calls).toEqual([["ms-settings:privacy-microphone"], ["ms-settings:privacy-microphone"]]);
});

test("there is no separate Accessibility grant or macOS settings request", () => {
  expect(windowsPermissions.readAccessibility()).toBe(true);
  expect(windowsPermissions.askForAccessibility()).toBe(true);
  windowsPermissions.openSettings("accessibility");
  expect(mocks.open).not.toHaveBeenCalled();
});
