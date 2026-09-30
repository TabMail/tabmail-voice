// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../src/core/config.js";
import { chatSide, chatWindowFrame, historyWindowFrame } from "../src/core/overlayGeometry.js";
import { PasteHistory, pastedAgo } from "../src/core/pasteHistory.js";

/** The paste history a triple tap shows (ADR-DESK-043). */
describe("PasteHistory", () => {
  test("keeps the newest first, at most its limit", () => {
    const history = new PasteHistory(3, () => 1_000);
    for (const text of ["one", "two", "three", "four"]) history.add(text);
    expect(history.entries.map((entry) => entry.text)).toEqual(["four", "three", "two"]);
    expect(history.entries.every((entry) => entry.at === 1_000)).toBe(true);
  });

  test("the same text again moves up rather than showing twice", () => {
    const history = new PasteHistory();
    history.add("one");
    history.add("two");
    history.add("one");
    expect(history.entries.map((entry) => entry.text)).toEqual(["one", "two"]);
  });

  test("blank text is nothing to keep", () => {
    const history = new PasteHistory();
    history.add(" \n ");
    expect(history.entries).toEqual([]);
  });

  /** A click copies an entry by its id, which stays its own as newer entries arrive; one dropped off
   * the end copies nothing. */
  test("finds an entry's text by its id until it drops off", () => {
    const history = new PasteHistory(2);
    history.add("one");
    const id = history.entries[0]?.id ?? -1;
    history.add("two");
    expect(history.text(id)).toBe("one");
    history.add("three");
    expect(history.text(id)).toBeNull();
  });

  test("tells its watchers of each entry", () => {
    const history = new PasteHistory();
    let changes = 0;
    history.observe(() => (changes += 1));
    history.add("one");
    history.add("");
    expect(changes).toBe(1);
  });

  test("says how long ago an entry came", () => {
    const now = Date.now();
    expect(pastedAgo(now - 5_000, now)).toBe("just now");
    expect(pastedAgo(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(pastedAgo(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(pastedAgo(now - 3 * 86_400_000, now)).toBe(new Date(now - 3 * 86_400_000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }));
  });
});

/** The window opens where the chat window's answer box does (owner, 2026-09-30: "like the answer
 * tool"): over the pill and its bubbles, or under them where there is more room, never off the screen. */
describe("the paste history window's place", () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const size = { width: config.pasteHistoryWindowWidth, height: 300 };

  /** The chat window's answer box, `height` tall, for the pill at `pill`: its frame without the
   * shadow's margin, the pill and its bubbles. */
  function answerBox(pill: { x: number; y: number }, height: number, bubblesUnder: boolean): { x: number; y: number; width: number; height: number } {
    const side = chatSide(pill.y, bubblesUnder, workArea);
    const frame = chatWindowFrame(pill, height, workArea, side, bubblesUnder);
    const margin = config.chatShadowMargin;
    const strip = config.chatPillGap + config.chatStripHeight;
    return { x: frame.x + margin, y: frame.y + margin + (side.below ? strip : 0), width: frame.width - 2 * margin, height: frame.height - 2 * margin - strip };
  }

  test.each([
    ["over the pill", { x: 700, y: 600 }, true],
    ["over the pill's bubbles", { x: 700, y: 600 }, false],
    ["under the pill near the screen's top", { x: 700, y: 100 }, true],
    ["kept inside the screen's left edge", { x: 40, y: 600 }, true],
    ["kept inside the screen's right edge", { x: 1420, y: 100 }, false],
  ])("%s, where the answer box goes", (_, pill, bubblesUnder) => {
    expect(config.pasteHistoryWindowWidth).toBe(config.chatWidth);
    expect(historyWindowFrame(pill, size, workArea, bubblesUnder)).toEqual(answerBox(pill, size.height, bubblesUnder));
  });

  test("its edge by the pill stays put as its list measures itself", () => {
    const pill = { x: 700, y: 600 };
    const tall = historyWindowFrame(pill, size, workArea, true);
    const short = historyWindowFrame(pill, { ...size, height: 120 }, workArea, true);
    expect(short.y + short.height).toBe(tall.y + tall.height);
    const under = { x: 700, y: 100 };
    expect(historyWindowFrame(under, { ...size, height: 120 }, workArea, true).y).toBe(historyWindowFrame(under, size, workArea, true).y);
  });

  /** Taller than the answer box may grow, it goes over the pill only where it fits there whole, and is
   * never taller than the room on its side. */
  test("no taller than the room on its side", () => {
    const tallest = { ...size, height: config.pasteHistoryMaxHeight };
    const middle = historyWindowFrame({ x: 700, y: 380 }, tallest, workArea, true);
    expect(middle.y).toBeGreaterThanOrEqual(workArea.y);
    expect(middle.y + middle.height).toBeLessThanOrEqual(workArea.y + workArea.height);
    const short = { x: 0, y: 25, width: 1440, height: 300 };
    const squeezed = historyWindowFrame({ x: 700, y: 175 }, tallest, short, true);
    expect(squeezed.height).toBeLessThan(tallest.height);
    expect(squeezed.y).toBeGreaterThanOrEqual(short.y);
    expect(squeezed.y + squeezed.height).toBeLessThanOrEqual(short.y + short.height);
  });
});
