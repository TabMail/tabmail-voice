// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test, vi } from "vitest";
import { type MicrophoneStatus, PermissionsModel, type PermissionSystem } from "../../../src/core/onboarding/permissions.js";

describe("PermissionsModel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function system(state: { microphone: MicrophoneStatus; trusted: boolean }): PermissionSystem & { opened: string[]; asked: number } {
    return {
      opened: [],
      asked: 0,
      readMicrophone: () => state.microphone,
      readAccessibility: () => state.trusted,
      async askForMicrophone() {
        this.asked += 1;
        state.microphone = "granted";
      },
      askForAccessibility: () => state.trusted,
      openSettings(pane) {
        this.opened.push(pane);
      },
    };
  }

  /** Each grant is announced once, as it lands, not again at later refreshes. */
  test("announces each grant once when it lands", () => {
    const state = { microphone: "not-determined" as MicrophoneStatus, trusted: false };
    const permissions = new PermissionsModel(system(state));
    const heard: string[] = [];
    permissions.onMicrophoneGranted = () => heard.push("microphone");
    permissions.onAccessibilityGranted = () => heard.push("accessibility");

    permissions.refresh();
    state.microphone = "granted";
    permissions.refresh();
    permissions.refresh();
    state.trusted = true;
    permissions.refresh();
    permissions.refresh();

    expect(heard).toEqual(["microphone", "accessibility"]);
    expect(permissions.allGranted).toBe(true);

    // Revoked and granted again: announced again.
    state.microphone = "denied";
    permissions.refresh();
    state.microphone = "granted";
    permissions.refresh();
    expect(heard).toEqual(["microphone", "accessibility", "microphone"]);
  });

  /** Denied and undecided grants are kept as read, as well as granted ones. */
  test.each<[MicrophoneStatus, boolean]>([
    ["not-determined", false],
    ["restricted", true],
    ["denied", false],
    ["granted", false],
    ["granted", true],
  ])("starts with the states read from the system (%s, %s)", (microphone, trusted) => {
    const permissions = new PermissionsModel(system({ microphone, trusted }));
    expect(permissions.microphone).toBe(microphone);
    expect(permissions.accessibilityTrusted).toBe(trusted);
  });

  test("asking for the microphone prompts once, then sends a refusal to System Settings", async () => {
    const state = { microphone: "not-determined" as MicrophoneStatus, trusted: true };
    const fake = system(state);
    const permissions = new PermissionsModel(fake);

    await permissions.requestMicrophone();
    expect([fake.asked, permissions.microphone]).toEqual([1, "granted"]);

    state.microphone = "denied";
    await permissions.requestMicrophone();
    expect(fake.asked).toBe(1);
    expect(fake.opened).toEqual(["microphone"]);
  });

  /** The Accessibility grant happens in System Settings: the model watches for it, and stops
   * watching once it lands. */
  test("watches for the Accessibility grant until it lands", () => {
    vi.useFakeTimers();
    const state = { microphone: "granted" as MicrophoneStatus, trusted: false };
    const fake = system(state);
    const permissions = new PermissionsModel(fake, 1_000);
    let granted = 0;
    permissions.onAccessibilityGranted = () => {
      granted += 1;
    };

    permissions.requestAccessibility();
    expect(fake.opened).toEqual(["accessibility"]);
    vi.advanceTimersByTime(3_000);
    expect(granted).toBe(0);
    state.trusted = true;
    vi.advanceTimersByTime(1_000);
    expect(granted).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
