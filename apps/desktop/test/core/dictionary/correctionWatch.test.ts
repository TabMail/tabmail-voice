// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ScreenExclusions } from "../../../src/core/dictation/excludedSites.js";
import { CorrectionWatch } from "../../../src/core/dictionary/correctionWatch.js";

const interval = 100;
const duration = 1_000;
const pid = 42;
const pasted = "Please forward the Zivora contract today.";
const none: ScreenExclusions = { apps: [], sites: [] };
const vault: ScreenExclusions = { apps: ["org.example.vault"], sites: ["example.com"] };
const corrected = "Please forward the Xyvora contract today.";

/** A field the test edits, read as the field reader would read it (the app in front `pid`), and the
 * words learned. */
function setup(initial: string | null = pasted) {
  const field = { value: initial as string | null, reads: 0, pids: [] as number[], excluded: [] as ScreenExclusions[], fails: false, target: pid as number | null, targets: 0 };
  const learned: string[][] = [];
  const watch = new CorrectionWatch(
    {
      target: async () => {
        field.targets += 1;
        return field.target;
      },
      value: async (readPid, exclusions) => {
        field.reads += 1;
        field.pids.push(readPid);
        field.excluded.push(exclusions);
        if (field.fails) throw new Error("helper gone");
        return field.value;
      },
    },
    (words) => learned.push(words),
    interval,
    duration,
  );
  return { field, learned, watch };
}

/** One poll, and the read it makes. */
const poll = () => vi.advanceTimersByTimeAsync(interval);

/** Learns the user's corrections of the pasted text: the one the field settles on, when the watch
 * ends (ADR-DESK-038). */
