// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";

/** An app the screen is never read in (owner, 2026-09-30): no screen context, no names and terms
 * from it, no correction learned in it. Dictation itself still works there. Known by its bundle
 * identifier; `name` is what Settings shows. */
export interface ExcludedApp {
  bundleIdentifier: string;
  name: string;
}

/** Whether two bundle identifiers name the same app: the case aside, as macOS compares them. */
export function isSameApp(first: string, second: string): boolean {
  return first.toLowerCase() === second.toLowerCase();
}

/** Whether `bundleIdentifier` is one of the password managers excluded in every installation
 * (`config.builtInExcludedApps`). */
export function isBuiltInExcludedApp(bundleIdentifier: string): boolean {
  return config.builtInExcludedApps.some((app) => isSameApp(app.bundleIdentifier, bundleIdentifier));
}

/** `value` as an app to exclude; null when it has no bundle identifier or name, or either is too long. */
export function excludedApp(value: unknown): ExcludedApp | null {
  if (!value || typeof value !== "object") return null;
  const { bundleIdentifier, name } = value as Record<string, unknown>;
  if (typeof bundleIdentifier !== "string" || bundleIdentifier === "" || bundleIdentifier.length > config.bundleIdentifierMaxLength) return null;
  if (typeof name !== "string" || name === "" || name.length > config.excludedAppNameMaxLength) return null;
  return { bundleIdentifier, name };
}

/** A stored list read back: valid apps only, the first of any two that are the same app, none of the
 * built-in ones, at most `config.excludedAppsMax`. */
export function storedExcludedApps(stored: unknown): ExcludedApp[] {
  if (!Array.isArray(stored)) return [];
  const apps: ExcludedApp[] = [];
  for (const item of stored) {
    if (apps.length === config.excludedAppsMax) break;
    const app = excludedApp(item);
    if (app === null || isBuiltInExcludedApp(app.bundleIdentifier)) continue;
    if (apps.some((other) => isSameApp(other.bundleIdentifier, app.bundleIdentifier))) continue;
    apps.push(app);
  }
  return apps;
}
