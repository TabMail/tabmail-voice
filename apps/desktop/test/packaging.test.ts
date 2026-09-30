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

  /** The update feed (ADR-DESK-041): the app reads `latest-mac.yml` from TabMail's own CDN, and from
   * nowhere else (no third party sees an update check), which names the ZIP by the file name
   * electron-builder gave it, uploaded as named: no spaces. Squirrel.Mac installs from the ZIP. The
   * CDN refuses a request for several byte ranges, so a differential update asks for one at a time. */
  test("it updates only from cdn.tabmail.ai, from a ZIP named without spaces", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { publish: unknown; mac: { artifactName: string; target: { target: string }[] } };

    expect(builder.publish).toEqual([{ provider: "generic", url: "https://cdn.tabmail.ai/releases/voice/macos-arm64", useMultipleRangeRequest: false }]);
    expect(builder.mac.target.map(({ target }) => target)).toContain("zip");
    // The name the release script uploads and the feed names.
    expect(builder.mac.artifactName).toBe("TabMail-Voice-${version}-${arch}.${ext}");
  });

  /** Squirrel.Mac installs an update only if its own version is not lower than the running app's, so
   * whoever can write to the CDN can't roll the app back to an older signed build (ADR-DESK-041). It
   * then refuses any version but x.y.z, the running app's included. */
  test("it refuses to update to an older version, and its version is x.y.z", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { mac: { extendInfo: Record<string, unknown> } };
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

    expect(builder.mac.extendInfo.ElectronSquirrelPreventDowngrades).toBe(true);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /** The website's download button links to the CDN's `TabMail-Voice-arm64.dmg`, which each release
   * replaces, so the DMG's name is the same in every release. */
  test("the DMG's name is the same in every release, for the website's download link", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { dmg: { artifactName: string } };

    expect(builder.dmg.artifactName).toBe("TabMail-Voice-${arch}.${ext}");
  });
});
