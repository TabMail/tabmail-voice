// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../src/core/config.js";
import { historyWindowOrigin } from "../src/core/overlayGeometry.js";
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

/** The window opens by the mouse pointer: right of it and under it, or on its other side where the
 * screen has no room, never off the screen. */
describe("the paste history window's place", () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const size = { width: config.pasteHistoryWindowWidth, height: 300 };
  const gap = config.pasteHistoryPointerGap;

  test("right of and under the pointer where there is room", () => {
    expect(historyWindowOrigin({ x: 100, y: 100 }, size, workArea)).toEqual({ x: 100 + gap, y: 100 + gap });
  });

  test("left of and over the pointer by the screen's far corner", () => {
    const pointer = { x: 1400, y: 880 };
    expect(historyWindowOrigin(pointer, size, workArea)).toEqual({ x: pointer.x - gap - size.width, y: pointer.y - gap - size.height });
  });

  test("within the screen where neither side has room", () => {
    const tall = { width: size.width, height: 800 };
    const origin = historyWindowOrigin({ x: 700, y: 450 }, tall, workArea);
    expect(origin.y).toBeGreaterThanOrEqual(workArea.y);
    expect(origin.y + tall.height).toBeLessThanOrEqual(workArea.y + workArea.height);

    const narrow = { x: 100, y: 25, width: size.width + 40, height: 875 };
    const across = historyWindowOrigin({ x: 100 + narrow.width / 2, y: 450 }, size, narrow);
    expect(across.x).toBeGreaterThanOrEqual(narrow.x);
    expect(across.x + size.width).toBeLessThanOrEqual(narrow.x + narrow.width);
  });
});
