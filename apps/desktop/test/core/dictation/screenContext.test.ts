// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import type { ScreenExclusions } from "../../../src/core/dictation/excludedSites.js";
import { isScreenHidden, type ScreenContext, ScreenContextProbe, type ScreenRead, screenShown } from "../../../src/core/dictation/screenContext.js";

const none: ScreenExclusions = { apps: [], sites: [] };

function screen(overrides: Partial<ScreenContext> = {}): ScreenContext {
  return {
    appName: "Example Notes",
    bundleID: "com.example.notes",
    windowTitle: null,
    host: null,
    terminalProgram: null,
    focusedRole: null,
    textBeforeCaret: "Dear Alex,",
    selectedText: "",
    selectionRedacted: false,
    textAfterCaret: "",
    renderedText: "» Dear Alex,‸",
    summary: "1 block",
    logDescription: "app Example Notes (com.example.notes)\n--- visible text ---\n» Dear Alex,‸",
    ...overrides,
  };
}

afterEach(() => configureLog({ isDebugBuild: false, sinks: { error: () => {} } }));

describe("ScreenContextProbe", () => {
  test("without the Accessibility grant nothing is read", () => {
    let reads = 0;
    const probe = new ScreenContextProbe(() => false, () => {
      reads += 1;
      return Promise.resolve(screen());
    });

    expect(probe.capture(none)).toBeNull();
    expect(reads).toBe(0);
  });

  /** The apps and websites the dictation excludes reach the read as given, so the helper never
   * reads one. */
  test("the read is asked with the dictation's excluded apps and websites", async () => {
    const asked: ScreenExclusions[] = [];
    const probe = new ScreenContextProbe(() => true, (exclusions) => {
      asked.push(exclusions);
      return Promise.resolve(null);
    });

    const exclusions = { apps: ["org.example.vault", "org.example.bank"], sites: ["example.com"] };
    expect(await probe.capture(exclusions)).toBeNull();
    expect(asked).toEqual([{ apps: ["org.example.vault", "org.example.bank"], sites: ["example.com"] }]);
  });

  /** A stop names the capture's own read, which then yields what it read so far; a promise the
   * probe never gave stops nothing. */
  test("a stop reaches the capture's own read", async () => {
    const reads: Promise<ScreenContext | null>[] = [];
    const stopped: Promise<unknown>[] = [];
    let answer: (context: ScreenContext) => void = () => {};
    const probe = new ScreenContextProbe(() => true, () => {
      const read = new Promise<ScreenContext | null>((resolve) => (answer = resolve));
      reads.push(read);
      return read;
    }, () => {}, (read) => {
      stopped.push(read);
      answer(screen({ renderedText: "so far" }));
    });

    const capture = probe.capture(none)!;
    probe.stop(Promise.resolve(null));
    expect(stopped).toEqual([]);
    probe.stop(capture);

    expect(stopped).toEqual([reads[0]]);
    expect(await capture).toMatchObject({ renderedText: "so far" });
  });

  /** A failed or empty read is no context, never an error for the dictation. */
  test("a failed read is no context", async () => {
    const probe = new ScreenContextProbe(() => true, () => Promise.reject(new Error("helper gone")));
    expect(await probe.capture(none)).toBeNull();
    expect(await new ScreenContextProbe(() => true, () => Promise.resolve(null)).capture(none)).toBeNull();
  });

  /** Debug builds keep the newest capture for the debug window; an older read finishing later
   * does not replace it. */
  test("debug builds keep the latest capture only", async () => {
    configureLog({ isDebugBuild: true, sinks: { error: () => {} } });
    const reads: ((context: ScreenContext) => void)[] = [];
    const probe = new ScreenContextProbe(() => true, () => new Promise((resolve) => reads.push(resolve)));

    const older = probe.capture(none);
    const newer = probe.capture(none);
    reads[1]?.(screen({ appName: "Newer" }));
    await newer;
    reads[0]?.(screen({ appName: "Older" }));

    expect(screenShown(await older)?.appName).toBe("Older");
    expect(probe.lastContext?.appName).toBe("Newer");
  });

  /** A screen the helper hides for privacy is passed on as hidden, and is no screen to anything
   * that uses one; nothing of it is kept for the debug window, and what was kept stays. */
  test("a hidden screen is passed on as hidden and never kept", async () => {
    configureLog({ isDebugBuild: true, sinks: { error: () => {} } });
    let hidden = false;
    let captures = 0;
    const probe = new ScreenContextProbe(() => true, () => Promise.resolve(hidden ? { hidden: true } : screen({ appName: "Shown" })), () => {
      captures += 1;
    });

    const shown = await probe.capture(none);
    hidden = true;
    const read = await probe.capture(none);

    expect(read).toEqual({ hidden: true });
    expect(isScreenHidden(read)).toBe(true);
    expect(screenShown(read)).toBeNull();
    expect(isScreenHidden(shown)).toBe(false);
    expect(screenShown(shown)?.appName).toBe("Shown");
    expect(isScreenHidden(null)).toBe(false);
    expect(screenShown(null)).toBeNull();
    expect(probe.lastContext?.appName).toBe("Shown");
    expect(captures).toBe(1);
  });

  /** Each capture reads what the window shows, then, once that has answered, the whole window
   * (ADR-DESK-016, 2026-10-25) of the window that read read (bound to it: the helper reads nothing
   * if another window came to the front since): numbered after it, so a stop of the first never
   * reaches it. With the same exclusions. */
  test("the whole window is read after what it shows has answered", async () => {
    const asked: [ScreenExclusions, Promise<ScreenRead | null> | undefined][] = [];
    const reads: Promise<ScreenRead | null>[] = [];
    const answers: ((context: ScreenContext) => void)[] = [];
    const probe = new ScreenContextProbe(() => true, (exclusions, wholeWindowOf) => {
      asked.push([exclusions, wholeWindowOf]);
      const read = new Promise<ScreenRead | null>((resolve) => answers.push(resolve));
      reads.push(read);
      return read;
    });
    const exclusions = { apps: ["org.example.vault"], sites: ["example.com"] };

    const capture = probe.capture(exclusions)!;
    const window = probe.window(capture)!;
    expect(asked).toEqual([[exclusions, undefined]]);
    answers[0]!(screen({ renderedText: "shown" }));
    expect(screenShown(await capture)?.renderedText).toBe("shown");
    await Promise.resolve();
    expect(asked).toHaveLength(2);
    expect(asked[1]![0]).toBe(exclusions);
    expect(asked[1]![1]).toBe(reads[0]);
    answers[1]!(screen({ renderedText: "whole" }));
    expect(screenShown(await window)?.renderedText).toBe("whole");
    expect(probe.window(Promise.resolve(null))).toBeNull();
  });

  /** The whole window's own read failing, finding nothing (another window came to the front since,
   * so the helper read none) or finding the window hidden: the whole window is that, never the shown
   * read passed off as the whole window, and never an error; what the window shows stays as read. */
  test.each<[string, () => Promise<ScreenRead | null>, ScreenRead | null]>([
    ["fails", () => Promise.reject(new Error("helper restarted")), null],
    ["finds no window", () => Promise.resolve(null), null],
    ["finds it hidden", () => Promise.resolve({ hidden: true }), { hidden: true }],
  ])("the whole window's read that %s gives that, and keeps what the window shows", async (_, second, expected) => {
    let reads = 0;
    const probe = new ScreenContextProbe(() => true, () => (reads++ === 0 ? Promise.resolve(screen({ renderedText: "shown" })) : second()));
    const capture = probe.capture(none)!;
    await expect(probe.window(capture)!).resolves.toEqual(expected);
    expect(reads).toBe(2);
    expect(screenShown(await capture)?.renderedText).toBe("shown");
  });

  /** A window not read, or hidden for privacy, is not read again: the whole window gives the same. */
  test.each<[string, ScreenContext | { hidden: true } | null]>([["hidden", { hidden: true }], ["not read", null]])("a window %s is not read whole", async (_, answer) => {
    const scopes: boolean[] = [];
    const probe = new ScreenContextProbe(() => true, (_, wholeWindowOf) => {
      scopes.push(wholeWindowOf !== undefined);
      return Promise.resolve(answer);
    });
    const capture = probe.capture(none)!;
    expect(await probe.window(capture)).toEqual(answer);
    expect(scopes).toEqual([false]);
  });

  /** A newer capture before the first has answered: the old one's whole window is never read. */
  test("a newer capture means the older window is not read whole", async () => {
    const scopes: boolean[] = [];
    const answers: ((context: ScreenContext) => void)[] = [];
    const probe = new ScreenContextProbe(() => true, (_, wholeWindowOf) => {
      scopes.push(wholeWindowOf !== undefined);
      return new Promise((resolve) => answers.push(resolve));
    });
    const older = probe.capture(none)!;
    probe.capture(none);
    answers[0]!(screen());
    expect(await probe.window(older)).toBeNull();
    expect(scopes).toEqual([false, false]);
  });

  /** A stop reaches the whole window's own read once it has started. Before it starts (what the
   * window shows is still being read), the stop reaches that read, the whole window is not read, and
   * what was read of the window is the answer. */
  test("a stop reaches the whole window's read, or the read before it", async () => {
    const reads: Promise<ScreenContext | null>[] = [];
    const answers: ((context: ScreenContext) => void)[] = [];
    const stopped: Promise<unknown>[] = [];
    const probe = new ScreenContextProbe(() => true, () => {
      const read = new Promise<ScreenContext | null>((resolve) => answers.push(resolve));
      reads.push(read);
      return read;
    }, () => {}, (read) => void stopped.push(read));

    const capture = probe.capture(none)!;
    const window = probe.window(capture)!;
    answers[0]!(screen({ renderedText: "shown" }));
    await capture;
    await Promise.resolve();
    probe.stop(window);
    expect(stopped).toEqual([reads[1]]);
    answers[1]!(screen({ renderedText: "so far" }));
    expect(screenShown(await window)?.renderedText).toBe("so far");

    const early = probe.capture(none)!;
    const earlyWindow = probe.window(early)!;
    probe.stop(earlyWindow);
    expect(stopped).toEqual([reads[1], reads[2]]);
    answers[2]!(screen({ renderedText: "part" }));
    expect(screenShown(await earlyWindow)?.renderedText).toBe("part");
    expect(reads).toHaveLength(3);
  });

  test("release builds keep no capture", async () => {
    const probe = new ScreenContextProbe(() => true, () => Promise.resolve(screen()));
    await probe.capture(none);
    expect(probe.lastContext).toBeNull();
  });
});
