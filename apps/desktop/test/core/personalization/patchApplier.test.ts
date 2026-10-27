// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { applyKBPatch, normalizeUnicode } from "../../../src/core/personalization/patchApplier.js";

/** Thunderbird's own cases for the knowledge base's patches (its `test/patchApplier.test.js`,
 * TB-040 to TB-043 and the rest), ported so the three apps edit it alike. */
describe("applyKBPatch", () => {
  test("TB-040: ADD appends a bullet, with a period", () => {
    expect(applyKBPatch("- User likes coffee\n- User works remotely", "ADD\nUser prefers dark mode")).toBe("- User likes coffee\n- User works remotely\n- User prefers dark mode.");
  });

  test("TB-041: DEL removes a bullet", () => {
    expect(applyKBPatch("- User likes coffee.\n- User works remotely.\n- User prefers dark mode.", "DEL\nUser works remotely")).toBe("- User likes coffee.\n- User prefers dark mode.");
  });

  test("TB-042: ADD to an empty knowledge base", () => {
    expect(applyKBPatch("", "ADD\nFirst KB entry")).toContain("- First KB entry.");
  });

  test("TB-043: DEL of a statement that isn't there fails", () => {
    expect(applyKBPatch("- User likes coffee.\n- User works remotely.", "DEL\nUser likes tea")).toBeNull();
  });

  test("several ADDs in one patch", () => {
    expect(applyKBPatch("- Existing entry.", "ADD\nNew entry one\nADD\nNew entry two")).toBe("- Existing entry.\n- New entry one.\n- New entry two.");
  });

  test("an ADD then a DEL in one patch", () => {
    expect(applyKBPatch("- Keep this.\n- Remove this.", "ADD\nNew item\nDEL\nRemove this")).toBe("- Keep this.\n- New item.");
  });

  test("ADD of a statement already there changes nothing, whatever its case", () => {
    const content = "- User likes coffee.";
    expect(applyKBPatch(content, "ADD\nUser likes coffee")).toBe(content);
    expect(applyKBPatch(content, "ADD\nuser LIKES coffee")).toBe(content);
  });

  test("DEL matches whatever the case, with or without the final period", () => {
    expect(applyKBPatch("- User likes coffee\n- Other.", "DEL\nUSER LIKES COFFEE.")).toBe("- Other.");
  });

  test("DEL removes bullets only", () => {
    expect(applyKBPatch("User likes coffee.", "DEL\nUser likes coffee")).toBeNull();
  });

  /** A line starting with an en or em dash reads as a bullet once made plain, but is not one: DEL
   * leaves it, as Thunderbird does. */
  test("DEL leaves a line that only reads as a bullet once made plain", () => {
    expect(applyKBPatch("\u2013 User likes coffee.\n- Other.", "DEL\nUser likes coffee")).toBeNull();
  });

  test("a patch with no operation fails", () => {
    expect(applyKBPatch("- something", "not a valid operation")).toBeNull();
    expect(applyKBPatch("- something", "ADD")).toBeNull();
  });
});

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
