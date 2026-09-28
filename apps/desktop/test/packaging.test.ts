// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(__dirname, "..");

/** What the packaged Mac app declares for the access it asks for (`voice-macos` for Calendar,
 * Reminders and Contacts, osascript for Notes and Messages): macOS ends a process that asks for
 * Calendar, Reminders or Contacts without the app's usage string, and the hardened runtime refuses
 * the access, Apple Events included, without the entitlement. */
describe("the Mac app's packaging", () => {
  test("it says why it asks for the microphone, Calendar, Reminders, Contacts and control of Notes and Messages", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { mac: { extendInfo: Record<string, unknown> } };

    for (const key of ["NSMicrophoneUsageDescription", "NSCalendarsFullAccessUsageDescription", "NSRemindersFullAccessUsageDescription", "NSContactsUsageDescription", "NSAppleEventsUsageDescription"]) {
      expect(builder.mac.extendInfo[key], key).toMatch(/^TabMail Voice .+\.$/);
    }
  });

  test("its hardened runtime allows the microphone, Calendar and Reminders, Contacts, and Apple Events to Notes and Messages", () => {
    const entitlements = readFileSync(join(root, "resources/entitlements.mac.plist"), "utf8");

    for (const key of ["com.apple.security.device.audio-input", "com.apple.security.personal-information.calendars", "com.apple.security.personal-information.addressbook", "com.apple.security.automation.apple-events"]) {
      expect(entitlements, key).toMatch(new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*<true/>`));
    }
  });
});
