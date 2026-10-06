// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const source = (file: string) => readFileSync(join(__dirname, "../../../../native/windows/src", file), "utf8");

/** A terminal's whole visible screen is read, however long it takes (owner, 2026-10-05): the read runs
 * in voice-screen-reader.exe and holds up nothing else. Any other window's read keeps the shared
 * core's time budget, which its limits case pins for every helper. The Windows walk can't run here;
 * Linux pins the same pair by running its walk (`screen-collection`). */
test("a Windows terminal read has no time limit, and any other read still has one", () => {
  expect(source("helper_config.h")).toMatch(/terminalReadBudgetMs = \(std::numeric_limits<unsigned long long>::max\)\(\);/u);
  expect(source("accessibility.h"), "the screen read picks the terminal budget only for a terminal").toContain(
    "terminal ? HelperConfig::terminalReadBudgetMs : walk::limits().timeBudgetMilliseconds",
  );
  const cases = JSON.parse(readFileSync(join(__dirname, "../../../../native/shared/context/walk-cases.json"), "utf8")) as {
    cases: { request: Record<string, unknown>; expected?: { timeBudgetMilliseconds?: number } }[];
  };
  const limits = cases.cases.find((entry) => "limits" in entry.request)?.expected?.timeBudgetMilliseconds;
  expect(limits).toBeGreaterThan(0);
  expect(limits).toBeLessThan(10_000);
});
