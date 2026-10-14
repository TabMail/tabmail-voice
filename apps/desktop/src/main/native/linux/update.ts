// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppImageUpdater } from "electron-updater";
import * as config from "../../../core/config.js";
import { errorName, log } from "../../../core/log.js";
import { type RunFile, UpdateError, type UpdateInfo, type UpdatePlatform, type UpdateSource } from "../../updater.js";

/** `AppImageInstaller`, as far as the Linux adapter uses it. */
export interface AppImageUpdateSource extends UpdateSource {
  setFeedURL(options: { provider: "generic"; url: string; useMultipleRangeRequest: boolean }): void;
  /** The download `verify` proved ours, and its SHA-512: what an install puts in place. */
  verified: { file: string; sha512: string } | null;
  /** Replaces the running AppImage with the verified download; false when it didn't. */
  install(isSilent: boolean, isForceRunAfter: boolean): boolean;
  on(event: "update-available" | "update-downloaded", listener: (info: UpdateInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * `electron-updater`'s `AppImageUpdater` with an install of the app's own, which the library runs at
 * the quit and for Restart Now. The library's unlinks the AppImage before it moves the download in,
 * so a move that fails (the download gone from the cache) leaves no app at all; and it renames an
 * AppImage whose name carries a version to the download's name, so the launcher entry and the login
 * item then name a missing file. This one keeps the path: `replaceAppImage`, with the very file and
 * hash `verify` proved, and nothing else.
 */
export class AppImageInstaller extends AppImageUpdater {
  verified: { file: string; sha512: string } | null = null;

  /** `appImage`, the running AppImage (`APPIMAGE`); `app`, the library's app adapter (tests). */
  constructor(
    private readonly appImage: string,
    app?: unknown,
  ) {
    super(null, app);
  }

  protected override doInstall(): boolean {
    const verified = this.verified;
    let installed = false;
    if (verified === null || verified.file !== this.installerPath) log.error("Updater: no verified AppImage to install");
    else installed = replaceAppImage({ installer: verified.file, appImage: this.appImage, sha512: verified.sha512 });
    // The library's `install` refuses every later call once one began; one that failed left the old
    // AppImage in place, so a later one (Restart Now again, or the quit) may try again.
    if (!installed) this.quitAndInstallCalled = false;
    return installed;
  }
}

/**
 * Replaces the file `appImage` with a copy of `installer` whose SHA-512 (base64) is `sha512`: the copy
 * is made beside it (in a folder of its own, so its name never depends on the AppImage's), with its
 * permissions, checked, and renamed over it, so the path holds the old AppImage or the new one, never
 * neither, and the running app's mount of the old one runs on. False, with the old one in place and
 * no copy left, when anything fails. Synchronous: the quit doesn't wait.
 */
export function replaceAppImage(options: { installer: string; appImage: string; sha512: string }): boolean {
  const { installer, appImage, sha512 } = options;
  let folder: string | undefined;
  try {
    folder = mkdtempSync(join(dirname(appImage), ".tabmail-voice-update-"));
    const staged = join(folder, "AppImage");
    copyFileSync(installer, staged);
    chmodSync(staged, statSync(appImage).mode & 0o7777);
    if (createHash("sha512").update(readFileSync(staged)).digest("base64") !== sha512) {
      log.error("Updater: the AppImage's copy isn't the verified update");
      return false;
    }
    renameSync(staged, appImage);
    return true;
  } catch (error) {
    log.error(`Updater: the AppImage wasn't replaced: ${errorName(error)}`);
    return false;
  } finally {
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  }
}

/** What the release signs for an AppImage update, the same form as the Windows and Linux packages'
 * (ADR-DESK-050), naming the AppImage so a statement for another package proves nothing here. */
export function updateStatement(arch: string, version: string, sha512: string): string {
  return `TabMail Voice update\npackage: tabmail-voice-appimage\narchitecture: ${arch}\nversion: ${version}\nsha512: ${sha512}\n`;
}

/**
 * Linux AppImage updates (ADR-DESK-059), for those who can't install the package: the AppImage from
 * the architecture's feed (`linux-x64`, `linux-arm64`, beside the packages). The feed carries
 * `signature`, a detached OpenPGP signature by the apt repository's key (ADR-DESK-058) of
 * `updateStatement` for this architecture, the offered version and the download's SHA-512, which
 * the app computes itself. `gpgv`, as apt does, checks it against the keyring the app carries; the
 * update is ready only when it holds. It installs when the app quits, or at once with Restart Now:
 * `AppImageInstaller` replaces the AppImage file at its path, and the app then opens the new one itself.
 */
export function appImageUpdatePlatform(options: {
  source: AppImageUpdateSource;
  /** The running AppImage (`APPIMAGE`). */
  appImage: string;
  /** The keyring of the keys that sign updates: the apt repository's. */
  keyring: string;
  arch: string;
  /** What opens the new version: the launcher's arguments. */
  args: string[];
  run: RunFile;
  /** Quits the app. */
  quit: () => void;
  relaunch?: typeof relaunchAfterExit;
}): UpdatePlatform {
  const { source, appImage, keyring, arch, run, quit, relaunch = relaunchAfterExit } = options;
  source.setFeedURL({ provider: "generic", url: `${config.linuxUpdateFeedURL}-${arch}`, useMultipleRangeRequest: false });
  return {
    source,
    verify: async (update) => {
      source.verified = null;
      const notSigned = new UpdateError(`Version ${update.version} isn't signed by TabMail, so it wasn't installed.`);
      const file = update.downloadedFile;
      if (file === undefined || typeof update.signature !== "string") throw notSigned;
      const hash = await sha512(file);
      const statement = updateStatement(arch, update.version, hash);
      const directory = await mkdtemp(join(tmpdir(), "tabmail-voice-update-"));
      try {
        const statementFile = join(directory, "statement");
        const signatureFile = join(directory, "statement.sig");
        await writeFile(statementFile, statement);
        await writeFile(signatureFile, Buffer.from(update.signature, "base64"));
        // Its own empty home: nothing of the user's GnuPG is read or written, and only this keyring vouches.
        const { code } = await run(config.gpgvPath, ["--homedir", directory, "--keyring", keyring, signatureFile, statementFile], config.updateVerifyTimeout);
        if (code !== 0) {
          log.error(`Updater: ${update.version} refused: gpgv exit ${code}`);
          throw notSigned;
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      source.verified = { file, sha512: hash };
    },
    install: () => {
      if (!source.install(true, false)) return Promise.reject(new UpdateError("The update couldn't replace TabMail Voice."));
      relaunch({ pid: process.pid, executable: appImage, args: options.args });
      quit();
      return Promise.resolve();
    },
  };
}

/** The base64 SHA-512 of the file at `path`, as the feed and the statement write it. */
async function sha512(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("base64");
}

/**
 * Opens `executable` once the process `pid` has quit, from a shell of its own, never
 * `app.relaunch()`: Chromium starts a relaunched app with no_new_privs, under which the AppImage's
 * FUSE mount (`fusermount3`, setuid) can't run (ADR-DESK-050 found the same of `pkexec`).
 */
export function relaunchAfterExit(options: { pid: number; executable: string; args: string[]; spawnFile?: typeof spawn }): void {
  const { pid, executable, args, spawnFile = spawn } = options;
  const wait = `pid=$1; shift; while kill -0 "$pid" 2>/dev/null; do sleep ${config.linuxRelaunchPollSeconds}; done; exec "$@"`;
  spawnFile("/bin/sh", ["-c", wait, "sh", String(pid), executable, ...args], { detached: true, stdio: "ignore" }).unref();
}
