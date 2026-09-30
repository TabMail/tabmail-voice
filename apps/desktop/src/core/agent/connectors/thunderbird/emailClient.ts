// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../../config.js";
import { log } from "../../../log.js";

/** An installed email app. */
export interface EmailApp {
  bundleIdentifier: string;
  name: string;
}

/** Reads Thunderbird's files; injected so tests use a temporary folder and core stays free of Node. */
export interface ProfileFiles {
  /** The file's text, or null when it is missing or unreadable. */
  readText(path: string): string | null;
  /** `relative` inside `directory`. */
  join(directory: string, relative: string): string;
}

/**
 * The email app that mail and calendar requests go to: the one chosen in Settings, or else the
 * user's default email app when it is one TabMail's add-on runs in (a Thunderbird); none while no
 * Thunderbird profile has the add-on.
 */
export const EmailClient = {
  /** The bundle identifier of the app to drive: `chosen` if set, else `systemDefault` if it is
   * supported; null when there is none or TabMail's add-on isn't installed, which leaves the tool
   * out. */
  resolve(chosen: string | null, systemDefault: string | null, hasTabMail: boolean): string | null {
    if (!hasTabMail) return null;
    if (chosen !== null) return chosen;
    if (systemDefault === null || !config.thunderbirdBundleIdentifiers.includes(systemDefault)) return null;
    return systemDefault;
  },

  /** Whether a Thunderbird profile in `directory` has TabMail's add-on installed and enabled. Every
   * profile in its `profiles.ini` counts: Thunderbird and Thunderbird Beta share the folder, and
   * nothing there says which profile an installation opens. */
  hasTabMail(directory: string, files: ProfileFiles): boolean {
    const ini = files.readText(files.join(directory, "profiles.ini"));
    if (ini === null) return false;
    const found = profiles(ini, directory, files).some((profile) => {
      const text = files.readText(files.join(profile, "extensions.json"));
      if (text === null) return false;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return false;
      }
      const addons = (json as { addons?: unknown } | null)?.addons;
      if (!Array.isArray(addons)) return false;
      return addons.some((addon: unknown) => {
        if (!addon || typeof addon !== "object") return false;
        const { id, userDisabled, appDisabled } = addon as Record<string, unknown>;
        return id === config.tabMailAddonID && userDisabled !== true && appDisabled !== true;
      });
    });
    if (!found) log.debug("EmailClient: no Thunderbird profile has TabMail's add-on");
    return found;
  },
};

/** The profile folders `profiles.ini` lists: the `Path=` of each section, relative to `directory`
 * when the section says `IsRelative=1`. */
function profiles(ini: string, directory: string, files: ProfileFiles): string[] {
  const found: string[] = [];
  let path: string | null = null;
  let isRelative = false;
  const close = () => {
    if (path !== null) found.push(isRelative ? files.join(directory, path) : path);
    path = null;
    isRelative = false;
  };
  for (const raw of ini.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      close();
    } else if (line.startsWith("Path=")) {
      path = line.slice("Path=".length);
    } else if (line.startsWith("IsRelative=")) {
      isRelative = line === "IsRelative=1";
    }
  }
  close();
  return found;
}
