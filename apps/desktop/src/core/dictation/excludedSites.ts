// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";

/** A website the screen is never read on (owner, 2026-10-01): as an excluded app (`ExcludedApp`),
 * but one site in a browser instead of the whole browser. Known by its host ("example.com"), which
 * covers its subdomains too ("mail.example.com"). */

/** What the user typed or pasted, as a host: the scheme, the sign-in, the port and the path of an
 * address are dropped and the case lowered. Null when what is left is no host name: it needs a dot,
 * and only letters, digits and hyphens between the dots. */
export function excludedSite(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^[^@]*@/, "")
    .replace(/:\d*$/, "")
    .replace(/\.$/, "");
  if (host.length > config.hostMaxLength) return null;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** Whether excluding `site` excludes `host`: the site itself, or a subdomain of it, without regard to
 * case or to a trailing dot. The helpers match the same way, and all are held to
 * `native/shared/privacy/host-exclusion-cases.json`. */
export function coversHost(site: string, host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  const excluded = site.toLowerCase().replace(/\.$/, "");
  if (name === "" || excluded === "") return false;
  if (name === excluded || name.endsWith(`.${excluded}`)) return true;
  const canonicalName = canonicalHost(host.toLowerCase());
  const canonicalSite = canonicalHost(site.toLowerCase());
  return canonicalName !== null && canonicalSite !== null &&
    (canonicalName === canonicalSite || canonicalName.endsWith(`.${canonicalSite}`));
}

/** The native URL classifier emits canonical IDNs/numeric addresses. Retain the
 * literal match above and recognize those aliases so stored exclusions survive. */
function canonicalHost(host: string): string | null {
  if (/[\s\p{Cc}@/\\?#]/u.test(host) || (host.includes(":") && !host.startsWith("["))) return null;
  try {
    const url = new URL(`http://${host}/`);
    return url.port === "" && url.username === "" && url.password === "" ? url.hostname.replace(/\.$/, "") : null;
  } catch { return null; }
}

/** Whether `host` is excluded in every installation (`config.builtInExcludedSites`). */
export function isBuiltInExcludedSite(host: string): boolean {
  return config.builtInExcludedSites.some((site) => coversHost(site, host));
}

/** A stored list read back: valid hosts only, none twice or built in. */
export function storedExcludedSites(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  const sites: string[] = [];
  for (const item of stored) {
    const site = excludedSite(item);
    if (site === null || site !== item || isBuiltInExcludedSite(site) || sites.includes(site)) continue;
    sites.push(site);
  }
  return sites;
}

/** What a dictation excludes from screen reading, as it started: the apps' identifiers and the
 * websites' hosts. They go to the helper with every read of another app, and the helper reads none
 * of them. */
export interface ScreenExclusions {
  apps: readonly string[];
  sites: readonly string[];
}
