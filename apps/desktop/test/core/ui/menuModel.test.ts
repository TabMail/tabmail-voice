// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import type { Phase } from "../../../src/core/dictation/controller.js";
import { type MenuState, showsDictationButton, statusLine, type UpdateState, updateItem } from "../../../src/core/ui/menuModel.js";

describe("menu", () => {
  /** The menu's Start Dictation shows only in debug mode; a Stop for a recording in progress shows
   * whatever the mode, so it can always be stopped. */
  test.each<[boolean, Phase, boolean]>([
    [true, { kind: "idle" }, true],
    [false, { kind: "idle" }, false],
    [false, { kind: "arming" }, false],
    [false, { kind: "transcribing" }, false],
    [false, { kind: "failed", message: "x" }, false],
    [false, { kind: "listening" }, true],
    [true, { kind: "listening" }, true],
  ])("debug mode %s, phase %j: shows the dictation button %s", (debugMode, phase, shows) => {
    expect(showsDictationButton(debugMode, phase)).toBe(shows);
  });

  test("the status line says what is missing, else how to dictate", () => {
    const ready: MenuState = { hasConsented: true, isSignedIn: true, microphoneGranted: true, accessibilityTrusted: true, hotkey: "function", debugMode: false, phase: { kind: "idle" }, update: null };
    expect(statusLine(ready)).toBe("Hold Fn / Globe (🌐) to dictate");
    expect(statusLine({ ...ready, hasConsented: false })).toBe("Setup needed");
    expect(statusLine({ ...ready, isSignedIn: false })).toBe("Sign in to start dictating");
    expect(statusLine({ ...ready, microphoneGranted: false })).toBe("Setup needed");
    expect(statusLine({ ...ready, accessibilityTrusted: false })).toBe("Setup needed");
  });

  /** Check for Updates can be clicked only while nothing is under way; Restart to Update once an
   * update is downloaded (ADR-DESK-041). */
  test.each<[UpdateState, string, boolean]>([
    [{ kind: "idle" }, "Check for Updates…", true],
    [{ kind: "checking" }, "Checking for Updates…", false],
    [{ kind: "downloading", version: "1.2.3" }, "Downloading Version 1.2.3…", false],
    [{ kind: "ready", version: "1.2.3" }, "Restart to Update to Version 1.2.3", true],
  ])("update %j: the menu item says %s, enabled %s", (update, label, enabled) => {
    expect(updateItem(update)).toEqual({ label, enabled });
  });
});
