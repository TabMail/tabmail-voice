// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CorrectionWatch } from "../src/core/correctionWatch.js";

const interval = 100;
const duration = 1_000;
const pid = 42;
const pasted = "Please forward the Zivora contract today.";
const corrected = "Please forward the Xyvora contract today.";

/** A field the test edits, read as the helper would read it, and the words learned. */
function setup(initial: string | null = pasted) {
  const field = { value: initial as string | null, reads: 0, pids: [] as number[], fails: false };
  const learned: string[][] = [];
  const watch = new CorrectionWatch(
    async (readPid) => {
      field.reads += 1;
      field.pids.push(readPid);
      if (field.fails) throw new Error("helper gone");
      return field.value;
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

  /** A correction that has stayed for an interval is learned once the watch ends (here, the next
   * dictation's key-down), and only once. */
  test("learns a correction that stayed, when the watch ends", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pid, pasted);
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
    watch.watch(pid, text);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
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
      (): Promise<string> => {
        reads += 1;
        if (reads === 1) return Promise.resolve(pasted);
        if (reads === 2) return Promise.resolve(corrected);
        return new Promise((resolve) => (answer = resolve));
      },
      (words) => learned.push(words),
      interval,
      duration,
    );
    watch.watch(pid, pasted);
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
    watch.watch(pid, pasted);
    await poll();
    field.value = corrected;
    await poll();
    await poll();
    watch.watch(7, "Meet Brevale.");
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
});
