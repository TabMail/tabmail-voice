// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { PermissionSystem } from "../../../core/onboarding/permissions.js";
import { errorName, log } from "../../../core/log.js";
import type { HelperClient } from "../helperClient.js";

/** Ubuntu uses the compositor's keyboard and clipboard portals for insertion. */
export class LinuxPermissions implements PermissionSystem {
  private granted = false;
  private shortcutGranted = false;
  private requesting = false;
  onChange: (() => void) | undefined;

  constructor(private readonly helper: HelperClient, private readonly hotkey: HelperClient, private readonly parentWindow: () => string = () => "") {
    hotkey.on("hotkeyInstallationChanged", (message) => { this.updateHotkey(message.installed === true); });
    helper.on("insertionPermissionChanged", (message) => this.update(message.granted === true));
  }

  readMicrophone(): "granted" { return "granted"; }
  readAccessibility(): boolean { return this.granted && this.shortcutGranted; }
  async askForMicrophone(): Promise<void> {}
  askForAccessibility(): boolean {
    if (!this.readAccessibility() && !this.requesting) {
      this.requesting = true;
      const parent = this.parentWindow();
      (async () => {
        if (!this.shortcutGranted) {
          await this.hotkey.request("requestHotkey", { parent }, 185000);
          if (!this.shortcutGranted) return;
        }
        if (!this.granted) await this.helper.request("requestInsertion", { parent }, 185000);
      })().catch((error: unknown) => {
        log.error(`LinuxPermissions: keyboard permission failed: ${errorName(error)}`);
      }).finally(() => { this.requesting = false; });
    }
    return this.granted && this.shortcutGranted;
  }
  restore(): void {
    this.helper.request("restoreInsertion", {}, 185000).catch((error: unknown) => {
      log.error(`LinuxPermissions: keyboard restoration failed: ${errorName(error)}`);
    });
  }
  openSettings(): void {}
  resetHotkey(): void { this.updateHotkey(false); }
  reset(): void { this.update(false); }
  private updateHotkey(value: boolean): void {
    if (this.shortcutGranted === value) return;
    this.shortcutGranted = value; this.onChange?.();
  }
  private update(value: boolean): void {
    if (this.granted === value) return;
    this.granted = value;
    this.onChange?.();
  }
}
