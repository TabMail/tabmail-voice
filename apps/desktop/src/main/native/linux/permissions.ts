// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { PermissionSystem } from "../../../core/onboarding/permissions.js";
import { errorName, log } from "../../../core/log.js";
import type { HelperClient } from "../helperClient.js";
import type { GnomeIntegrationState } from "../../../shared/ipc.js";

/** GNOME integration, which Ubuntu requires: it holds Right Alt and the recording keys. */
export interface GnomeRequirement {
  readonly state: GnomeIntegrationState;
  enable(): Promise<void>;
}

/** Ubuntu uses the compositor's keyboard and clipboard portals for insertion, and, on GNOME,
 * GNOME integration for the keys. */
export class LinuxPermissions implements PermissionSystem {
  private granted = false;
  private shortcutGranted = false;
  private requesting = false;
  /** The Shell couldn't hold Right Alt: it is AltGr on this keyboard layout (it types characters).
   * Cleared when a dictation key is held or another one is chosen. */
  hotkeyUnavailable = false;
  onChange: (() => void) | undefined;

  constructor(private readonly helper: HelperClient, private readonly hotkey: HelperClient, private readonly parentWindow: () => string = () => "", private readonly gnome: GnomeRequirement | null = null) {
    hotkey.on("hotkeyInstallationChanged", (message) => { this.updateHotkey(message.installed === true); });
    hotkey.on("hotkeyUnavailable", () => { this.hotkeyUnavailable = true; this.onChange?.(); });
    helper.on("insertionPermissionChanged", (message) => this.update(message.granted === true));
  }

  readMicrophone(): "granted" { return "granted"; }
  readAccessibility(): boolean { return this.granted && this.shortcutGranted && this.gnomeReady(); }
  async askForMicrophone(): Promise<void> {}
  askForAccessibility(): boolean {
    if (!this.readAccessibility() && !this.requesting) {
      this.requesting = true;
      const parent = this.parentWindow();
      (async () => {
        if (!this.gnomeReady()) {
          // Enabling may need a log-out and in first; the Shell then asks the helper for its keys.
          await this.gnome?.enable();
          if (!this.gnomeReady()) return;
        }
        if (!this.shortcutGranted) {
          await this.hotkey.request("requestHotkey", { parent }, 185000);
          if (!this.shortcutGranted) return;
        }
        if (!this.granted) await this.helper.request("requestInsertion", { parent }, 185000);
      })().catch((error: unknown) => {
        log.error(`LinuxPermissions: keyboard permission failed: ${errorName(error)}`);
      }).finally(() => { this.requesting = false; });
    }
    return this.readAccessibility();
  }
  restore(): void {
    this.helper.request("restoreInsertion", {}, 185000).catch((error: unknown) => {
      log.error(`LinuxPermissions: keyboard restoration failed: ${errorName(error)}`);
    });
  }
  openSettings(): void {}
  resetHotkey(): void { this.hotkeyUnavailable = false; this.updateHotkey(false); }
  /** GNOME releases older than the extension supports go without it. */
  private gnomeReady(): boolean { return this.gnome === null || this.gnome.state === "ready" || this.gnome.state === "unsupported"; }
  reset(): void { this.update(false); }
  private updateHotkey(value: boolean): void {
    if (value) this.hotkeyUnavailable = false;
    if (this.shortcutGranted === value) return;
    this.shortcutGranted = value; this.onChange?.();
  }
  private update(value: boolean): void {
    if (this.granted === value) return;
    this.granted = value;
    this.onChange?.();
  }
}
