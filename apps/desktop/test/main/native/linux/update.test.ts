// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import * as config from "../../../../src/core/config.js";
import { log } from "../../../../src/core/log.js";
import { AppImageInstaller, type AppImageUpdateSource, appImageUpdatePlatform, relaunchAfterExit, updateStatement } from "../../../../src/main/native/linux/update.js";
import { type RunFile, runFile, UpdateError } from "../../../../src/main/updater.js";

/** `AppImageUpdater` as the adapter sees it: the feed it was given, and an install that did or didn't. */
class FakeSource extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  requestHeaders = null;
  verified: { file: string; sha512: string } | null = null;
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
      const { platform, source, runs } = setUp({ arch: "arm64" });

      await platform.verify({ version: "1.2.3", signature: Buffer.from("a signature").toString("base64"), downloadedFile: file.path });

      // What an install puts in place: that file, with the hash gpgv held.
      expect(source.verified).toEqual({ file: file.path, sha512: file.sha512 });
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
      const { platform, source, runs } = setUp({ reply: { code: 1, stdout: "" } });
      source.verified = { file: "/home/user/.cache/earlier.AppImage", sha512: "ZWFybGllcg==" };

      const error = await refusal(platform.verify({ version: "1.2.3", signature: "c2ln", downloadedFile: download(folder).path }));

      expect(error.message).toBe("Version 1.2.3 isn't signed by TabMail, so it wasn't installed.");
      expect(source.verified).toBeNull();
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

/** What an AppImage update leaves, driven through `electron-updater`'s own install lifecycle (its
 * quit handler and `install`), with the app's install in place of the library's: the update at the
 * AppImage's own path, or, when anything fails, the old AppImage as it was. Never neither. */
