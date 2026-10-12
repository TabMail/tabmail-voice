// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { macUpdateFeedURL } from "../../../core/config.js";
import { type UpdatePlatform, type UpdateSource, UpdateError } from "../../updater.js";

/** `electron-updater`'s `MacUpdater`, as far as the macOS adapter uses it. */
export interface MacUpdateSource extends UpdateSource {
  setFeedURL(options: { provider: "generic"; url: string; useMultipleRangeRequest: boolean }): void;
  quitAndInstall(): void;
}

/** Electron's own `autoUpdater` (Squirrel.Mac), which installs what `electron-updater` downloaded. It
 * fetches the update from `electron-updater` only after `electron-updater` says `update-downloaded`,
 * checks that it carries the running app's Developer ID signature, and then says `update-downloaded`
 * itself; a refusal reaches the source as `error`. */
export interface Installer {
  on(event: "update-downloaded", listener: () => void): unknown;
}

/**
 * macOS updates (ADR-DESK-041): the ZIP from the folder of the architecture the app runs as
 * (`macos-arm64`, `macos-x64`), proven by Squirrel.Mac, which installs only an update carrying the running app's Developer ID
 * signature and never an older version (`ElectronSquirrelPreventDowngrades`). `electron-updater`'s `update-downloaded` comes before
 * Squirrel has fetched the ZIP, let alone checked it, so the update is ready only when Squirrel says
 * so. One it refuses, as from an app run off its disk image, is never offered, and isn't shown.
 * The feed is chosen as the app runs, not as it was built: the universal app, downloaded for either
 * kind of Mac, updates to that Mac's own app. The CDN refuses a request for several byte ranges, so a
 * differential update asks for one at a time.
 */
export function macUpdatePlatform(options: { source: MacUpdateSource; installer: Installer; arch: string }): UpdatePlatform {
  const { source, installer } = options;
  source.setFeedURL({ provider: "generic", url: `${macUpdateFeedURL}-${options.arch}`, useMultipleRangeRequest: false });
  let pending: { accept: () => void; refuse: (error: UpdateError) => void } | null = null;
  installer.on("update-downloaded", () => {
    pending?.accept();
    pending = null;
  });
  source.on("error", () => {
    pending?.refuse(new UpdateError("macOS refused the update.", { quiet: true }));
    pending = null;
  });
  return {
    source,
    verify: () =>
      new Promise((accept, refuse) => {
        pending = { accept, refuse };
      }),
    install: () => {
      source.quitAndInstall();
      return Promise.resolve();
    },
  };
}
