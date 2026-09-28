// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process";
import { type ScriptRunner, ScriptFailure } from "../core/agent/appleScript.js";
import * as config from "../core/config.js";
import { CancellationError } from "../core/timeout.js";

/**
 * The Notes and Messages scripts, run by `/usr/bin/osascript` from the main process (ADR-DESK-028):
 * a cancelled request ends the process, which `voice-macos` can't do for a request it has taken.
 * macOS asks the user the first time the app sends Notes or Messages an Apple Event.
 */
export const osascript: ScriptRunner = {
  run(source, args, signal) {
    return new Promise((resolve, reject) => {
      // Node starts a process whose signal has already aborted, and ends it only a tick later.
      if (signal.aborted) {
        reject(new CancellationError());
        return;
      }
      // `--` ends osascript's options, so an argument starting with `-` (`-e …`) is data, never more
      // script (MIS-068).
      execFile("/usr/bin/osascript", ["-e", source, "--", ...args], { signal, encoding: "utf8", maxBuffer: config.appleScriptMaxOutputBytes }, (error, stdout, stderr) => {
        if (signal.aborted) reject(new CancellationError());
        else if (error) reject(ScriptFailure.from(stderr === "" ? error.message : stderr, source));
        // osascript ends what the script returns with a line break.
        else resolve(stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout);
      });
    });
  },
};
