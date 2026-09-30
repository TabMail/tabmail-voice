// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../src/core/config.js";
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
    static made: Record<string, unknown>[] = [];
    readonly webContents = new FakeWebContents();
    constructor(options: Record<string, unknown>) {
      super();
      FakeBrowserWindow.made.push(options);
    }
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
    ignoresMouse = false;
    forwardsMouse = false;
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
      this.ignoresMouse = ignore;
      this.forwardsMouse = options?.forward === true;
    }
    setAlwaysOnTop(): void {}
    setVisibleOnAllWorkspaces(): void {}
  }
  return { BrowserWindow: FakeBrowserWindow, app: { focus: () => {} }, nativeTheme: { shouldUseDarkColors: false } };
});

// Hoisted above the imports by Vitest, so `Windows` gets the fake.
vi.mock("electron", () => electron);

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  electron.BrowserWindow.made = [];
  electron.nativeTheme.shouldUseDarkColors = false;
});

/** The options the Settings window is made with on `platform`. */
function settingsWindow(platform: NodeJS.Platform): Record<string, unknown> | undefined {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  new Windows(() => null as never).showSettings();
  return electron.BrowserWindow.made.at(-1);
}

describe("Windows", () => {
  /** On macOS the sidebar shows the frosted material through a clear window, under inset traffic
   * lights; elsewhere nothing draws a material, so the window has the config's own colour for the
   * theme, never a clear one. */
  test("the Settings window is frosted only on macOS", () => {
    expect(settingsWindow("darwin")).toMatchObject({ vibrancy: "sidebar", titleBarStyle: "hiddenInset", backgroundColor: "#00000000", ...config.settingsWindowSize });

    const light = settingsWindow("win32");
    expect(light).toMatchObject({ backgroundColor: config.settingsWindowColour.light });
    expect(light).not.toHaveProperty("vibrancy");
    expect(light).not.toHaveProperty("titleBarStyle");

    electron.nativeTheme.shouldUseDarkColors = true;
    expect(settingsWindow("linux")).toMatchObject({ backgroundColor: config.settingsWindowColour.dark });
  });

  /** The overlay is never focused, so every click on it is a first click: the chat window's close
   * button and links answer only because a first click counts. Until the chat opens it lets clicks
   * through, while the pointer's moves still reach the page, for a bubble to show what it is. */
  test("the overlay takes a first click but is never focused", () => {
    const overlay = new Windows(() => null as never).overlay() as unknown as { ignoresMouse: boolean; forwardsMouse: boolean };

    expect(electron.BrowserWindow.made.at(-1)).toMatchObject({ focusable: false, acceptFirstMouse: true });
    expect(overlay.ignoresMouse).toBe(true);
    expect(overlay.forwardsMouse).toBe(true);
  });

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