describe("CorrectionWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Every read of the field carries the apps and websites excluded from screen reading as the dictation started,
   * so the helper reads none of them; a field it won't read (null) ends the watch, nothing learned. */
  test("every read carries the dictation's excluded apps and websites, and an app not read teaches nothing", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, vault);
    await poll();
    await poll();
    expect(field.excluded).toEqual([{ apps: ["org.example.vault"], sites: ["example.com"] }, { apps: ["org.example.vault"], sites: ["example.com"] }]);

    field.value = null;
    await poll();
    await vi.advanceTimersByTimeAsync(duration);
    watch.stop();
    expect(field.reads).toBe(3);
    expect(learned).toEqual([]);
  });

  /** A terminal's field is the box around its cursor, its rows joined by the core's breaks (U+2029):
   * a dictation a full-screen program wrapped at a word, its next row indented, is found and its
   * correction learned, as is one a shell wrapped inside a word. */
  test("learns a correction in a terminal's box, across the rows the terminal wrapped", async () => {
    const box = (text: string) => `> ${text.replace("Zivora ", "Zivora\u2029  ").replace("Xyvora ", "Xyvora\u2029  ")}`;
    const { field, learned, watch } = setup(box(pasted));
    watch.watch(pasted, none);
    await poll();
    field.value = box(corrected);
    await poll();
    await poll();
    watch.stop();
    expect(learned).toEqual([["Xyvora"]]);

    const shell = setup("$ Please forward the Zivora con\u2029tract today.");
    shell.watch.watch(pasted, none);
    await poll();
    shell.field.value = "$ Please forward the Xyvora con\u2029tract today.";
    await poll();
    await poll();
    shell.watch.stop();
    expect(shell.learned).toEqual([["Xyvora"]]);
  });

  /** The whole-row rule is a terminal's: a field without rows learns what it teaches though it is not
   * in the field as written (the words of a respelling, read apart by two spaces). */
  test("a field without rows learns a respelling not written as one", async () => {
    const dictated = "Please forward the zivora corp contract today.";
    const { field, learned, watch } = setup(dictated);
    watch.watch(dictated, none);
    await poll();
    field.value = "Please forward the Xyvora  Corp contract today.";
    await poll();
    await poll();
    watch.stop();
    expect(learned).toEqual([["Xyvora Corp"]]);
  });

  /** A shell wraps its line at a column, and an edit that changes a word's length moves every wrap
   * after it: a word the terminal split, or two words a wrap at a blank runs together, is never
   * learned. While the field has rows, only a word read whole on one row is (the core's breaks
   * joined differently each read would teach words that were never typed). */
  test("learns only words read whole on a row of a terminal the user's edit rewrapped", async () => {
    const dictated = "Ask Steven to send the legal team the contract today and tell them we are ready";
    const fixed = dictated.replace("Steven", "Stephen");
    // The rows of a shell `width` columns wide, as the core cuts them: trailing blanks dropped.
    const wrapped = (text: string, width: number) => {
      const line = `$ git commit -m "${text}`;
      const rows: string[] = [];
      for (let at = 0; at < line.length; at += width) rows.push(line.slice(at, at + width).trimEnd());
      return rows.join("\u2029");
    };
    const outcomes = new Set<string>();
    for (let width = 12; width <= 80; width += 1) {
      const { field, learned, watch } = setup(wrapped(dictated, width));
      watch.watch(dictated, none);
      await poll();
      field.value = wrapped(fixed, width);
      await poll();
      await poll();
      watch.stop();
      outcomes.add(JSON.stringify(learned));
    }
    expect([...outcomes].sort()).toEqual([JSON.stringify([]), JSON.stringify([["Stephen"]])].sort());
  });

  /** Only the core's breaks are joined: a field whose own line break falls inside the pasted text
   * does not hold it, and teaches nothing. */
  test("never joins a field's own line breaks", async () => {
    const { field, learned, watch } = setup("Please forward the Zivora\ncontract today.");
    watch.watch(pasted, none);
    await poll();
    field.value = "Please forward the Xyvora\ncontract today.";
    await poll();
    await poll();
    watch.stop();
    expect(learned).toEqual([]);
  });

  /** A correction that has stayed for an interval is learned once the watch ends (here, the next
   * dictation's key-down), and only once. */
  test("learns a correction that stayed, when the watch ends", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    field.value = corrected;
    await poll();
    await poll();
    await poll();
    expect(learned).toEqual([]);
    watch.stop();
    expect(learned).toEqual([["Xyvora"]]);
    watch.stop();
    await vi.advanceTimersByTimeAsync(duration);
    expect(learned).toEqual([["Xyvora"]]);
    expect(new Set(field.pids)).toEqual(new Set([pid]));
  });

  /** A pause in the middle of an edit is a settled field too; only the edit the field ends on is
   * learned, never a spelling on the way to it, and an edit undone teaches nothing. */
  test.each([
    ["Sync the tab mail inbox.", ["Sync the tabmail inbox.", "Sync the TabMail inbox."], ["TabMail"]],
    [pasted, ["Please forward the Xyvor contract today."], ["Xyvora"]],
    [pasted, ["Please forward the Ziv contract today."], ["Xyvora"]],
    [pasted, ["Please forward the Xyvora contract today."], []],
  ])("only the edit the field ends on is learned: %s", async (text, steps, words) => {
    const { field, learned, watch } = setup(text);
    watch.watch(text, none);
    await poll();
    for (const step of steps) {
      field.value = step;
      await poll();
      await poll();
    }
    field.value = words.length === 0 ? text : text.replace(/tab mail|Zivora/, words[0]!);
    await poll();
    await poll();
    watch.stop();
    expect(learned).toEqual(words.length === 0 ? [] : [words]);
  });

  /** A correction kept is learned though the field then empties (the message sent) or shows other
   * text (focus moved on); undone, with words added after it, it teaches nothing. */
  test.each([
    ["", ["Xyvora"]],
    ["Something else entirely.", ["Xyvora"]],
    [`${pasted} Thanks!`, []],
  ])("after a correction settles, a field reading %j learns %j", async (after, words) => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    field.value = corrected;
    await poll();
    await poll();
    field.value = after;
    await poll();
    await poll();
    watch.stop();
    expect(learned).toEqual(words.length === 0 ? [] : [words]);
  });

  /** A spelling paused on, then changed or undone and sent before that change stayed, teaches nothing:
   * only a spelling the field held at the end of the edit is learned. */
  test.each([
    ["Please forward the Xyvor contract today.", corrected],
    [corrected, pasted],
  ])("paused on %j, then changed and sent at once, teaches nothing", async (paused, last) => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    field.value = paused;
    await poll();
    await poll();
    field.value = last;
    await poll();
    field.value = "";
    await poll();
    await poll();
    watch.stop();
    expect(learned).toEqual([]);
  });

  /** Text typed after a correction, read before it stays, keeps the correction. */
  test("a correction then words added and sent at once is learned", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    field.value = corrected;
    await poll();
    await poll();
    field.value = `${corrected} Thanks`;
    await poll();
    field.value = "";
    await poll();
    await poll();
    watch.stop();
    expect(learned).toEqual([["Xyvora"]]);
  });

  /** While the user is still typing the field changes at every read: nothing is compared until it
   * holds still. */
  test("a field still changing is not compared", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    for (const partial of ["Please forward the X contract today.", "Please forward the Xy contract today.", "Please forward the Xyv contract today."]) {
      field.value = partial;
      await poll();
    }
    expect(learned).toEqual([]);
    field.value = corrected;
    await poll();
    await poll();
    watch.stop();
    expect(learned).toEqual([["Xyvora"]]);
  });

  /** The paste may not have landed at the first read: the field before any edit is the first one that
   * holds the pasted text. */
  test("waits for the pasted text to be in the field", async () => {
    const { field, learned, watch } = setup("");
    watch.watch(pasted, none);
    await poll();
    await poll();
    field.value = pasted;
    await poll();
    field.value = corrected;
    await poll();
    await poll();
    watch.stop();
    expect(learned).toEqual([["Xyvora"]]);
  });

  /** Words added after the paste settle as an edit, but respell nothing. */
  test("an edit that respells nothing teaches nothing", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    field.value = `${pasted} Thanks!`;
    await poll();
    await poll();
    expect(field.reads).toBe(3);
    watch.stop();
    expect(learned).toEqual([]);
  });

  test("a field that never holds the pasted text teaches nothing", async () => {
    const { field, learned, watch } = setup("Something else.");
    watch.watch(pasted, none);
    await poll();
    field.value = "Something else, Xyvora.";
    await vi.advanceTimersByTimeAsync(duration);
    watch.stop();
    expect(learned).toEqual([]);
  });

  /** At the end of its duration the watch stops reading and learns the correction the field
   * settled on; one made after it is not learned. */
  test("learns when its duration ends", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    field.value = corrected;
    await vi.advanceTimersByTimeAsync(duration - 2 * interval);
    expect(learned).toEqual([]);
    await poll();
    expect(learned).toEqual([["Xyvora"]]);
    expect(field.reads).toBe(duration / interval);
  });

  test("stops reading after its duration", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await vi.advanceTimersByTimeAsync(duration);
    expect(field.reads).toBe(duration / interval);
    field.value = corrected;
    await vi.advanceTimersByTimeAsync(duration);
    expect(field.reads).toBe(duration / interval);
    expect(learned).toEqual([]);
  });

  /** No field to read (a password field, one too long, none focused), or a failed read: the watch
   * ends. */
  test.each([
    ["no field", (field: { value: string | null; fails: boolean }) => (field.value = null)],
    ["a failed read", (field: { value: string | null; fails: boolean }) => (field.fails = true)],
  ])("%s ends the watch", async (_label, fail) => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    fail(field);
    await poll();
    const reads = field.reads;
    field.value = corrected;
    field.fails = false;
    await vi.advanceTimersByTimeAsync(duration);
    expect(field.reads).toBe(reads);
    watch.stop();
    expect(learned).toEqual([]);
  });

  /** A field it can no longer read (focus moved to a password field, say) ends the watch, learning
   * the correction the field had settled on. */
  test("the end of the field learns what it settled on", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    field.value = corrected;
    await poll();
    await poll();
    field.value = null;
    expect(learned).toEqual([]);
    await poll();
    expect(learned).toEqual([["Xyvora"]]);
  });

  /** The next dictation's key-down stops the watch, so its paste is never taken for a correction. */
  test("stop ends the watch", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    watch.stop();
    field.value = corrected;
    await vi.advanceTimersByTimeAsync(duration);
    expect(field.reads).toBe(1);
    watch.stop();
    expect(learned).toEqual([]);
  });

  /** A stop while a read is on its way: its answer is dropped, though it would have settled an edit. */
  test("a read answered after stop is dropped", async () => {
    let answer: (value: string) => void = () => {};
    const learned: string[][] = [];
    let reads = 0;
    const watch = new CorrectionWatch(
      {
        target: async () => pid,
        value: (): Promise<string> => {
          reads += 1;
          if (reads === 1) return Promise.resolve(pasted);
          if (reads === 2) return Promise.resolve(corrected);
          return new Promise((resolve) => (answer = resolve));
        },
      },
      (words) => learned.push(words),
      interval,
      duration,
    );
    watch.watch(pasted, none);
    await poll();
    await poll();
    await poll();
    watch.stop();
    answer(corrected);
    await vi.advanceTimersByTimeAsync(duration);
    watch.stop();
    expect(reads).toBe(3);
    expect(learned).toEqual([]);
  });

  /** A new watch replaces the last, learning what the last settled on: only the new one reads. */
  test("a new watch ends the last", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    await poll();
    field.value = corrected;
    await poll();
    await poll();
    field.target = 7;
    watch.watch("Meet Brevale.", none);
    expect(learned).toEqual([["Xyvora"]]);
    field.value = "Meet Brevale.";
    await poll();
    field.value = "Meet Brevalle.";
    await poll();
    await poll();
    watch.stop();
    expect(field.pids).toEqual([pid, pid, pid, 7, 7, 7]);
    expect(learned).toEqual([["Xyvora"], ["Brevalle"]]);
  });
  /** The watch reads the app or window the reader finds in front as it starts, the one pasted into,
   * and none at all when there is none. */
  test("the watch reads the field of what is in front as it starts, and nothing without it", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pasted, none);
    expect(field.targets).toBe(1);
    await poll();
    field.target = 7;
    await poll();
    expect(field.pids).toEqual([pid, pid]);
    watch.stop();

    field.target = null;
    watch.watch(pasted, none);
    await vi.advanceTimersByTimeAsync(duration);
    expect(field.targets).toBe(2);
    expect(field.reads).toBe(2);
    expect(learned).toEqual([]);
  });

  /** A reader that can't say what is in front is a watch with nothing to read. */
  test("a failed target lookup watches nothing", async () => {
    const { field, learned, watch } = setup();
    const failing = new CorrectionWatch({ target: () => Promise.reject(new Error("reader gone")), value: async () => { field.reads += 1; return field.value; } }, (words) => learned.push(words), interval, duration);
    failing.watch(pasted, none);
    await vi.advanceTimersByTimeAsync(duration);
    expect(field.reads).toBe(0);
    expect(learned).toEqual([]);
    watch.stop();
  });

  /** The next dictation's key-down while the reader is still looking up the target: the old watch
   * never starts reading, so the next paste is never taken for an edit of the last. */
  test("a watch stopped while its target is looked up never reads", async () => {
    const { field, learned } = setup();
    let answer: (target: number | null) => void = () => {};
    const slow = new CorrectionWatch({ target: () => new Promise((resolve) => (answer = resolve)), value: async () => { field.reads += 1; return field.value; } }, (words) => learned.push(words), interval, duration);
    slow.watch(pasted, none);
    slow.stop();
    answer(pid);
    await vi.advanceTimersByTimeAsync(duration);
    expect(field.reads).toBe(0);
  });
});
