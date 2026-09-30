// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { ScriptError } from "../../../../src/core/agent/connectors/appleScript.js";

/** A script's failure as osascript reports it (from the Swift `NotesMessagesToolsTests`). */

describe("a script's failure", () => {
  /** When macOS refuses the Apple Event (-1743), the error names the app the script tells and where to
   * allow it; any other error is osascript's, trimmed. */
  test.each([
    ["execution error: Not authorized to send Apple events to Notes. (-1743)", 'tell application "Notes"', "TabMail Voice can't use Notes. Allow it in System Settings › Privacy & Security › Automation.", "Notes"],
    ["execution error: Not authorized (-1743)\n", "return 1", "execution error: Not authorized (-1743)", null],
    ["  execution error: Example failure (-2700)\n", 'tell application "Notes"', "execution error: Example failure (-2700)", null],
  ])("%j", (errors, source, message, deniedApp) => {
    const failure = ScriptError.from(errors, source);

    expect(failure.message).toBe(message);
    expect(failure.deniedApp).toBe(deniedApp);
  });
});
