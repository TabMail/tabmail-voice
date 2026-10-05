// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as config from "../src/core/config.js";

const root = join(__dirname, "..");

test("Windows packages every helper the main process can launch", () => {
  const source = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const launched = [...new Set([...source.matchAll(/"(voice-[a-z-]+\.exe)"/g)].map(match => match[1]))].sort();
  const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { win: { extraResources: { from: string; filter?: string[] }[] } };
  expect(launched).toEqual(["voice-hotkey.exe", "voice-productivity.exe", "voice-screen-reader.exe", "voice-windows.exe"]);
  expect(builder.win.extraResources.find(resource => resource.from === "dist/helpers")?.filter?.slice().sort()).toEqual(launched);
});

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

  /** The helpers the build copies into the app are every executable the Swift package makes, and
   * among them every one the app runs on a Mac: a helper left out would fail to spawn, and its
   * part (the microphone, the hotkey, the paste) with it. */
  test("it carries every Swift helper the app runs", () => {
    const build = readFileSync(join(root, "scripts/macos/build-native.mts"), "utf8");
    const copied = JSON.parse(/const helpers = (\[[^\]]*\]);/.exec(build)?.[1] ?? "null") as string[];
    const products = [...readFileSync(join(root, "native/macos/Package.swift"), "utf8").matchAll(/\.executable\(name: "([^"]+)"/g)].map(([, name = ""]) => name);
    // Each executable joined to the helpers folder, excluding Windows `.exe` names.
    // Linux helpers have their own build and packaging inventory.
    const spawned = [...readFileSync(join(root, "src/main/index.ts"), "utf8").matchAll(/join\(helpers, ([^)]*)\)/g)].flatMap(([, args = ""]) => [...args.matchAll(/"(voice-[a-z-]+)"/g)].map(([, name = ""]) => name));

    const linuxBuild = readFileSync(join(root, "scripts/linux/build-native.mts"), "utf8");
    const linux = JSON.parse(/for \(const helper of (\[[^\]]*\])\)/.exec(linuxBuild)?.[1] ?? "null") as string[];
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { linux: { extraResources: { from: string; filter: string[] }[] } };
    expect(linux).toEqual(["voice-hotkey", "voice-linux", "voice-screen-reader", "voice-files", "voice-productivity"]);
    expect(builder.linux.extraResources.find(({ from }) => from === "dist/helpers")?.filter).toEqual(linux);
    expect([...new Set(spawned)].sort()).toEqual([...new Set([...products, ...linux])].sort());
    expect([...copied].sort()).toEqual([...products].sort());
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

  /** Windows and Linux read their own architecture's feed on the same CDN (ADR-DESK-050):
   * electron-builder writes each build's `app-update.yml` with `${arch}` filled in, and the release
   * uploads each architecture's installer and feed to its own folder. electron-updater checks a
   * downloaded Windows installer's signature only when `app-update.yml` names a publisher, and
   * installs anything the feed offers otherwise, so every Windows build names it. */
  test("Windows and Linux update from their architecture's folder on cdn.tabmail.ai", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { win: { publish: unknown; artifactName: string }; linux: { publish: unknown; artifactName: string } };

    expect(builder.win.publish).toEqual([{ provider: "generic", url: "https://cdn.tabmail.ai/releases/voice/windows-${arch}", useMultipleRangeRequest: false, publisherName: [config.windowsUpdatePublisher] }]);
    expect(builder.linux.publish).toEqual([{ provider: "generic", url: "https://cdn.tabmail.ai/releases/voice/linux-${arch}", useMultipleRangeRequest: false }]);
    expect(builder.win.artifactName).toBe("TabMail-Voice-${version}-windows-${arch}.${ext}");
    expect(builder.linux.artifactName).toBe("TabMail-Voice-${version}-linux-${arch}.${ext}");
  });

  /** A Linux update is proven and installed by `install-update`, packaged executable, root-owned
   * under /opt with the keys it checks against, and it needs `openssl` and `pkexec` (ADR-DESK-050). */
  test("Linux ships install-update, its keys, and what it runs", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { linux: { extraResources: { from: string; to?: string; filter?: string[] }[] }; deb: { depends: string[] } };

    expect(builder.linux.extraResources).toContainEqual({ from: "resources/linux/install-update", to: "linux/install-update" });
    expect(builder.linux.extraResources).toContainEqual({ from: "resources/linux/update-keys", to: "linux/update-keys", filter: ["*.pem"] });
    expect(statSync(join(root, "resources/linux/install-update")).mode & 0o111).toBe(0o111);
    expect(builder.deb.depends).toEqual(expect.arrayContaining(["openssl", "pkexec"]));
  });

  /** The app's AppArmor profile is inherited by what it runs: the root install leaves it at the
   * pkexec the app runs, or dpkg can't replace the files the profile names (found in the Ubuntu VM). */
  test("Linux installs an update outside the app's AppArmor profile", () => {
    const profile = readFileSync(join(root, "scripts/linux/apparmor-profile.tpl"), "utf8");
    const adapter = readFileSync(join(root, "src/main/native/linux/update.ts"), "utf8");

    expect(profile).toMatch(/^\s*\/usr\/bin\/pkexec Ux,$/m);
    expect(adapter).toContain('"/usr/bin/pkexec"');
  });

  /** Snap's AT-SPI rules accept only unconfined peers, so each helper that reads through AT-SPI (the
   * foreground, the field, the screen) leaves the app's profile; a confined one reads nothing. */
  test("Linux runs its AT-SPI helpers outside the app's AppArmor profile", () => {
    const profile = readFileSync(join(root, "scripts/linux/apparmor-profile.tpl"), "utf8");

    for (const helper of ["voice-linux", "voice-screen-reader"]) {
      expect(profile, helper).toContain(`"/opt/\${sanitizedProductName}/resources/helpers/${helper}" Ux,`);
    }
  });

  /** The administrator's authentication dialog says what it is for, not install-update's command line
   * with its signature: a polkit action for the packaged script, installed where polkit reads them,
   * asking for an administrator every time (ADR-DESK-050). */
  test("Linux asks for an administrator to install an update, in words", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { productName: string; deb: { fpm: string[] } };
    const policy = readFileSync(join(root, "resources/linux/ai.tabmail.voice.install-update.policy"), "utf8");

    expect(builder.deb.fpm).toContain("resources/linux/ai.tabmail.voice.install-update.policy=/usr/share/polkit-1/actions/ai.tabmail.voice.install-update.policy");
    // The path pkexec runs: the package installs the app under /opt/<productName>.
    expect(policy).toContain(`<annotate key="org.freedesktop.policykit.exec.path">/opt/${builder.productName}/resources/linux/install-update</annotate>`);
    expect(policy).toContain("<message>Authentication is required to install a TabMail Voice update.</message>");
    expect([...policy.matchAll(/<allow_(?:any|inactive|active)>([^<]*)</g)].map(([, value]) => value)).toEqual(["auth_admin", "auth_admin", "auth_admin"]);
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

  /** The website's download button links to the CDN's `TabMail-Voice-latest-arm64.dmg`, which each
   * release replaces, so the DMG's name is the same in every release and the same as the CDN's. */
  test("the DMG's name is the same in every release, for the website's download link", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { dmg: { artifactName: string } };

    expect(builder.dmg.artifactName).toBe("TabMail-Voice-latest-${arch}.${ext}");
  });

  /** The DMG window is its background's size, and Finder's path and status bars take the bottom of
   * it: the app and the Applications link sit in the top half, so neither falls under the bars and
   * the window never scrolls. The background comes at 1x and 2x, the 2x twice the 1x. */
  test("the DMG window shows both icons without scrolling, on a background at both scales, under the app's name", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { dmg: { title: string; background: string; contents: { y: number; type: string }[] } };
    const size = (file: string) => {
      const png = readFileSync(join(root, "resources", file));
      return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    };
    const background = size(builder.dmg.background);
    const retina = size(builder.dmg.background.replace(/\.png$/, "@2x.png"));

    expect(retina).toEqual({ width: background.width * 2, height: background.height * 2 });
    expect(builder.dmg.contents.map((item) => item.type).sort()).toEqual(["file", "link"]);
    for (const item of builder.dmg.contents) expect(item.y).toBeLessThanOrEqual(background.height / 2);
    // The window's title and the mounted volume's name: the app's, without a version.
    expect(builder.dmg.title).toBe("TabMail Voice");
  });
});