describe("installing an AppImage update (ADR-DESK-059)", () => {
  /** An AppImage named with its version (as the release's GitHub copies are), the next version
   * downloaded to the library's cache, and gpgv holding (`proven`) or refusing it. */
  function setUpInstall(folder: string, proven = true, name = "TabMail-Voice-1.0.0-linux-x86_64.AppImage") {
    const apps = join(folder, "Apps");
    mkdirSync(apps);
    const appImage = join(apps, name);
    writeFileSync(appImage, "the old AppImage", { mode: 0o755 });
    mkdirSync(join(folder, "cache"));
    const update = download(join(folder, "cache"), "the new AppImage");
    let onQuit: ((exitCode: number) => void) | null = null;
    const adapter = { version: "1.0.0", name: "TabMail Voice", isPackaged: true, whenReady: () => Promise.resolve(), userDataPath: folder, baseCachePath: folder, onQuit: (listener: (exitCode: number) => void) => (onQuit = listener), quit: () => {} };
    const source = new AppImageInstaller(appImage, adapter);
    source.logger = null;
    source.on("error", () => {});
    // What the library holds once it has downloaded an update, and the quit handler it then adds.
    (source as unknown as { downloadedUpdateHelper: unknown }).downloadedUpdateHelper = { file: update.path, downloadedFileInfo: { fileName: basename(update.path) } };
    const events: string[] = [];
    const platform = appImageUpdatePlatform({
      source,
      appImage,
      keyring,
      arch: "x64",
      args: ["--ozone-platform=x11"],
      run: () => Promise.resolve({ code: proven ? 0 : 1, stdout: "" }),
      quit: () => events.push("quit"),
      relaunch: (options) => events.push(`open ${options.executable}`),
    });
    const quitApp = () => {
      source.autoInstallOnAppQuit = true;
      (source as unknown as { addQuitHandler(): void }).addQuitHandler();
      onQuit?.(0);
    };
    const verify = () => platform.verify({ version: "1.0.1", signature: "c2ln", downloadedFile: update.path });
    return { appImage, apps, update, platform, events, verify, quitApp };
  }

  function inFolder(run: (folder: string) => Promise<void>) {
    return async () => {
      const folder = mkdtempSync(join(tmpdir(), "voice-appimage-install-"));
      const logged = vi.spyOn(log, "error").mockImplementation(() => {});
      try {
        await run(folder);
      } finally {
        logged.mockRestore();
        chmodSync(folder, 0o700);
        for (const name of ["Apps", "cache"]) if (existsSync(join(folder, name))) chmodSync(join(folder, name), 0o700);
        rmSync(folder, { recursive: true, force: true });
      }
    };
  }

  test("Later, then quit: the AppImage's own path holds the update, as runnable, and nothing opens", inFolder(async (folder) => {
    const { appImage, apps, events, verify, quitApp } = setUpInstall(folder);
    await verify();

    quitApp();

    expect(readFileSync(appImage, "utf8")).toBe("the new AppImage");
    if (process.platform !== "win32") expect(statSync(appImage).mode & 0o777).toBe(0o755);
    // The same name, though the download's carries its version: the launcher entries still open it.
    expect(readdirSync(apps)).toEqual([basename(appImage)]);
    expect(events).toEqual([]);
  }));

  test("Restart Now: the AppImage's own path holds the update, which opens once the app has quit", inFolder(async (folder) => {
    const { appImage, apps, platform, events, verify } = setUpInstall(folder);
    await verify();

    await platform.install({ version: "1.0.1" });

    expect(readFileSync(appImage, "utf8")).toBe("the new AppImage");
    expect(readdirSync(apps)).toEqual([basename(appImage)]);
    expect(events).toEqual([`open ${appImage}`, "quit"]);
  }));

  test.each([
    ["the download is gone from the cache", (update: { path: string }) => rmSync(update.path)],
    ["the download changed since gpgv held it", (update: { path: string }) => writeFileSync(update.path, "another AppImage")],
  ])("%s: nothing is installed, and the old AppImage stays as it was", (_case, change) => inFolder(async (folder) => {
    const { appImage, apps, update, platform, events, verify, quitApp } = setUpInstall(folder);
    await verify();
    change(update);

    expect((await refusal(platform.install({ version: "1.0.1" }))).message).toBe("The update couldn't replace TabMail Voice.");
    quitApp();

    expect(readFileSync(appImage, "utf8")).toBe("the old AppImage");
    expect(readdirSync(apps)).toEqual([basename(appImage)]);
    expect(events).toEqual([]);
  })());

  /** A refused install leaves the old AppImage, so a later one may still try: the library's own
   * `install` refuses every call after the first unless the app says otherwise. */
  test("after an install that failed, the download back and proven again installs", inFolder(async (folder) => {
    const { appImage, apps, update, platform, events, verify } = setUpInstall(folder);
    await verify();
    rmSync(update.path);
    await refusal(platform.install({ version: "1.0.1" }));
    expect(readFileSync(appImage, "utf8")).toBe("the old AppImage");
    expect(events).toEqual([]);

    writeFileSync(update.path, "the new AppImage");
    await verify();
    await platform.install({ version: "1.0.1" });

    expect(readFileSync(appImage, "utf8")).toBe("the new AppImage");
    expect(readdirSync(apps)).toEqual([basename(appImage)]);
    expect(events).toEqual([`open ${appImage}`, "quit"]);
  }));

  /** The longest name a Linux file system allows (255 bytes): the copy's name doesn't grow from it. */
  test("an AppImage with the longest name a file can have still updates", inFolder(async (folder) => {
    const name = `TabMail-Voice-${"x".repeat(255 - "TabMail-Voice-.AppImage".length)}.AppImage`;
    const { appImage, apps, platform, events, verify } = setUpInstall(folder, true, name);
    await verify();

    await platform.install({ version: "1.0.1" });

    expect(name.length).toBe(255);
    expect(readFileSync(appImage, "utf8")).toBe("the new AppImage");
    if (process.platform !== "win32") expect(statSync(appImage).mode & 0o777).toBe(0o755);
    expect(readdirSync(apps)).toEqual([name]);
    expect(events).toEqual([`open ${appImage}`, "quit"]);
  }));

  test("a download gpgv refused is never installed, at the quit or with Restart Now", inFolder(async (folder) => {
    const { appImage, apps, platform, events, verify, quitApp } = setUpInstall(folder, false);
    await refusal(verify());

    await refusal(platform.install({ version: "1.0.1" }));
    quitApp();

    expect(readFileSync(appImage, "utf8")).toBe("the old AppImage");
    expect(readdirSync(apps)).toEqual([basename(appImage)]);
    expect(events).toEqual([]);
  }));

  // A folder the user can't write: root writes anywhere, and Windows has no such mode.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a folder the update can't be written to keeps the old AppImage", inFolder(async (folder) => {
    const { appImage, apps, platform, events, verify } = setUpInstall(folder);
    await verify();
    chmodSync(apps, 0o555);

    await refusal(platform.install({ version: "1.0.1" }));

    expect(readFileSync(appImage, "utf8")).toBe("the old AppImage");
    expect(readdirSync(apps)).toEqual([basename(appImage)]);
    expect(events).toEqual([]);
  }));
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
