// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import * as config from "../../../../src/core/config.js";
import { log } from "../../../../src/core/log.js";
import { refusal, type WindowsUpdateSource, windowsUpdatePlatform } from "../../../../src/main/native/windows/update.js";
import type { RunFile } from "../../../../src/main/updater.js";

/** `NsisUpdater` as the adapter sees it. */
class FakeNsis extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowDowngrade = false;
  requestHeaders = null;
  disableWebInstaller = false;
  verifyUpdateCodeSignature: WindowsUpdateSource["verifyUpdateCodeSignature"] = () => Promise.resolve("the library's own check");
  installedWith: unknown[] = [];
  checkForUpdates() {
    return Promise.resolve(null);
  }
  quitAndInstall(...args: unknown[]) {
    this.installedWith = args;
  }
}

const signed = { signatureValid: true, commonName: config.windowsUpdatePublisher, organization: config.windowsUpdatePublisher, productVersion: "1.2.3.0" };

function setUp(reply: Awaited<ReturnType<RunFile>> | Error) {
  const source = new FakeNsis();
  const calls: [string, string[], number | undefined][] = [];
  const run: RunFile = (file, args, timeout) => {
    calls.push([file, args, timeout]);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  const platform = windowsUpdatePlatform({ source: source as unknown as WindowsUpdateSource, helper: "C:\\helpers\\voice-windows.exe", run });
  return { source, platform, calls };
}

describe("Windows updates (ADR-DESK-050)", () => {
  test("only a full installer, installed when the app quits", () => {
    const { source, platform } = setUp({ code: 0, stdout: "" });

    expect(source.disableWebInstaller).toBe(true);
    expect(platform.installsOnQuit).toBe(true);
  });

  test("a downloaded installer is kept only when the helper proves it signed by TabMail and the offered version", async () => {
    const logged = vi.spyOn(log, "error");
    const { source, calls } = setUp({ code: 0, stdout: JSON.stringify(signed) });
    source.emit("update-available", { version: "1.2.3" });

    expect(await source.verifyUpdateCodeSignature(["ignored"], "C:\\cache\\installer.exe")).toBeNull();
    expect(calls).toEqual([["C:\\helpers\\voice-windows.exe", ["--verify-update", "C:\\cache\\installer.exe"], config.updateVerifyTimeout]]);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  /** The feed names the version; only the installer's signed resources can be trusted to say it. */
  test("an older signed installer offered as newer is refused, and the log says why", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const { source } = setUp({ code: 0, stdout: JSON.stringify({ ...signed, productVersion: "1.0.0.0" }) });
      source.emit("update-available", { version: "1.2.3" });

      expect(await source.verifyUpdateCodeSignature([], "installer.exe")).toBe("its signed version isn't the one offered");
      expect(logged.mock.calls).toEqual([["Updater: 1.2.3 refused: its signed version isn't the one offered"]]);
    } finally {
      logged.mockRestore();
    }
  });

  test.each<[string, Awaited<ReturnType<RunFile>> | Error, string]>([
    ["exits with an error", { code: 1, stdout: "" }, "the signature couldn't be read"],
    ["can't run", new Error("ENOENT"), "the signature couldn't be read"],
    ["answers garbage", { code: 0, stdout: "not json" }, "the signature couldn't be read"],
    ["answers without the fields", { code: 0, stdout: JSON.stringify({ signatureValid: true }) }, "the signature couldn't be read"],
    ["answers null", { code: 0, stdout: "null" }, "the signature couldn't be read"],
  ])("a helper that %s refuses the installer", async (_case, reply, reason) => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const { source } = setUp(reply);
      source.emit("update-available", { version: "1.2.3" });

      expect(await source.verifyUpdateCodeSignature([], "installer.exe")).toBe(reason);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("an installer downloaded with no update offered is refused", async () => {
    const { source, calls } = setUp({ code: 0, stdout: JSON.stringify(signed) });

    expect(await source.verifyUpdateCodeSignature([], "installer.exe")).toBe("no update was offered");
    expect(calls).toEqual([]);
  });

  test.each<[string, object, string | null]>([
    ["signed by TabMail", {}, null],
    ["an untrusted signature", { signatureValid: false }, "Windows doesn't trust its signature"],
    ["another publisher's name", { commonName: "Someone Else" }, "it isn't signed by TabMail"],
    ["another organization", { organization: "Someone Else" }, "it isn't signed by TabMail"],
    ["another version", { productVersion: "1.2.4.0" }, "its signed version isn't the one offered"],
    ["a three-part version", { productVersion: "1.2.3" }, "its signed version isn't the one offered"],
  ])("%s: %s", (_case, change, reason) => {
    expect(refusal({ ...signed, ...change }, "1.2.3")).toBe(reason);
  });

  test("the proof is done in the download; the install is quiet, and opens the new version", async () => {
    const { source, platform } = setUp({ code: 0, stdout: "" });

    await expect(platform.verify({ version: "1.2.3" })).resolves.toBeUndefined();
    await platform.install({ version: "1.2.3" });
    expect(source.installedWith).toEqual([true, true]);
  });
});
