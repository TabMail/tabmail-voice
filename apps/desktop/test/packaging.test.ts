// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as config from "../src/core/config.js";
import { x11Argument } from "../src/main/native/linux/appImage.js";

const root = join(__dirname, "..");

/** What GnuPG makes of an OpenPGP file, read in a home of its own so no user keyring is involved. */
function gpg(...args: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "voice-gpg-"));
  try {
    return execFileSync("gpg", ["--homedir", home, "--batch", "--with-colons", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    execFileSync("gpgconf", ["--homedir", home, "--kill", "all"]);
    rmSync(home, { recursive: true, force: true });
  }
}

test("Windows packages every helper the main process can launch", () => {
  const source = readFileSync(join(root, "src/main/index.ts"), "utf8");
  const launched = [...new Set([...source.matchAll(/"(voice-[a-z-]+\.exe)"/g)].map(match => match[1]))].sort();
  const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { win: { extraResources: { from: string; filter?: string[] }[] } };
  expect(launched).toEqual(["voice-field-reader.exe", "voice-hotkey.exe", "voice-microphone.exe", "voice-productivity.exe", "voice-screen-reader.exe", "voice-windows.exe"]);
  expect(builder.win.extraResources.find(resource => resource.from === "dist/helpers")?.filter?.slice().sort()).toEqual(launched);
});

/** The helpers, the Rust core and the keyring addon use the Visual C++ runtime Windows installs
 * system-wide, where Windows Update services it (ADR-DESK-057): the installer runs the runtime
 * installer the Windows build copies, for the architecture it carries, and the app ships no copy of
 * the runtime and links none of it in. */
test("Windows installs the C++ runtime system-wide and ships none of its own", () => {
  const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { nsis: { include?: string }; win: { extraResources: { from: string; filter?: string[] }[] } };
  expect(builder.nsis.include).toBe("resources/windows/installer.nsh");
  const installer = readFileSync(join(root, builder.nsis.include!), "utf8");
  expect(installer).toContain('!getdllversion "${PROJECT_DIR}\\dist\\runtime\\vc_redist.exe" VOICE_RUNTIME_');
  expect(installer).toContain('File "/oname=$PLUGINSDIR\\vc_redist.exe" "${PROJECT_DIR}\\dist\\runtime\\vc_redist.exe"');
  expect(installer).toMatch(/!ifdef APP_ARM64\s+!define VOICE_RUNTIME_KEY "SOFTWARE\\Microsoft\\VisualStudio\\14\.0\\VC\\Runtimes\\arm64"\s+!else\s+!define VOICE_RUNTIME_KEY "SOFTWARE\\Microsoft\\VisualStudio\\14\.0\\VC\\Runtimes\\x64"/);
  expect(installer).toMatch(/!macro customInit\s+!insertmacro voiceRuntimeInstalled/);
  // Where Windows keeps the runtime's state, in both registry views (the test that runs the step
  // reads it from a test key of its own).
  expect(installer.match(/ReadRegDWORD \$R\d HKLM "\$\{VOICE_RUNTIME_KEY\}" "(Installed|\$\{NAME\})"/g)).toHaveLength(2);
  expect(installer).toMatch(/!insertmacro voiceRuntimePart Major \$\{VOICE_RUNTIME_1\}\s+!insertmacro voiceRuntimePart Minor \$\{VOICE_RUNTIME_2\}\s+!insertmacro voiceRuntimePart Bld \$\{VOICE_RUNTIME_3\}\s+!insertmacro voiceRuntimePart Rbld \$\{VOICE_RUNTIME_4\}/);
  expect(installer).toMatch(/!insertmacro voiceRuntimeInstalledIn 32\s+!insertmacro voiceRuntimeInstalledIn 64\s+!macroend/);
  expect(builder.win.extraResources.filter(resource => resource.from === "dist/runtime" || (resource.filter ?? []).some(name => /\.dll$/i.test(name)))).toEqual([]);
  expect(readFileSync(join(root, "native/windows/CMakeLists.txt"), "utf8")).not.toMatch(/CMAKE_MSVC_RUNTIME_LIBRARY|\/MT\b/);
  expect(existsSync(join(root, "native/shared/rust/.cargo/config.toml")) && readFileSync(join(root, "native/shared/rust/.cargo/config.toml"), "utf8").includes("crt-static")).toBe(false);
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
    expect(linux).toEqual(["voice-hotkey", "voice-linux", "voice-microphone", "voice-screen-reader", "voice-field-reader", "voice-files", "voice-productivity"]);
    expect(builder.linux.extraResources.find(({ from }) => from === "dist/helpers")?.filter).toEqual(linux);
    expect([...new Set(spawned)].sort()).toEqual([...new Set([...products, ...linux])].sort());
    expect([...copied].sort()).toEqual([...products].sort());
  });

  /** The update feed (ADR-DESK-041): the app reads `latest-mac.yml` from TabMail's own CDN, and from
   * nowhere else (no third party sees an update check), which names the ZIP by the file name
   * electron-builder gave it, uploaded as named: no spaces. Squirrel.Mac installs from the ZIP. The
   * CDN refuses a request for several byte ranges, so a differential update asks for one at a time.
   * Each Mac app reads the folder of the architecture it runs as (src/main/native/macos/update.ts:
   * `macos-arm64` or `macos-x64`); the release uploads each thin build's feed there. The targets
   * name no architecture, as one there would override the release's `--arm64`, `--x64` or
   * `--universal`. */
  test("it updates only from cdn.tabmail.ai, from a ZIP named without spaces", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { publish: unknown; mac: { artifactName: string; target: unknown[] } };

    expect(builder.publish).toEqual([{ provider: "generic", url: config.macUpdateFeedURL, useMultipleRangeRequest: false }]);
    expect(config.macUpdateFeedURL).toBe("https://cdn.tabmail.ai/releases/voice/macos");
    expect(builder.mac.target).toEqual(["dmg", "zip"]);
    // The name the release script uploads and the feed names.
    expect(builder.mac.artifactName).toBe("TabMail-Voice-${version}-${arch}.${ext}");
  });

  /** Windows reads its own architecture's feed on the same CDN (ADR-DESK-050):
   * electron-builder writes each build's `app-update.yml` with `${arch}` filled in, and the release
   * uploads each architecture's installer and feed to its own folder. electron-updater checks a
   * downloaded Windows installer's signature only when `app-update.yml` names a publisher, and
   * installs anything the feed offers otherwise, so every Windows build names it. */
  test("Windows updates from its architecture's folder on cdn.tabmail.ai", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { win: { publish: unknown; artifactName: string }; linux: { artifactName: string } };

    expect(builder.win.publish).toEqual([{ provider: "generic", url: "https://cdn.tabmail.ai/releases/voice/windows-${arch}", useMultipleRangeRequest: false, publisherName: [config.windowsUpdatePublisher] }]);
    expect(builder.win.artifactName).toBe("TabMail-Voice-${version}-windows-${arch}.${ext}");
    // The apt repository's Packages files point at the .deb by this name (ADR-DESK-058).
    expect(builder.linux.artifactName).toBe("TabMail-Voice-${version}-linux-${arch}.${ext}");
  });

  /** apt updates Linux (ADR-DESK-058): the package installs the repository's source, and the keys
   * that sign it where only that source trusts them; the package has no update feed of its own. */
  test("Linux installs its apt source and the keys that sign it, and the package has no update feed", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { linux: { extraResources: { from: string }[] }; deb: { publish: unknown; fpm: string[]; depends: string[] } };
    const keyring = "/etc/apt/keyrings/tabmail-voice-archive-keyring.gpg";
    const source = readFileSync(join(root, "resources/linux/tabmail-voice.sources"), "utf8");

    expect(builder.deb.publish).toBeNull();
    expect(builder.deb.fpm).toContain(`resources/linux/tabmail-voice-archive-keyring.gpg=${keyring}`);
    expect(builder.deb.fpm).toContain("resources/linux/tabmail-voice.sources=/etc/apt/sources.list.d/tabmail-voice.sources");
    // Both under /etc, which fpm lists as conffiles unless an option says otherwise, and fpm gets no
    // option here, only files: dpkg keeps the two for the same lifetime, so `apt remove` never leaves
    // the source without its keys, which would make every `apt update` after it warn. The release
    // checks the built package's conffiles before it publishes one.
    expect(builder.deb.fpm.filter(mapping => mapping.startsWith("resources/linux/tabmail-voice")).map(mapping => mapping.split("=")[1]!.startsWith("/etc/"))).toEqual([true, true]);
    expect(builder.deb.fpm.filter(argument => argument.startsWith("-") || !argument.includes("="))).toEqual([]);
    expect(source.split("\n").filter(line => line && !line.startsWith("#"))).toEqual([
      "Types: deb",
      "URIs: https://cdn.tabmail.ai/releases/voice",
      "Suites: stable",
      "Components: main",
      "Architectures: amd64 arm64",
      `Signed-By: ${keyring}`,
    ]);
    expect(builder.linux.extraResources.map(resource => resource.from)).not.toContain("resources/linux/install-update");
    expect(builder.deb.depends).not.toContain("pkexec");
  });

  /** The AppImage, for those who can't install the package (ADR-DESK-059): built on the static
   * runtime (the older one needs a libz.so a stock Ubuntu doesn't have), with an update feed of its
   * own beside the packages, and the apt keyring to check its updates' signatures with. The feed is
   * Linux's, not the AppImage target's: electron-builder writes `app-update.yml` into the app only
   * from the platform's settings, and the updater reads the name of its download folder there, so
   * without it every download fails (seen in a VM: "Error ENOENT"). The package gets the file too,
   * unread: it starts no updater. */
  test("Linux also builds an AppImage, with its own feed and the keys that sign its updates", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { toolsets: { appimage: string }; linux: { target: string[]; executableArgs: string[]; publish: unknown; extraResources: { from: string; to: string; filter?: string[] }[] }; appImage?: { publish?: unknown } };

    expect(builder.linux.target).toEqual(["deb", "AppImage"]);
    expect(builder.toolsets.appimage).toBe("1.0.3");
    expect(builder.linux.publish).toEqual([{ provider: "generic", url: "https://cdn.tabmail.ai/releases/voice/linux-${arch}", useMultipleRangeRequest: false }]);
    expect(builder.appImage?.publish).toBeUndefined();
    expect(`${config.linuxUpdateFeedURL}-\${arch}`).toBe("https://cdn.tabmail.ai/releases/voice/linux-${arch}");
    expect(builder.linux.extraResources).toContainEqual({ from: "resources/linux/tabmail-voice-archive-keyring.gpg", to: "linux/tabmail-voice-archive-keyring.gpg" });
    expect(builder.linux.extraResources).toContainEqual({ from: "resources/linux/icons", to: "linux/icons", filter: ["*.png"] });
    expect(builder.linux.executableArgs).toEqual([x11Argument]);
  });

  /** The keyring is binary OpenPGP (what apt's Signed-By reads) holding two public keys, the one
   * that signs and its offline backup, which installed apps must already trust for it to replace
   * the first (ADR-DESK-058), and nothing secret. */
  // GnuPG reads the keyring as apt's own verifier does; Windows has no GnuPG.
  test.skipIf(process.platform === "win32")("the apt keyring holds the signing key and its backup, public only", () => {
    const keyring = join(root, "resources/linux/tabmail-voice-archive-keyring.gpg");
    const records = gpg("--with-sig-check", "--show-keys", keyring).split("\n").map(line => line.split(":"));
    const keys = records.filter(([type]) => type === "pub");

    expect(keys).toHaveLength(2);
    expect(new Set(records.filter(([type]) => type === "fpr").map(record => record[9])).size).toBe(2);
    // Each can sign, neither is revoked or expired, and each carries a self-signature GnuPG checked.
    for (const key of keys) expect([key[1], key[11]?.includes("s")]).toEqual(["-", true]);
    expect(records.filter(([type, validity]) => type === "sig" && validity === "!")).toHaveLength(2);
    expect(records.filter(([type, validity]) => type === "sig" && validity !== "!")).toEqual([]);
    expect(records.filter(([type]) => type === "sec" || type === "ssb")).toEqual([]);
    expect(gpg("--list-packets", keyring)).not.toMatch(/secret (sub)?key packet/);
  });

  /** Snap's AT-SPI rules accept only unconfined peers, so each helper that reads through AT-SPI (the
   * foreground, the field, the screen) leaves the app's profile; a confined one reads nothing. */
  test("Linux runs its AT-SPI helpers outside the app's AppArmor profile", () => {
    const profile = readFileSync(join(root, "scripts/linux/apparmor-profile.tpl"), "utf8");

    for (const helper of ["voice-linux", "voice-screen-reader", "voice-field-reader"]) {
      expect(profile, helper).toContain(`"/opt/\${sanitizedProductName}/resources/helpers/${helper}" Ux,`);
    }
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

  /** Every Mac app carries the keychain's binaries for both architectures (the sign-in): npm installs
   * only the build machine's, and the build installs the other's (scripts/macos/build-native.mts).
   * The universal app is joined from an Apple silicon and an Intel build, which must hold the same
   * files; the keychain's two binaries are the same in both, each one architecture's, which the
   * join accepts only for the files `x64ArchFiles` names. */
  test("every Mac app carries both architectures' keychain binaries", () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { files: string[]; mac: { x64ArchFiles: string } };

    expect(builder.files.filter((pattern) => pattern.includes("keyring"))).toEqual([]);
    expect(builder.mac.x64ArchFiles).toBe("Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/keyring-darwin-*/*.node");
  });

  /** electron-builder joins the universal app from an Apple silicon and an Intel build, and refuses
   * when any file but a binary differs between them: each build's `app-update.yml` comes from the
   * Mac publish settings, so electron-builder's own expansion of them must not depend on the
   * architecture. */
  test("the universal app's two halves get the same update settings", async () => {
    const builder = JSON.parse(readFileSync(join(root, "electron-builder.json"), "utf8")) as { publish: Record<string, unknown>[] };
    const { expandMacro } = (await import("app-builder-lib/out/util/macroExpander.js")) as { expandMacro: (pattern: string, arch: string, appInfo: object) => string };
    const expanded = (arch: string) => JSON.stringify(builder.publish.map((options) => Object.fromEntries(Object.entries(options).map(([key, value]) => [key, typeof value === "string" ? expandMacro(value, arch, { version: "1.0.0" }) : value]))));

    expect(expanded("x64")).toBe(expanded("arm64"));
  });

  /** The website's download links go to the CDN's `TabMail-Voice-latest-universal.dmg`,
   * `TabMail-Voice-latest-arm64.dmg` and `TabMail-Voice-latest-x64.dmg`, which each release replaces, so the DMG's name is the same in every release and the same as the CDN's. */
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
