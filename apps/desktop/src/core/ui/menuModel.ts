// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Phase } from "../dictation/dictationController.js";
import { type DictationHotkey, hotkeyNames } from "../hotkey/hotkey.js";

/** What the tray menu shows, from the app's state. */
export interface MenuState {
  hasConsented: boolean;
  isSignedIn: boolean;
  microphoneGranted: boolean;
  accessibilityTrusted: boolean;
  hotkey: DictationHotkey;
  debugMode: boolean;
  phase: Phase;
  /** Packaged builds only (ADR-DESK-041); null otherwise. */
  update: UpdateState | null;
}

/** Start Dictation is a debug item: dictation starts from the hotkey. Once a recording started from
 * the menu, its Stop stays even if debug mode goes off, so it can always be stopped. */
export function showsDictationButton(debugMode: boolean, phase: Phase): boolean {
  return debugMode || phase.kind === "listening";
}

/** Everything dictation needs: consent, an account and both grants. */
export function isReady(state: MenuState): boolean {
  return state.hasConsented && state.isSignedIn && state.microphoneGranted && state.accessibilityTrusted;
}

/** The menu's first line. */
export function statusLine(state: MenuState): string {
  if (!state.hasConsented) return "Setup needed";
  if (!state.isSignedIn) return "Sign in to start dictating";
  if (!state.microphoneGranted || !state.accessibilityTrusted) return "Setup needed";
  return `Hold ${hotkeyNames[state.hotkey].displayName} to dictate`;
}

/** Where an update is (ADR-DESK-041). `ready`: downloaded, installed when the app quits. */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; version: string }
  | { kind: "ready"; version: string };

/** The menu's update item: Check for Updates, what a check is doing, or Restart to Update once one is
 * ready. */
export function updateItem(update: UpdateState): { label: string; enabled: boolean } {
  switch (update.kind) {
    case "idle":
      return { label: "Check for Updates…", enabled: true };
    case "checking":
      return { label: "Checking for Updates…", enabled: false };
    case "downloading":
      return { label: `Downloading Version ${update.version}…`, enabled: false };
    case "ready":
      return { label: `Restart to Update to Version ${update.version}`, enabled: true };
  }
}
