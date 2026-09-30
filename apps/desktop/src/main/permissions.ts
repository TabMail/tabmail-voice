// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { shell, systemPreferences } from "electron";
import { errorName, log } from "../core/log.js";
import type { PermissionSystem } from "../core/onboarding/permissions.js";

/** System Settings' Privacy & Security panes. */
const settingsPanes = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
} as const;

/** macOS's grants, read and asked for through Electron. */
export const macPermissions: PermissionSystem = {
  readMicrophone: () => systemPreferences.getMediaAccessStatus("microphone"),
  readAccessibility: () => systemPreferences.isTrustedAccessibilityClient(false),
  async askForMicrophone() {
    await systemPreferences.askForMediaAccess("microphone");
  },
  askForAccessibility: () => systemPreferences.isTrustedAccessibilityClient(true),
  openSettings(pane) {
    shell.openExternal(settingsPanes[pane]).catch((error: unknown) => {
      log.error(`Permissions: couldn't open settings: ${errorName(error)}`);
    });
  },
};
