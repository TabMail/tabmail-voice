// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Runs an AppleScript that takes its values as arguments (`on run argv`), for Notes and Messages,
 * which have no framework (ADR-DESK-028): what the model wrote is never part of the script's source,
 * so it cannot change what the script does (`/usr/bin/osascript` from the main process on a Mac).
 */
export interface ScriptRunner {
  /** Runs `source` with `args` and returns what it returns, as text; `signal` ends the script. */
  run(source: string, args: readonly string[], signal: AbortSignal): Promise<string>;
}

/** Why a script failed: macOS refused to let the app control another (-1743), or what osascript
 * reported. The model reads the message, and tells the user. */
export class ScriptFailure extends Error {
  private constructor(
    message: string,
    /** The app the user has not let TabMail Voice control; null for any other failure. */
    readonly deniedApp: string | null,
  ) {
    super(message);
    this.name = "ScriptFailure";
  }

  static noAccess(app: string): ScriptFailure {
    return new ScriptFailure(`TabMail Voice can't use ${app}. Allow it in System Settings › Privacy & Security › Automation.`, app);
  }

  static failed(message: string): ScriptFailure {
    return new ScriptFailure(message, null);
  }

  /** The failure osascript reported in `errors` for `source`: no access when macOS refused the Apple
   * Event to the app the script tells (-1743), else its message. */
  static from(errors: string, source: string): ScriptFailure {
    const app = /tell application "([^"]+)"/.exec(source)?.[1];
    if (errors.includes("(-1743)") && app !== undefined) return ScriptFailure.noAccess(app);
    return ScriptFailure.failed(errors.trim());
  }
}
