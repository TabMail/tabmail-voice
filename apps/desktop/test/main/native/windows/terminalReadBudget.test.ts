// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const source = (file: string) => readFileSync(join(__dirname, "../../../../native/windows/src", file), "utf8");

/** A terminal's whole visible screen is read, however long it takes (owner, 2026-10-05): the read runs
 * in voice-screen-reader.exe and holds up nothing else. Any other window's read stays bounded. The
 * Windows walk can't run here; Linux pins the same pair by running its walk (`screen-collection`). */
test("a Windows terminal read has no time limit, and any other read still has one", () => {
  expect(source("helper_config.h")).toMatch(/terminalReadBudgetMs = \(std::numeric_limits<unsigned long long>::max\)\(\);/u);
  const ordinary = /terminal \? HelperConfig::terminalReadBudgetMs : (\d+)/u.exec(source("accessibility.h"));
  expect(ordinary, "the screen read picks the terminal budget only for a terminal").not.toBeNull();
  expect(Number(ordinary?.[1])).toBeGreaterThan(0);
  expect(Number(ordinary?.[1])).toBeLessThan(10_000);
});
