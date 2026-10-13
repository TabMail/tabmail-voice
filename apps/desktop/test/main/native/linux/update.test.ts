// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import * as config from "../../../../src/core/config.js";
import { log } from "../../../../src/core/log.js";
import { type AppImageUpdateSource, appImageUpdatePlatform, relaunchAfterExit, updateStatement } from "../../../../src/main/native/linux/update.js";
import { type RunFile, runFile, UpdateError } from "../../../../src/main/updater.js";

/** `AppImageUpdater` as the adapter sees it: the feed it was given, and an install that did or didn't. */
class FakeSource extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  requestHeaders = null;
  feed: unknown = null;
  installedWith: unknown[] | null = null;
  constructor(private readonly installs = true, private readonly events: string[] = []) {
    super();
  }
  setFeedURL(options: unknown) {
    this.feed = options;
  }
  checkForUpdates() {
    return Promise.resolve(null);
  }
  install(...args: unknown[]) {
    this.events.push("install");
    this.installedWith = args;
    return this.installs;
  }
}

const keyring = "/tmp/.mount_TabMail/resources/linux/tabmail-voice-archive-keyring.gpg";

function setUp(options: { reply?: Awaited<ReturnType<RunFile>> | Error; installs?: boolean; arch?: string; run?: RunFile; keyring?: string } = {}) {
  const events: string[] = [];
  const source = new FakeSource(options.installs ?? true, events);
  /** Each gpgv run, with what its files held as it ran. */
  const runs: { file: string; args: string[]; timeout: number | undefined; statement: string; signature: Buffer }[] = [];
  const run: RunFile = options.run ?? ((file, args, timeout) => {
    runs.push({ file, args, timeout, statement: readFileSync(args.at(-1)!, "utf8"), signature: readFileSync(args.at(-2)!) });
    const reply = options.reply ?? { code: 0, stdout: "" };
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  const relaunch = vi.fn(() => events.push("relaunch"));
  const quit = vi.fn(() => events.push("quit"));
  const platform = appImageUpdatePlatform({
    source: source as unknown as AppImageUpdateSource,
    appImage: "/home/user/Apps/TabMail-Voice-latest-linux-x64.AppImage",
    keyring: options.keyring ?? keyring,
    arch: options.arch ?? "x64",
    args: ["--ozone-platform=x11"],
    run,
    quit,
    relaunch,
  });
  return { platform, source, runs, relaunch, quit, events };
}

async function refusal(promise: Promise<void>): Promise<UpdateError> {
  const error: unknown = await promise.then(() => null, (reason: unknown) => reason);
  if (!(error instanceof UpdateError)) throw new Error("not refused with an UpdateError");
  return error;
}

/** A downloaded AppImage, its SHA-512 as the feed and the statement write it. */
function download(folder: string, bytes = "an AppImage"): { path: string; sha512: string } {
  const path = join(folder, "update.AppImage");
  writeFileSync(path, bytes);
  return { path, sha512: createHash("sha512").update(bytes).digest("base64") };
}

describe("Linux AppImage updates (ADR-DESK-059)", () => {
  test("the statement the release signs", () => {
    expect(updateStatement("arm64", "1.2.3", "c2hhNTEy")).toBe("TabMail Voice update\npackage: tabmail-voice-appimage\narchitecture: arm64\nversion: 1.2.3\nsha512: c2hhNTEy\n");
  });

  test.each(["x64", "arm64"])("on %s the feed is that architecture's folder, asked for one byte range at a time", (arch) => {
    const { source } = setUp({ arch });

    expect(source.feed).toEqual({ provider: "generic", url: `https://cdn.tabmail.ai/releases/voice/linux-${arch}`, useMultipleRangeRequest: false });
  });

  /** gpgv, in a home of its own, checks the signature from the feed over the statement of this
   * architecture, the offered version and the SHA-512 the app computed of the file it downloaded. */
  test("a download is ready once gpgv holds the feed's signature over its statement", async () => {
    const folder = mkdtempSync(join(tmpdir(), "voice-appimage-"));
    try {
      const file = download(folder);
      const { platform, runs } = setUp({ arch: "arm64" });

      await platform.verify({ version: "1.2.3", signature: Buffer.from("a signature").toString("base64"), downloadedFile: file.path });

      expect(runs).toHaveLength(1);
      const [{ file: program, args, timeout, statement, signature }] = runs as [typeof runs[0]];
      expect(program).toBe(config.gpgvPath);
      expect(timeout).toBe(config.updateVerifyTimeout);
      expect(statement).toBe(updateStatement("arm64", "1.2.3", file.sha512));
      expect(signature.toString()).toBe("a signature");
      const home = args[1]!;
      expect(args).toEqual(["--homedir", home, "--keyring", keyring, join(home, "statement.sig"), join(home, "statement")]);
      // The files are gone once checked.
      expect(existsSync(home)).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("a signature gpgv refuses is not TabMail's, and the files are gone", async () => {
    const folder = mkdtempSync(join(tmpdir(), "voice-appimage-"));
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      const { platform, runs } = setUp({ reply: { code: 1, stdout: "" } });

      const error = await refusal(platform.verify({ version: "1.2.3", signature: "c2ln", downloadedFile: download(folder).path }));

      expect(error.message).toBe("Version 1.2.3 isn't signed by TabMail, so it wasn't installed.");
      expect(existsSync(runs[0]!.args[1]!)).toBe(false);
      expect(logged).toHaveBeenCalledWith("Updater: 1.2.3 refused: gpgv exit 1");
    } finally {
      logged.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("gpgv that can't run refuses the update too", async () => {
    const folder = mkdtempSync(join(tmpdir(), "voice-appimage-"));
    try {
      const { platform, runs } = setUp({ reply: new Error("ENOENT") });

      await expect(platform.verify({ version: "1.2.3", signature: "c2ln", downloadedFile: download(folder).path })).rejects.toThrow("ENOENT");
      expect(existsSync(runs[0]!.args[1]!)).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test.each([
    ["no signature in the feed", { version: "1.2.3", downloadedFile: "/home/user/.cache/update.AppImage" }],
    ["no downloaded file", { version: "1.2.3", signature: "c2ln" }],
  ])("%s: refused without running gpgv", async (_case, update) => {
    const { platform, runs } = setUp();

    expect((await refusal(platform.verify(update))).message).toBe("Version 1.2.3 isn't signed by TabMail, so it wasn't installed.");
    expect(runs).toEqual([]);
  });

  /** Restart Now: the library replaces the AppImage (and runs the new one only to let its launcher
   * exit), then the app opens the new one once it has quit, and quits. */
  test("installing replaces the AppImage, then opens the new one after the app quits", async () => {
    const { platform, source, relaunch, events } = setUp();

    await platform.install({ version: "1.2.3" });

    expect(source.installedWith).toEqual([true, false]);
    expect(relaunch).toHaveBeenCalledWith({ pid: process.pid, executable: "/home/user/Apps/TabMail-Voice-latest-linux-x64.AppImage", args: ["--ozone-platform=x11"] });
    expect(events).toEqual(["install", "relaunch", "quit"]);
  });

  test("an AppImage whose name carries its version opens under the update's name", async () => {
    const { platform, source, relaunch } = setUp();
    source.install = () => {
      source.emit("appimage-filename-updated", "/home/user/Apps/TabMail-Voice-1.2.3-linux-x86_64.AppImage");
      return true;
    };

    await platform.install({ version: "1.2.3" });

    expect(relaunch).toHaveBeenCalledWith(expect.objectContaining({ executable: "/home/user/Apps/TabMail-Voice-1.2.3-linux-x86_64.AppImage" }));
  });

  test("an install that didn't happen fails, and the app neither quits nor reopens", async () => {
    const { platform, relaunch, quit } = setUp({ installs: false });

    expect((await refusal(platform.install({ version: "1.2.3" }))).message).toBe("The update couldn't replace TabMail Voice.");
    expect(relaunch).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  /** The release's signing, and gpgv, for real: a throwaway key signs the statement, gpgv holds it with
   * that key's keyring, and refuses it for a file one byte different or a keyring without the key. */
  const gnupg = (() => {
    try {
      return { gpg: execFileSync("sh", ["-c", "command -v gpg"], { encoding: "utf8" }).trim(), gpgv: execFileSync("sh", ["-c", "command -v gpgv"], { encoding: "utf8" }).trim() };
    } catch {
      return null;
    }
  })();
  test.skipIf(gnupg === null)("gpgv holds a real signature over the statement, and refuses another file or key", { timeout: 30_000 }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "voice-gpg-"));
    const home = join(folder, "home");
    const gpg = (...args: string[]) => execFileSync(gnupg!.gpg, ["--homedir", home, "--batch", "--quiet", ...args], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      execFileSync("mkdir", ["-m", "700", home]);
      gpg("--passphrase", "", "--quick-gen-key", "Test <test@example.com>", "ed25519", "sign", "never");
      writeFileSync(join(folder, "keyring.gpg"), gpg("--export"));
      const file = download(folder);
      writeFileSync(join(folder, "statement"), updateStatement("x64", "1.2.3", file.sha512));
      gpg("--detach-sign", "--output", join(folder, "statement.sig"), join(folder, "statement"));
      const signature = readFileSync(join(folder, "statement.sig")).toString("base64");
      const real: RunFile = (_file, args, timeout) => runFile(gnupg!.gpgv, args, timeout);

      await setUp({ run: real, keyring: join(folder, "keyring.gpg") }).platform.verify({ version: "1.2.3", signature, downloadedFile: file.path });

      const logged = vi.spyOn(log, "error").mockImplementation(() => {});
      try {
        const other = download(folder, "an AppImage!");
        await refusal(setUp({ run: real, keyring: join(folder, "keyring.gpg") }).platform.verify({ version: "1.2.3", signature, downloadedFile: other.path }));
        await refusal(setUp({ run: real, keyring: join(folder, "keyring.gpg") }).platform.verify({ version: "1.2.4", signature, downloadedFile: download(folder).path }));
        writeFileSync(join(folder, "empty.gpg"), "");
        await refusal(setUp({ run: real, keyring: join(folder, "empty.gpg") }).platform.verify({ version: "1.2.3", signature, downloadedFile: download(folder).path }));
      } finally {
        logged.mockRestore();
      }
    } finally {
      try {
        execFileSync("gpgconf", ["--homedir", home, "--kill", "gpg-agent"], { stdio: "ignore" });
      } catch {
        // No agent was started.
      }
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

/** The updated app opens from a shell of the app's own, never Electron's relauncher (which leaves it
 * unable to mount the AppImage), and only once the old app is gone: before, its single-instance lock
 * would close the new one at once. Run for real, with Node standing in for both apps. */
describe("opening the updated app", () => {
  // `/bin/sh` waits for it: not on a Windows machine running the tests.
  test.skipIf(process.platform === "win32")("it starts after the old app has quit, with its arguments as given", async () => {
    const folder = mkdtempSync(join(tmpdir(), "voice-relaunch-"));
    try {
      const marker = join(folder, "opened");
      const old = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600)"], { stdio: "ignore" });
      relaunchAfterExit({
        pid: old.pid ?? 0,
        executable: process.execPath,
        args: ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2])", marker, "an argument with spaces"],
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(marker)).toBe(false);
      await once(old, "exit");
      for (let tries = 0; tries < 50 && !existsSync(marker); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readFileSync(marker, "utf8")).toBe("an argument with spaces");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("the app never relaunches itself through Electron", () => {
    expect(readFileSync(join(__dirname, "../../../../src/main/index.ts"), "utf8")).not.toMatch(/\bapp\.relaunch\(/);
  });

  test("the shell is detached from the old app, so it outlives it", () => {
    const spawnFile = vi.fn(() => ({ unref: vi.fn() }));
    relaunchAfterExit({ pid: 42, executable: "/home/user/TabMail Voice.AppImage", args: ["--ozone-platform=x11"], spawnFile: spawnFile as never });

    expect(spawnFile).toHaveBeenCalledWith("/bin/sh", ["-c", expect.stringContaining('exec "$@"'), "sh", "42", "/home/user/TabMail Voice.AppImage", "--ozone-platform=x11"], { detached: true, stdio: "ignore" });
  });
});
