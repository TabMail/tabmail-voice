// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { shell, systemPreferences } from "electron";
import { errorName, log } from "../../../core/log.js";
import type { PermissionSystem } from "../../../core/onboarding/permissions.js";

/** Desktop Windows has microphone privacy settings and no macOS-style Accessibility grant.
 * UIA and insertion still validate the target and its integrity in the native helper. */
export const windowsPermissions: PermissionSystem = {
  readMicrophone: () => systemPreferences.getMediaAccessStatus("microphone"),
  readAccessibility: () => true,
  async askForMicrophone() {
    await shell.openExternal("ms-settings:privacy-microphone");
  },
  askForAccessibility: () => true,
  openSettings(pane) {
    if (pane !== "microphone") return;
    shell.openExternal("ms-settings:privacy-microphone").catch((error: unknown) => {
      log.error(`Permissions: couldn't open settings: ${errorName(error)}`);
    });
  },
};
