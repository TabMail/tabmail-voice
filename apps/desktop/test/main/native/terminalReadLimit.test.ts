// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { helperRequestTimeout } from "../../../src/core/config.js";

const native = join(__dirname, "../../../native");
const constant = (file: string, pattern: RegExp): number => {
  const match = pattern.exec(readFileSync(join(native, file), "utf8"));
  expect(match, `${file} names its terminal read limit`).not.toBeNull();
  return Number(match?.[1]);
};

/** A terminal read holds the helper's one accessibility queue (Windows) or loop (Linux) from the
 * key-down. The paste is sent after it, with `helperRequestTimeout` to land, so a read that ends
 * within that time can never keep a paste waiting past its deadline. */
test.each([
  ["Windows", "windows/src/helper_config.h", /terminalReadBudgetMs = (\d+);/u],
  ["Linux", "linux/src/screen.h", /terminalReadMilliseconds = (\d+);/u],
])("the %s terminal read ends before a paste behind it is due", (_platform, file, pattern) => {
  const limit = constant(file, pattern);
  expect(limit).toBeGreaterThan(0);
  expect(limit).toBeLessThan(helperRequestTimeout);
});
