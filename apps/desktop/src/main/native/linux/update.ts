// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn } from "node:child_process";
import * as config from "../../../core/config.js";
import { errorName, log } from "../../../core/log.js";
import { type RunFile, type UpdateInfo, type UpdatePlatform, type UpdateSource, UpdateError } from "../../updater.js";

/** `pkexec`'s own exit codes: the authentication dialog was dismissed, or the user isn't allowed. */
const pkexecDismissed = 126;
const pkexecRefused = 127;

/** What `install-update` says by its exit code (`resources/linux/install-update`), in words. */
export const installUpdateFailures: Record<number, string> = {
  3: "It isn't signed by TabMail, so it wasn't installed.",
  4: "The download doesn't match the signed update, so it wasn't installed.",
  5: "It isn't newer than the installed version.",
  6: "The package manager couldn't install it. A package it needs may be missing; check Software Updates and try again.",
  [pkexecRefused]: "Installing needs an administrator's authorization, which wasn't given.",
};

/**
 * Linux updates (ADR-DESK-050): the `.deb` from the architecture's feed, which also carries an
 * Ed25519 signature over the package's name, architecture, version and SHA-512. `install-update`
 * (root-owned, installed with the package) checks it against the keys installed with the app: as
 * the user once the download is in, and again as root, on its own copy, when the user installs it
 * through `pkexec` with an administrator's authorization. Only then, and only for a newer version,
 * does it run `apt-get install`, which installs missing dependencies from the system's own sources
 * and never downgrades. Nothing installs by itself; once installed, the app opens the new version.
 */
export function linuxUpdatePlatform(options: { source: UpdateSource; script: string; run: RunFile; relaunch: () => void }): UpdatePlatform {
  const { source, script, run, relaunch } = options;
  return {
    source,
    installsOnQuit: false,
    verify: async (update) => {
      const code = await exitCode(run, script, scriptArgs("verify", update), config.updateVerifyTimeout);
      if (code !== 0) throw new UpdateError(installUpdateFailures[code] ?? `Version ${update.version} couldn't be checked.`);
    },
    install: async (update) => {
      // No time limit: the user answers the authentication dialog when they will.
      const code = await exitCode(run, "/usr/bin/pkexec", [script, ...scriptArgs("install", update)]);
      if (code === pkexecDismissed) throw new UpdateError("Installing needs an administrator's authorization. Install the update when you're ready.", { canceled: true });
      if (code !== 0) throw new UpdateError(installUpdateFailures[code] ?? `Version ${update.version} couldn't be installed.`);
      relaunch();
    },
  };
}

/** `install-update`'s arguments: `<mode> <file> <version> <sha512> <signature>`. A feed without a
 * signature gives an empty one, which it refuses as unsigned. */
function scriptArgs(mode: "verify" | "install", update: UpdateInfo): string[] {
  const sha512 = update.files?.find((entry) => entry.url.endsWith(".deb"))?.sha512 ?? "";
  return [mode, update.downloadedFile ?? "", update.version, sha512, update.signature ?? ""];
}

async function exitCode(run: RunFile, program: string, args: string[], timeout?: number): Promise<number> {
  try {
    return (await run(program, args, timeout)).code;
  } catch (error) {
    log.error(`Updater: install-update didn't run: ${errorName(error)}`);
    return -1;
  }
}

/**
 * Opens the updated app once this one has quit (its single-instance lock goes with it), from a shell
 * of its own. Not `app.relaunch()`: Chromium starts the relaunched app with no_new_privs, under which
 * the app's AppArmor profile can't run `voice-linux` unconfined and `pkexec` can't raise privileges,
 * so the updated app would have no screen reading or paste, and couldn't install the next update.
 */
export function relaunchAfterExit(options: { pid: number; executable: string; args: string[]; spawnFile?: typeof spawn }): void {
  const { pid, executable, args, spawnFile = spawn } = options;
  const wait = `pid=$1; shift; while kill -0 "$pid" 2>/dev/null; do sleep ${config.linuxRelaunchPollSeconds}; done; exec "$@"`;
  spawnFile("/bin/sh", ["-c", wait, "sh", String(pid), executable, ...args], { detached: true, stdio: "ignore" }).unref();
}
