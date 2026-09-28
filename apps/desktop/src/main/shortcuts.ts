// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process";
import type { ShortcutsRunner } from "../core/agent/shortcutsTools.js";
import * as config from "../core/config.js";
import { CancellationError } from "../core/timeout.js";

/**
 * The user's shortcuts through the Shortcuts app's `shortcuts` command, run from the main process
 * (ADR-DESK-029): a shortcut's name is one argument, never parsed by a shell, and a cancelled request
 * ends the command, as for osascript (ADR-DESK-028). `executable` is a stand-in in tests, which never
 * run a shortcut of the user's.
 */
export function shortcutsCommand(executable = "/usr/bin/shortcuts"): ShortcutsRunner {
  const output = (args: string[], signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      // Node starts a process whose signal has already aborted, and ends it only a tick later.
      if (signal.aborted) {
        reject(new CancellationError());
        return;
      }
      const command = execFile(executable, args, { signal, encoding: "utf8", maxBuffer: config.shortcutsMaxOutputBytes }, (error, stdout, stderr) => {
        if (signal.aborted) reject(new CancellationError());
        else if (error) reject(new Error(stderr.trim() === "" ? error.message : stderr.trim()));
        else resolve(stdout);
      });
      // A run takes no input: `shortcuts` reads an open stdin as the shortcut's input, and waits for it.
      command.stdin?.end();
    });
  return {
    async names(signal) {
      return (await output(["list"], signal)).split("\n").filter((name) => name !== "");
    },
    // `--` ends the options, so a name starting with `-` is the name, never an option (MIS-068).
    run(name, signal) {
      return output(["run", "--output-type", "public.plain-text", "--", name], signal);
    },
  };
}
