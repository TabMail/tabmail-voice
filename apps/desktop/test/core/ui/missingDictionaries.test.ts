// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { canInstallDictionary, missingDictionaries, missingDictionaryLabel, missingDictionaryNotice } from "../../../src/core/ui/missingDictionaries.js";

/** The user's languages the system has no spelling dictionary for, as the menu tells them (ADR-DESK-038). */
describe("missingDictionaries", () => {
  test("names each language once, by its language alone, in order", () => {
    expect(missingDictionaries(["ko-KR", "el_GR.UTF-8", "ko-CA", "pt-BR"])).toEqual([
      { language: "ko", name: "Korean" },
      { language: "el", name: "Greek" },
      { language: "pt", name: "Portuguese" },
    ]);
  });

  /** Screen terms are split at spaces, so a dictionary would not tell these languages' words apart. */
  test("asks for none for a language written without spaces", () => {
    expect(missingDictionaries(["zh-Hans-CN", "ja-JP", "th-TH", "lo", "km", "my-MM", "hr-HR"])).toEqual([{ language: "hr", name: "Croatian" }]);
  });

  /** The system may name a language in capitals or mixed case (a POSIX locale "KO_kr.UTF-8"). */
  test("a language in any case is named once", () => {
    expect(missingDictionaries(["KO_kr.UTF-8", "ko-KR", "JA-JP", "EL-gr"])).toEqual([
      { language: "ko", name: "Korean" },
      { language: "el", name: "Greek" },
    ]);
  });

  test("a tag naming no language is skipped, and a language without an English name keeps its code", () => {
    expect(missingDictionaries(["C", "", "english", "qaa-x-private", "x1"])).toEqual([{ language: "qaa", name: "qaa" }]);
  });

  test("no languages, no warnings", () => {
    expect(missingDictionaries([])).toEqual([]);
  });
});

describe("the menu's words for a missing dictionary", () => {
  const korean = { language: "ko", name: "Korean" };

  test("Windows and Linux can install one; macOS has none to add", () => {
    expect(["win32", "linux", "darwin"].map(canInstallDictionary)).toEqual([true, true, false]);
    expect(missingDictionaryLabel(korean, "win32")).toBe("Install a Spelling Dictionary for Korean…");
    expect(missingDictionaryLabel(korean, "linux")).toBe("Install a Spelling Dictionary for Korean…");
    expect(missingDictionaryLabel(korean, "darwin")).toBe("No macOS spelling dictionary for Korean");
  });

  test("the notice says why, and how to install it on Windows and on Ubuntu", () => {
    const windows = missingDictionaryNotice(korean, "win32");
    expect(windows.message).toBe("Your system has no spelling dictionary for Korean.");
    expect(windows.detail).toContain("every capitalized word in Korean is taken for a name");
    expect(windows.detail).toContain("open Settings > Time & language > Language & region, add Korean under Preferred languages");
    expect(windows.detail).not.toContain("hunspell");

    const linux = missingDictionaryNotice(korean, "linux");
    expect(linux.message).toBe(windows.message);
    expect(linux.detail).toContain("Manage Installed Languages and install Korean");
    expect(linux.detail).toContain("apt search hunspell-ko");
    expect(linux.detail).not.toContain("Time & language");
    for (const detail of [windows.detail, linux.detail]) expect(detail).toContain("from your next dictation");
  });
});
