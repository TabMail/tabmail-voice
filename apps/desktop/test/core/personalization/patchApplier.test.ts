// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { normalizeUnicode } from "../../../src/core/personalization/patchApplier.js";

/** Thunderbird's own cases for the knowledge base's patches (its `test/patchApplier.test.js`,
 * TB-040 to TB-043 and the rest), ported so the three apps edit it alike. */
describe("normalizeUnicode", () => {
  test("a line's leading dash becomes a hyphen; one within a line stays", () => {
    expect(normalizeUnicode("\u2013 item \u2014 aside\n  \u2014 next")).toBe("- item \u2014 aside\n  - next");
  });

  /** Every character Thunderbird makes plain, one at a time, as its `normalizeUnicode` does. */
  test.each(["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212"])("a line starting with U+%s starts with a hyphen", (dash) => {
    expect(normalizeUnicode(`${dash} item\n  ${dash} next`)).toBe("- item\n  - next");
  });

  test.each([
    ...["\u2018", "\u2019", "\u201B", "\u2032", "\u2035"].map((quote) => [quote, "'"]),
    ...["\u201C", "\u201D", "\u201E", "\u201F"].map((quote) => [quote, '"']),
    ["\u3010", "["],
    ["\u3011", "]"],
    ...["\u00A0", "\u202F", "\u2007", "\u2008", "\u2009", "\u200A", "\u200B", "\u2028", "\u2029", "\u205F", "\u3000"].map((space) => [space, " "]),
    ["\u2026", "..."],
  ])("%j is made %j", (character, plain) => {
    expect(normalizeUnicode(`a${character}b`)).toBe(`a${plain}b`);
  });

  test("quotes, brackets, spaces and the ellipsis made plain", () => {
    expect(normalizeUnicode("\u201Cit\u2019s\u201D \u3010x\u3011\u00A0a\u2026")).toBe("\"it's\" [x] a...");
  });
});
