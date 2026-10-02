// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";
import { type DictationTip, TipBook, tipDetails, tipKeycap, tipLines, tipParts } from "../../../src/core/onboarding/tips.js";

describe("TipBook", () => {
  test.each<DictationTip>(["agentAndHistory", "doubleTap"])("%s shows at most its max displays", (tip) => {
    const store = new MemoryStore();
    const tips = new TipBook(store);
    const maxDisplays = tipDetails[tip].maxDisplays;
    expect(maxDisplays).not.toBeNull();
    for (let index = 0; index < (maxDisplays ?? 0); index += 1) {
      expect(tips.isEligible(tip)).toBe(true);
      tips.recordDisplay(tip);
    }
    expect(tips.isEligible(tip)).toBe(false);
    // Kept across launches.
    expect(new TipBook(store).isEligible(tip)).toBe(false);
  });

  /** A tip configured with no maximum shows however often it has shown: the hands-free tip, and the
   * name tip until a name is set (owner, 2026-09-28: a nag). */
  test.each<DictationTip>(["handsFree", "setName"])("%s has no maximum and shows every time", (tip) => {
    expect(tipDetails[tip].maxDisplays).toBeNull();
    const tips = new TipBook(new MemoryStore());
    for (let index = 0; index < 100; index += 1) tips.recordDisplay(tip);
    expect(tips.isEligible(tip)).toBe(true);
  });

  test("a learned tip never shows again, and learning one leaves the other", () => {
    const store = new MemoryStore();
    new TipBook(store).markLearned("agentAndHistory");

    const tips = new TipBook(store);
    expect(tips.isEligible("agentAndHistory")).toBe(false);
    expect(tips.isEligible("doubleTap")).toBe(true);
  });

  test("the tips' words, limits and durations come from the config", () => {
    expect(tipDetails).toEqual({ agentAndHistory: config.agentAndHistoryTip, doubleTap: config.doubleTapTip, handsFree: config.handsFreeTip, setName: config.setNameTip });
  });
});

describe("tips", () => {
  /** The double-tap tip names the key the user holds. */
  test("the double-tap tip names the hotkey", () => {
    expect(tipKeycap("doubleTap", "rightOption")).toBe("right ⌥");
    expect(tipKeycap("doubleTap", "function")).toBe("fn");
    expect(tipKeycap("agentAndHistory", "function")).toBe("space");
  });

  test("Linux tips name the portal shortcuts rather than unavailable plain Space and Escape", () => {
    expect(tipKeycap("agentAndHistory", "F8")).toBe("Shift+F8");
    const keys = tipLines("handsFree", "F9").flat().flatMap((part) => "key" in part ? [part.key] : []);
    expect(keys).toEqual(["F9", "Ctrl+Shift+F9"]);
  });

  test("active GNOME integration names Shift and Escape while preserving other platforms", () => {
    expect(tipLines("agentAndHistory", "F8", true).flat()).toContainEqual({ key: "Shift" });
    expect(tipLines("handsFree", "F8", true).flat()).toContainEqual({ key: "Esc" });
    expect(tipLines("agentAndHistory", "rightOption", true)).toEqual(tipLines("agentAndHistory", "rightOption"));
  });

  test("the tips say what the key does", () => {
    const words = (lines: ReturnType<typeof tipLines>) => lines.flat().map((part) => ("words" in part ? part.words : part.key)).join(" ").toLowerCase();
    expect(words(tipLines("agentAndHistory", "rightOption"))).toBe("press space for agent mode, triple-tap right ⌥ for history");
    expect(words(tipLines("doubleTap", "function"))).toBe("double-tap fn to dictate without holding");
    expect(words(tipLines("handsFree", "function"))).toBe("tap fn to finish dictating, or tap esc to cancel");
  });

  /** A configured line's `[key]` is a keycap and `[hotkey]` the dictation key's; the rest is words,
   * an unclosed bracket included. */
  test("configured lines become words and keycaps", () => {
    expect(tipParts("Tap [hotkey] to finish", "function")).toEqual([{ words: "Tap" }, { key: "fn" }, { words: "to finish" }]);
    expect(tipParts("[space] then [hotkey]", "rightOption")).toEqual([{ key: "space" }, { words: "then" }, { key: "right ⌥" }]);
    expect(tipParts("dictating, or", "function")).toEqual([{ words: "dictating, or" }]);
    expect(tipParts("press [esc", "function")).toEqual([{ words: "press [esc" }]);
    expect(tipLines("handsFree", "function")).toEqual([[{ words: "Tap" }, { key: "fn" }, { words: "to finish dictating," }], [{ words: "or tap" }, { key: "esc" }, { words: "to cancel" }]]);
  });
});
