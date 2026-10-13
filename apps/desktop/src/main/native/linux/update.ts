// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../../../core/config.js";
import { log } from "../../../core/log.js";
import { type RunFile, UpdateError, type UpdateInfo, type UpdatePlatform, type UpdateSource } from "../../updater.js";

/** `electron-updater`'s `AppImageUpdater`, as far as the Linux adapter uses it. */
export interface AppImageUpdateSource extends UpdateSource {
  setFeedURL(options: { provider: "generic"; url: string; useMultipleRangeRequest: boolean }): void;
  /** Replaces the running AppImage with the download and runs the new one with
   * `APPIMAGE_EXIT_AFTER_INSTALL`, which its launcher answers by exiting at once; false when it didn't. */
  install(isSilent: boolean, isForceRunAfter: boolean): boolean;
  on(event: "update-available" | "update-downloaded", listener: (info: UpdateInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "appimage-filename-updated", listener: (path: string) => void): unknown;
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
 * the library replaces the AppImage file in place, and the app then opens the new one itself.
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
  const { source, keyring, arch, run, quit, relaunch = relaunchAfterExit } = options;
  source.setFeedURL({ provider: "generic", url: `${config.linuxUpdateFeedURL}-${arch}`, useMultipleRangeRequest: false });
  /** Where the update goes: the running AppImage's path, unless its name carries a version, when the
   * library names it as the download is named. */
  let destination = options.appImage;
  source.on("appimage-filename-updated", (path) => {
    destination = path;
  });
  return {
    source,
    verify: async (update) => {
      const notSigned = new UpdateError(`Version ${update.version} isn't signed by TabMail, so it wasn't installed.`);
      if (update.downloadedFile === undefined || typeof update.signature !== "string") throw notSigned;
      const statement = updateStatement(arch, update.version, await sha512(update.downloadedFile));
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
    },
    install: () => {
      if (!source.install(true, false)) return Promise.reject(new UpdateError("The update couldn't replace TabMail Voice."));
      relaunch({ pid: process.pid, executable: destination, args: options.args });
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
