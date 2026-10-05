// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NsisUpdater } from "electron-updater";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../../src/core/config.js";
import { log } from "../../../../src/core/log.js";
import { MemoryStore } from "../../../../src/core/util/keyValueStore.js";
import { type WindowsUpdateSource, windowsUpdatePlatform } from "../../../../src/main/native/windows/update.js";
import { type RunFile, Updater } from "../../../../src/main/updater.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * The real `NsisUpdater` with an installer already in its cache: a feed naming that installer's
 * SHA-512 gets it back without a download, and without the proof a download gets. The installer
 * isn't run (`doInstall` counts), nothing reaches the network (a download writes the same synthetic
 * installer; any other request fails), and `voice-windows.exe` answers that the installer is signed
 * by TabMail as `signedVersion`.
 */
function world(options: { signedVersion: string; proofDelay?: number }) {
  vi.spyOn(log, "error").mockImplementation(() => {});
  const root = mkdtempSync(join(tmpdir(), "voice-install-at-quit-"));
  roots.push(root);
  const appUpdateConfig = join(root, "app-update.yml");
  writeFileSync(appUpdateConfig, "provider: generic\nurl: https://updates.example.com/voice\npublisherName:\n  - Lisem AI LTD\nupdaterCacheDirName: tabmail-voice-updater\n");
  const pending = join(root, "cache", "tabmail-voice-updater", "pending");
  mkdirSync(pending, { recursive: true });
  const fileName = "TabMail-Voice-windows-x64.exe";
  const bytes = Buffer.from("a synthetic installer kept from an earlier download");
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  writeFileSync(join(pending, fileName), bytes);
  writeFileSync(join(pending, "update-info.json"), JSON.stringify({ fileName, sha512, isAdminRightsRequired: false }));

  let quitHandler: ((exitCode: number) => void) | null = null;
  const electronApp = {
    version: "1.2.0",
    name: "TabMail Voice",
    isPackaged: true,
    appUpdateConfigPath: appUpdateConfig,
    userDataPath: root,
    baseCachePath: join(root, "cache"),
    whenReady: () => Promise.resolve(),
    relaunch() {},
    quit() {},
    onQuit(handler: (exitCode: number) => void) {
      quitHandler = handler;
    },
  };
  const library = new NsisUpdater(null, electronApp as never) as unknown as WindowsUpdateSource & {
    logger: null;
    httpExecutor: unknown;
    doInstall: (options: unknown) => boolean;
    updateInfoAndProvider: unknown;
    downloadUpdate: () => Promise<unknown>;
    emit: (event: string, info: unknown) => boolean;
  };
  library.logger = null;
  library.httpExecutor = {
    request: () => Promise.reject(new Error("no network in tests")),
    // A download (a version other than the one cached) gets the same synthetic installer.
    download: (_url: unknown, destination: string) => {
      writeFileSync(destination, bytes);
      return Promise.resolve(destination);
    },
  };
  let installs = 0;
  library.doInstall = () => {
    installs += 1;
    return true;
  };
  const signature = { signedVersion: options.signedVersion };
  const run: RunFile = () =>
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            code: 0,
            stdout: JSON.stringify({ signatureValid: true, commonName: config.windowsUpdatePublisher, organization: config.windowsUpdatePublisher, productVersion: signature.signedVersion }),
          }),
        options.proofDelay ?? 0,
      ),
    );
  const updater = new Updater({
    platform: windowsUpdatePlatform({ source: library, helper: "voice-windows.exe", run }),
    store: new MemoryStore(),
    currentVersion: electronApp.version,
    ask: () => Promise.resolve(false),
    tell: () => {},
    isBusy: () => false,
    onChange: () => {},
  });
  /** The feed offers `version`, naming the kept installer; the library gets it from its cache. */
  const offer = async (version: string) => {
    const info = { version, files: [{ url: fileName, sha512, size: bytes.length }], path: fileName, sha512, releaseDate: new Date().toISOString() };
    const provider = new GenericProvider({ provider: "generic", url: "https://updates.example.com/voice" }, library as never, { isUseMultipleRangeRequest: false, platform: "win32", executor: null } as never);
    library.updateInfoAndProvider = { info, provider };
    library.emit("update-available", info);
    await library.downloadUpdate();
  };
  /** The app quits: `before-quit` (the app's), then the library's `quit`. */
  const quit = () => {
    updater.quitting();
    quitHandler?.(0);
    return installs;
  };
  const proven = () => new Promise((resolve) => setTimeout(resolve, (options.proofDelay ?? 0) + 50));
  return { updater, offer, quit, proven, signature };
}

describe("Windows: what installs when the app quits (ADR-DESK-050), with the real NsisUpdater", () => {
  test("an installer proven TabMail's and the version offered installs at the quit", async () => {
    const { updater, offer, quit, proven } = world({ signedVersion: "1.3.0.0" });
    await offer("1.3.0");
    await proven();

    expect(updater.state).toEqual({ kind: "ready", version: "1.3.0", installsOnQuit: true });
    expect(quit()).toBe(1);
  });

  test("a kept installer offered as a version that isn't newer doesn't install at the quit", async () => {
    const { updater, offer, quit, proven } = world({ signedVersion: "1.1.0.0" });
    await offer("1.3.0-beta.1");
    await proven();

    expect(updater.state).toMatchObject({ kind: "failed", version: "1.3.0-beta.1" });
    expect(quit()).toBe(0);
  });

  test("a kept older installer offered as newer doesn't install at the quit", async () => {
    const { updater, offer, quit, proven } = world({ signedVersion: "1.1.0.0" });
    await offer("1.3.0");
    await proven();

    expect(updater.state).toMatchObject({ kind: "failed", version: "1.3.0" });
    expect(quit()).toBe(0);
  });

  test("a quit while the kept installer is still being proven doesn't install it", async () => {
    const { updater, offer, quit, proven } = world({ signedVersion: "1.3.0.0", proofDelay: 200 });
    await offer("1.3.0");

    expect(updater.state).toEqual({ kind: "downloading", version: "1.3.0" });
    expect(quit()).toBe(0);
    await proven();
  });

  test("an update refused earlier doesn't stop a later proven one installing at the quit", async () => {
    const { updater, offer, quit, proven, signature } = world({ signedVersion: "1.1.0.0" });
    await offer("1.3.0");
    await proven();
    expect(updater.state).toMatchObject({ kind: "failed", version: "1.3.0" });

    signature.signedVersion = "1.3.1.0";
    await offer("1.3.1");
    await proven();

    expect(updater.state).toEqual({ kind: "ready", version: "1.3.1", installsOnQuit: true });
    expect(quit()).toBe(1);
  });
});
