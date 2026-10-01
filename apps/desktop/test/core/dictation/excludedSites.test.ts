// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { excludedSite, isBuiltInExcludedSite, storedExcludedSites } from "../../../src/core/dictation/excludedSites.js";

/** The websites the screen is never read on (ADR-DESK-047). */
describe("excluded websites", () => {
  test.each([
    ["example.com", "example.com"],
    ["  Example.COM  ", "example.com"],
    ["https://mail.example.com/inbox?folder=1#top", "mail.example.com"],
    ["http://example.com:8080/", "example.com"],
    ["https://user:pass@example.com/path", "example.com"],
    ["example.com.", "example.com"],
    ["example.com/sign-in", "example.com"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["a.b.c.example.co.uk", "a.b.c.example.co.uk"],
  ])("%j is the host %j", (typed, host) => {
    expect(excludedSite(typed)).toBe(host);
  });

  test.each(["", "   ", "localhost", "example", "exa mple.com", "example..com", ".example.com", "https://", "bücher.example", "exa_mple.com", "*.example.com", 7, null, undefined, ["example.com"]])(
    "%j is no website",
    (typed) => {
      expect(excludedSite(typed)).toBeNull();
    },
  );

  test("a host can be as long as DNS allows, and no longer", () => {
    const label = "a".repeat(61);
    const longest = `${[label, label, label, label].join(".")}.abcde`;
    expect(longest).toHaveLength(config.hostMaxLength);
    expect(excludedSite(longest)).toBe(longest);
    expect(excludedSite(`a${longest}`)).toBeNull();
  });

  test("the built-in web vaults cover their subdomains, and are themselves valid hosts", () => {
    expect(config.builtInExcludedSites.length).toBeGreaterThan(0);
    for (const site of config.builtInExcludedSites) {
      expect(excludedSite(site)).toBe(site);
      expect(isBuiltInExcludedSite(site)).toBe(true);
      expect(isBuiltInExcludedSite(`my.${site}`.toUpperCase())).toBe(true);
    }
    expect(new Set(config.builtInExcludedSites).size).toBe(config.builtInExcludedSites.length);
    expect(isBuiltInExcludedSite("example.com")).toBe(false);
  });

  test("only valid hosts are read back: none twice, none built in, at most excludedSitesMax", () => {
    const builtIn = config.builtInExcludedSites[0] ?? "";
    expect(storedExcludedSites(["example.com", "junk", "Example.com", "https://example.org", 7, builtIn, `my.${builtIn}`, "example.com", "mail.example.net"])).toEqual(["example.com", "mail.example.net"]);
    expect(storedExcludedSites("example.com")).toEqual([]);
    expect(storedExcludedSites(undefined)).toEqual([]);
    const many = Array.from({ length: config.excludedSitesMax + 5 }, (_, index) => `site${index}.example.com`);
    expect(storedExcludedSites(many)).toEqual(many.slice(0, config.excludedSitesMax));
  });
});
