// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { coversHost } from "../../src/core/dictation/excludedSites.js";

interface HostCase {
  name: string;
  site: string;
  host: string;
  excluded: boolean;
}

const file = join(__dirname, "../../native/shared/privacy/host-exclusion-cases.json");
const cases = (JSON.parse(readFileSync(file, "utf8")) as { cases: HostCase[] }).cases;

/** Which hosts an excluded website covers is one rule for the app and every helper (ADR-DESK-047):
 * the cases each helper's own tests run too, so what Settings calls excluded is what a helper
 * refuses to read. */
describe("the shared host-exclusion cases", () => {
  test("there are cases both ways, each named once", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.some((item) => item.excluded) && cases.some((item) => !item.excluded)).toBe(true);
    expect(new Set(cases.map((item) => item.name)).size).toBe(cases.length);
  });

  test.each(cases.map((item) => [item.name, item] as const))("%s", (_name, item) => {
    expect(coversHost(item.site, item.host)).toBe(item.excluded);
  });
});
