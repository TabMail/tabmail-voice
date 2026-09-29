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

/** Learns the user's corrections of the pasted text, once each settles (ADR-DESK-038). */
describe("CorrectionWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("learns a correction once it has stayed for an interval", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pid, pasted);
    await poll();
    field.value = corrected;
    await poll();
    expect(learned).toEqual([]);
    await poll();
    expect(learned).toEqual([["Xyvora"]]);
    // Unchanged since: not compared again.
    await poll();
    await poll();
    expect(learned).toEqual([["Xyvora"]]);
    expect(new Set(field.pids)).toEqual(new Set([pid]));
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
    expect(learned).toEqual([]);
  });

  test("a field that never holds the pasted text teaches nothing", async () => {
    const { field, learned, watch } = setup("Something else.");
    watch.watch(pid, pasted);
    await poll();
    field.value = "Something else, Xyvora.";
    await vi.advanceTimersByTimeAsync(duration);
    expect(learned).toEqual([]);
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
    expect(learned).toEqual([]);
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
    expect(learned).toEqual([]);
  });

  /** A stop while a read is on its way: its answer is dropped. */
  test("a read answered after stop is dropped", async () => {
    let answer: (value: string) => void = () => {};
    const learned: string[][] = [];
    let reads = 0;
    const watch = new CorrectionWatch(
      (): Promise<string> => {
        reads += 1;
        return reads === 1 ? Promise.resolve(pasted) : new Promise((resolve) => (answer = resolve));
      },
      (words) => learned.push(words),
      interval,
      duration,
    );
    watch.watch(pid, pasted);
    await poll();
    await poll();
    watch.stop();
    answer(corrected);
    await vi.advanceTimersByTimeAsync(duration);
    expect(reads).toBe(2);
    expect(learned).toEqual([]);
  });

  /** A new watch replaces the last: only the new one reads. */
  test("a new watch ends the last", async () => {
    const { field, learned, watch } = setup();
    watch.watch(pid, pasted);
    await poll();
    watch.watch(7, "Meet Zivora.");
    field.value = "Meet Zivora.";
    await poll();
    field.value = "Meet Xyvora.";
    await poll();
    await poll();
    expect(field.pids).toEqual([pid, 7, 7, 7]);
    expect(learned).toEqual([["Xyvora"]]);
  });
});