test("every platform ships the tray icon and its marked form at each scale, the mark beside the glyph", () => {
  const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { extraResources: { from: string; filter?: string[] }[] };
  const tray = readFileSync(join(root, "src/main/tray.ts"), "utf8");
  const shipped = builder.extraResources.find(({ from }) => from === "resources")?.filter ?? [];
  const size = (file: string) => {
    const png = readFileSync(join(root, "resources", file));
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  };

  for (const name of ["trayTemplate", "trayTemplateMarked"]) {
    expect(tray).toContain(`"${name}.png"`);
    for (const scale of ["", "@2x", "@3x"]) expect(shipped.some((pattern) => new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`).test(`${name}${scale}.png`))).toBe(true);
  }
  for (const [scale, factor] of [["", 1], ["@2x", 2], ["@3x", 3]] as const) {
    const plain = size(`trayTemplate${scale}.png`);
    const marked = size(`trayTemplateMarked${scale}.png`);
    expect(marked.height).toBe(plain.height);
    expect(marked.width - plain.width).toBe(6 * factor);
  }
});


test("Linux ships the PNG consumed by native Settings windows", () => {
  const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { linux: { extraResources: { from: string; to?: string }[] } };
  expect(builder.linux.extraResources).toContainEqual({ from: "resources/icon.png", to: "icon.png" });
  expect(readFileSync(join(root, "resources/icon.png")).subarray(1, 4).toString()).toBe("PNG");
});


test("Linux launcher icons include theme-indexed sizes, not only the 1024px source", () => {
  const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { linux: { icon: string } };
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const png = readFileSync(join(root, builder.linux.icon, `${size}x${size}.png`));
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
});
