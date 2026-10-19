// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/** `shared/form.css`, the stylesheet every window links, without comments. */
const css = readFileSync(join(import.meta.dirname, "../../../src/renderer/shared/form.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors = "", body = ""]) => ({ selectors: selectors.split(",").map((selector) => selector.trim()), body }));

test("a link button dims while pressed, unless it is disabled", () => {
  const pressed = rules.filter((rule) => rule.selectors.some((selector) => /^button\.link:active\b/.test(selector)));
  expect(pressed.map((rule) => rule.selectors)).toEqual([["button.link:active:not(:disabled)"]]);
  expect(Number(pressed[0]?.body.match(/opacity:\s*([\d.]+)\s*;/)?.[1] ?? 1)).toBeLessThan(1);
});
