// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import { type ScreenContext, ScreenContextProbe } from "../../../src/core/dictation/screenContext.js";

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

    expect(probe.capture([])).toBeNull();
    expect(reads).toBe(0);
  });

  /** The apps the dictation excludes reach the read as given, so the helper never reads one. */
  test("the read is asked with the dictation's excluded apps", async () => {
    const asked: (readonly string[])[] = [];
    const probe = new ScreenContextProbe(() => true, (excludedApps) => {
      asked.push(excludedApps);
      return Promise.resolve(null);
    });

    expect(await probe.capture(["org.example.vault", "org.example.bank"])).toBeNull();
    expect(asked).toEqual([["org.example.vault", "org.example.bank"]]);
  });

  /** A failed or empty read is no context, never an error for the dictation. */
  test("a failed read is no context", async () => {
    const probe = new ScreenContextProbe(() => true, () => Promise.reject(new Error("helper gone")));
    expect(await probe.capture([])).toBeNull();
    expect(await new ScreenContextProbe(() => true, () => Promise.resolve(null)).capture([])).toBeNull();
  });

  /** Debug builds keep the newest capture for the debug window; an older read finishing later
   * does not replace it. */
  test("debug builds keep the latest capture only", async () => {
    configureLog({ isDebugBuild: true, sinks: { error: () => {} } });
    const reads: ((context: ScreenContext) => void)[] = [];
    const probe = new ScreenContextProbe(() => true, () => new Promise((resolve) => reads.push(resolve)));

    const older = probe.capture([]);
    const newer = probe.capture([]);
    reads[1]?.(screen({ appName: "Newer" }));
    await newer;
    reads[0]?.(screen({ appName: "Older" }));

    expect((await older)?.appName).toBe("Older");
    expect(probe.lastContext?.appName).toBe("Newer");
  });

  test("release builds keep no capture", async () => {
    const probe = new ScreenContextProbe(() => true, () => Promise.resolve(screen()));
    await probe.capture([]);
    expect(probe.lastContext).toBeNull();
  });
});
