// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { compositionSections, extractBullets, extractSection, mergeFlatField, replaceSection } from "../../../src/core/personalization/bulletMerge.js";
import { defaultComposition } from "../../../src/core/personalization/defaults.js";

/** Thunderbird's own cases for the same merge (its `test/bulletMerge.test.js`, TB-001 to TB-010),
 * ported so the three apps merge alike. */
describe("mergeFlatField", () => {
  test("TB-001: keeps a local and a remote addition", () => {
    const result = mergeFlatField("- alpha\n- beta", "- alpha\n- beta\n- gamma", "- alpha\n- beta\n- delta");
    expect(result).toBe("- alpha\n- beta\n- gamma\n- delta");
  });

  test("TB-002: keeps a remote addition and a local removal", () => {
    const result = mergeFlatField("- alpha\n- beta\n- gamma", "- alpha\n- gamma", "- alpha\n- beta\n- gamma\n- delta");
    expect(result).toBe("- alpha\n- gamma\n- delta");
  });

  test("TB-003: a bullet both sides removed is removed once", () => {
    const result = mergeFlatField("- alpha\n- beta\n- gamma", "- alpha\n- gamma", "- alpha\n- gamma");
    expect(result).toBe("- alpha\n- gamma");
  });

  test("TB-004: a bullet both sides added is there once", () => {
    const result = mergeFlatField("- alpha", "- alpha\n- beta", "- alpha\n- beta");
    expect(result.match(/- beta/g)).toHaveLength(1);
  });

  test("TB-005: from an empty base, both sides' bullets", () => {
    const result = mergeFlatField("", "- alpha\n- beta", "- gamma\n- delta");
    expect(result).toBe("- alpha\n- beta\n- gamma\n- delta");
  });

  test("TB-006: both sides emptied: local, unchanged", () => {
    expect(mergeFlatField("- alpha\n- beta", "", "")).toBe("");
  });

  test("TB-008: local's order is kept, remote's additions after it", () => {
    const result = mergeFlatField("- a\n- b\n- c", "- c\n- b\n- a", "- a\n- b\n- c\n- d");
    expect(result.split("\n")).toEqual(["- c", "- b", "- a", "- d"]);
  });

  test("TB-009: bullets with spaces in them", () => {
    const result = mergeFlatField("- alpha\n- beta", "- alpha\n- beta\n- gamma with spaces", "- alpha\n- beta\n- delta with spaces");
    expect(result).toContain("- gamma with spaces");
    expect(result).toContain("- delta with spaces");
  });

  test("TB-010: 1,200 bullets, with removals and additions on both sides", () => {
    const bullets = Array.from({ length: 1_200 }, (_, i) => `- bullet ${i}`);
    const local = [...bullets, ...Array.from({ length: 100 }, (_, i) => `- local new ${i}`)].join("\n");
    const remote = [...bullets.slice(50), ...Array.from({ length: 100 }, (_, i) => `- remote new ${i}`)].join("\n");
    const lines = mergeFlatField(bullets.join("\n"), local, remote).split("\n");
    expect(lines).toContain("- local new 0");
    expect(lines).toContain("- remote new 0");
    expect(lines).not.toContain("- bullet 0");
    expect(lines).not.toContain("- bullet 49");
    expect(lines).toContain("- bullet 50");
  });

  test("local, as written, when the merge changes none of its bullets", () => {
    const local = "- alpha\n\nnot a bullet\n- beta";
    expect(mergeFlatField("- alpha\n- beta", local, "- alpha\n- beta")).toBe(local);
  });
});

/** A bullet is read with the spaces around its line trimmed, as Thunderbird reads it: a text written
 * elsewhere (Thunderbird, iOS) may indent or pad its bullets. */
describe("extractBullets", () => {
  test("an indented or padded bullet reads as its words", () => {
    expect(extractBullets("  - alpha  \n\t- beta\t\n- gamma")).toEqual(["alpha", "beta", "gamma"]);
  });

  test("a removal holds against a padded copy of the bullets it was made from", () => {
    expect(mergeFlatField("- alpha\n- beta", "- alpha", "  - alpha  \n  - beta  ")).toBe("- alpha");
  });
});

describe("the writing style's sections", () => {
  test("each section's bullets read from Thunderbird's default", () => {
    const sections = compositionSections.map((section) => extractBullets(extractSection(defaultComposition, section)));
    expect(sections.map((bullets) => bullets.length)).toEqual([4, 1, 2]);
    expect(sections[1]).toEqual(["I write in English Only."]);
  });

  test("a section replaced keeps the others, its header and the instructions' markers", () => {
    const replaced = replaceSection(defaultComposition, "Language", "- I write in French.");
    expect(extractSection(replaced, "Language")).toBe("- I write in French.");
    for (const section of [compositionSections[0], compositionSections[2]]) {
      expect(extractSection(replaced, section ?? "")).toBe(extractSection(defaultComposition, section ?? ""));
    }
    expect(replaced).toContain("# Language (DO NOT EDIT/DELETE THIS SECTION HEADER)");
    expect(replaced).toContain("====END USER INSTRUCTIONS====");
  });

  test("a section that isn't there reads empty, and replacing it changes nothing", () => {
    expect(extractSection("- loose", "Language")).toBe("");
    expect(replaceSection("- loose", "Language", "- new")).toBe("- loose");
  });
});
