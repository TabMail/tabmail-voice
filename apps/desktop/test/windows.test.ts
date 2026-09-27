// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test, vi } from "vitest";
import { Windows } from "../src/main/windows.js";

/** Electron's `BrowserWindow` as far as `Windows` uses it; `destroy()` emits `closed`, as Electron
 * guarantees. */
const electron = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  class FakeWebContents extends EventEmitter {
    setWindowOpenHandler(): void {}
    send(): void {}
  }
  class FakeBrowserWindow extends EventEmitter {
    readonly webContents = new FakeWebContents();
    private destroyed = false;
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
      this.emit("closed");
    }
    close(): void {
      this.destroy();
    }
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { BrowserWindow: FakeBrowserWindow, app: { focus: () => {} } };
});

// Hoisted above the imports by Vitest, so `Windows` gets the fake.
vi.mock("electron", () => electron);

describe("Windows", () => {
  /** A dead audio page is dropped, so the next dictation's command opens a fresh one instead of
   * every dictation failing until a relaunch; only the fresh page may use the microphone. */
  test("a crashed audio page is replaced by the next use", () => {
    const windows = new Windows(() => null as never);
    const crashed = windows.audio();
    expect(windows.audio()).toBe(crashed);

    crashed.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });

    const fresh = windows.audio();
    expect(fresh).not.toBe(crashed);
    expect(crashed.isDestroyed()).toBe(true);
    expect(windows.isAudioWindow(crashed.webContents)).toBe(false);
    expect(windows.isAudioWindow(fresh.webContents)).toBe(true);
  });
});
