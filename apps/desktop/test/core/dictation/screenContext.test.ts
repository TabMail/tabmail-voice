// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import type { ScreenExclusions } from "../../../src/core/dictation/excludedSites.js";
import { isScreenHidden, type ScreenContext, ScreenContextProbe, screenShown } from "../../../src/core/dictation/screenContext.js";

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

  test("release builds keep no capture", async () => {
    const probe = new ScreenContextProbe(() => true, () => Promise.resolve(screen()));
    await probe.capture(none);
    expect(probe.lastContext).toBeNull();
  });
});
