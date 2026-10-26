// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../../src/core/config.js";
import { palette } from "../../src/core/palette.js";
import { Windows } from "../../src/main/windows.js";

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
    static instances: FakeBrowserWindow[] = [];
    readonly webContents = new FakeWebContents();
    /** What the window was asked: its bounds set, `focus`, `show`. */
    readonly calls: unknown[] = [];
    /** Every window's shows, in order, across windows. */
    static shown: FakeBrowserWindow[] = [];
    constructor(options: Record<string, unknown>) {
      super();
      FakeBrowserWindow.made.push(options);
      FakeBrowserWindow.instances.push(this);
    }
    setBounds(bounds: unknown): void {
      this.calls.push(bounds);
    }
    focus(): void {
      this.calls.push("focus");
    }
    isVisible(): boolean {
      return this.calls.includes("show");
    }
    show(): void {
      this.calls.push("show");
      FakeBrowserWindow.shown.push(this);
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
  const focuses: unknown[] = [];
  /** The Dock's calls, in order ("show", "hide"); `show()` resolves when the test says the icon is
   * shown. As Electron's, a hide within `refusesHideFor` of the last show does nothing, so `visible`
   * says whether the icon is there. */
  const dock = {
    calls: [] as string[],
    shown: [] as (() => void)[],
    visible: false,
    lastShow: -Infinity,
    refusesHideFor: 1_000,
    show(): Promise<void> {
      dock.calls.push("show");
      dock.visible = true;
      dock.lastShow = Date.now();
      return new Promise((resolve) => dock.shown.push(resolve));
    },
    hide(): void {
      dock.calls.push("hide");
      if (Date.now() - dock.lastShow >= dock.refusesHideFor) dock.visible = false;
    },
  };
  return { BrowserWindow: FakeBrowserWindow, app: { isPackaged: false, getAppPath: () => "/voice", focus: (options: unknown) => focuses.push(options), focuses, dock }, nativeTheme: { shouldUseDarkColors: false } };
});

// Hoisted above the imports by Vitest, so `Windows` gets the fake.
vi.mock("electron", () => electron);

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");

afterEach(() => {
  vi.useRealTimers();
  electron.app.dock.calls = [];
  electron.app.dock.shown = [];
  electron.app.dock.visible = false;
  electron.app.dock.lastShow = -Infinity;
  electron.BrowserWindow.shown = [];
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  electron.BrowserWindow.made = [];
  electron.BrowserWindow.instances = [];
  electron.app.focuses.length = 0;
  electron.app.isPackaged = false;
  if (resourcesDescriptor) Object.defineProperty(process, "resourcesPath", resourcesDescriptor);
  else Reflect.deleteProperty(process, "resourcesPath");
  electron.nativeTheme.shouldUseDarkColors = false;
});

/** The options the Settings window is made with on `platform`. */
function settingsWindow(platform: NodeJS.Platform): Record<string, unknown> | undefined {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  new Windows(() => null as never).showSettings();
  return electron.BrowserWindow.made.at(-1);
}

describe("Windows", () => {
  test("Linux Settings supplies the application icon to its actual window", () => {
    expect(settingsWindow("linux")?.icon).toBe(join("/voice", "resources", "icon.png"));
    expect(settingsWindow("darwin")?.icon).toBeUndefined();
  });

  test("packaged Linux Settings uses the icon shipped outside the app archive", () => {
    electron.app.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", { value: "/opt/TabMail Voice/resources", configurable: true });
    expect(settingsWindow("linux")?.icon).toBe(join("/opt/TabMail Voice/resources", "icon.png"));
  });

  /** The paste history (ADR-DESK-043): a frameless panel over every other window, shown with the
   * focus (the list takes clicks and Escape) only once its list has measured itself, at that height,
   * never first at another; closed by the caller when it loses it; a second triple tap moves the open
   * one to the new place and focuses it, rather than opening another. */
  test("the paste history shows focused once measured, and a second opening moves it", () => {
    const windows = new Windows(() => null as never);
    let blurs = 0;
    const first = { x: 10, y: 20, width: config.pasteHistoryWindowWidth, height: 200 };
    windows.showHistory(first, () => (blurs += 1));
    // Transparent on every platform, without the system's shadow: its page draws the glass card and its glow.
    expect(electron.BrowserWindow.made).toEqual([expect.objectContaining({ ...first, type: "panel", frame: false, alwaysOnTop: true, show: false, transparent: true, hasShadow: false })]);
    const window = electron.BrowserWindow.instances[0];
    if (!window) throw new Error("no window");
    expect(window.calls).toEqual([]);
    window.emit("ready-to-show");
    expect(window.calls).toEqual([]);
    expect(electron.app.focuses).toEqual([]);
    const measured = { ...first, height: 120 };
    windows.fitHistory(measured);
    expect(window.calls).toEqual([measured, "show"]);
    expect(electron.app.focuses).toEqual([{ steal: true }]);
    window.emit("blur");
    expect(blurs).toBe(1);

    const second = { ...first, x: 300 };
    windows.showHistory(second, () => (blurs += 1));
    expect(electron.BrowserWindow.made).toHaveLength(1);
    expect(window.calls.slice(2)).toEqual([second, "focus"]);
    expect(electron.app.focuses).toHaveLength(2);

    // Measured again while shown: resized, not shown again.
    windows.fitHistory({ ...second, height: 90 });
    expect(window.calls.slice(4)).toEqual([{ ...second, height: 90 }]);
    expect(electron.app.focuses).toHaveLength(2);
  });

  /** On macOS the sidebar shows the frosted material through a clear window, under inset traffic
   * lights; elsewhere nothing draws a material, so the window has the config's own color for the
   * theme, never a clear one. */
  test("the Settings window is frosted only on macOS", () => {
    expect(settingsWindow("darwin")).toMatchObject({ vibrancy: "sidebar", titleBarStyle: "hiddenInset", backgroundColor: "#00000000", ...config.settingsWindowSize });

    const light = settingsWindow("win32");
    expect(light).toMatchObject({ backgroundColor: palette.light.window });
    expect(light).not.toHaveProperty("vibrancy");
    expect(light).not.toHaveProperty("titleBarStyle");

    electron.nativeTheme.shouldUseDarkColors = true;
    expect(settingsWindow("linux")).toMatchObject({ backgroundColor: palette.dark.window });
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
  /** On macOS the app is in the Dock while one of its own windows is open (ADR-DESK-065): the icon
   * shows as the window opens, and the window comes forward only once it has, since showing the icon
   * moves the focus. With the last such window closed it leaves the Dock, no sooner than
   * `dockHideAfterShowDelay` after it showed (Electron ignores an earlier hide). */
  test("on macOS the app is in the Dock while Settings is open", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const windows = new Windows(() => null as never);
    windows.showSettings();
    expect(electron.app.dock.calls).toEqual(["show"]);
    const settings = electron.BrowserWindow.instances[0];
    if (!settings) throw new Error("no window");
    settings.emit("ready-to-show");
    await Promise.resolve();
    expect(settings.calls).toEqual([]);
    expect(electron.app.focuses).toEqual([]);
    electron.app.dock.shown[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.calls).toEqual(["show"]);
    expect(electron.app.focuses).toEqual([{ steal: true }]);

    // Opened again while open: brought forward, the icon not shown twice.
    windows.showSettings();
    await vi.advanceTimersByTimeAsync(0);
    expect(electron.app.dock.calls).toEqual(["show"]);
    expect(settings.calls).toEqual(["show", "show", "focus"]);

    // Closed at once: the hide waits out the time since the icon showed, then the icon goes.
    windows.close("settings");
    await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay - 1);
    expect(electron.app.dock.calls).toEqual(["show"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(electron.app.dock.calls).toEqual(["show", "hide"]);
    expect(electron.app.dock.visible).toBe(false);

    // Long after, a close hides it at once; a fresh opening shows it again.
    windows.showWelcome();
    electron.app.dock.shown[1]?.();
    await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay * 2);
    windows.close("welcome");
    await vi.advanceTimersByTimeAsync(0);
    expect(electron.app.dock.calls).toEqual(["show", "hide", "show", "hide"]);
    expect(electron.app.dock.visible).toBe(false);
  });

  /** The icon stays while any of the app's windows is open, and a window opened while a hide waits
   * keeps it, with no second show (which would leave two icons). */
  test("the Dock icon stays while another of the app's windows is open, or opens before the hide", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const windows = new Windows(() => null as never);
    windows.showSettings();
    windows.showWelcome();
    windows.showContextDebug();
    electron.app.dock.shown[0]?.();
    expect(electron.app.dock.calls).toEqual(["show"]);
    windows.close("settings");
    windows.close("welcome");
    await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay * 2);
    expect(electron.app.dock.calls).toEqual(["show"]);

    windows.close("contextDebug");
    await vi.advanceTimersByTimeAsync(0);
    expect(electron.app.dock.calls).toEqual(["show", "hide"]);

    windows.showSettings();
    electron.app.dock.shown[1]?.();
    windows.close("settings");
    await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay / 2);
    windows.showSettings();
    await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay * 2);
    expect(electron.app.dock.calls).toEqual(["show", "hide", "show"]);
    expect(electron.app.dock.visible).toBe(true);

    // The hide it cancelled doesn't stop the next one: closed again, the icon goes.
    windows.close("settings");
    await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay * 2);
    expect(electron.app.dock.calls).toEqual(["show", "hide", "show", "hide"]);
    expect(electron.app.dock.visible).toBe(false);
  });

  /** Windows asked for while the icon is still showing come forward once it has, in the order they
   * were asked: the last one asked for ends in front. */
  test("windows asked for while the Dock icon shows come forward in the order asked", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const windows = new Windows(() => null as never);
    windows.showSettings();
    const settings = electron.BrowserWindow.instances[0];
    settings?.emit("ready-to-show");
    windows.showWelcome();
    const welcome = electron.BrowserWindow.instances[1];
    welcome?.emit("ready-to-show");
    windows.showSettings();
    await vi.advanceTimersByTimeAsync(0);
    expect(electron.BrowserWindow.shown).toEqual([]);
    electron.app.dock.shown[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(electron.app.dock.calls).toEqual(["show"]);
    expect(electron.BrowserWindow.shown).toEqual([settings, welcome, settings]);
    expect(settings?.calls.at(-1)).toBe("focus");
  });

  /** A window closed while the icon is still showing never comes forward, and with it the last of
   * the app's windows, the icon leaves; a window asked for afterwards shows as usual. */
  test("a window closed while the Dock icon shows never comes forward", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const windows = new Windows(() => null as never);
    windows.showSettings();
    const settings = electron.BrowserWindow.instances[0];
    settings?.emit("ready-to-show");
    windows.close("settings");
    electron.app.dock.shown[0]?.();
    await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay * 2);
    expect(settings?.calls).toEqual([]);
    expect(electron.app.focuses).toEqual([]);
    expect(windows.isOpen("settings")).toBe(false);
    expect(electron.app.dock.visible).toBe(false);

    windows.showWelcome();
    const welcome = electron.BrowserWindow.instances[1];
    welcome?.emit("ready-to-show");
    electron.app.dock.shown[1]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(welcome?.isVisible()).toBe(true);
    expect(electron.app.dock.visible).toBe(true);
  });

  /** Asked for again while the icon still shows, then closed, an open window doesn't come forward
   * either. */
  test("an open window asked for again, then closed while the Dock icon shows, never comes forward", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const windows = new Windows(() => null as never);
    windows.showSettings();
    const settings = electron.BrowserWindow.instances[0];
    settings?.emit("ready-to-show");
    windows.showSettings();
    expect(electron.BrowserWindow.instances).toHaveLength(1);
    windows.close("settings");
    expect(settings?.isDestroyed()).toBe(true);
    electron.app.dock.shown[0]?.();
    await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay * 2);
    expect(settings?.calls).toEqual([]);
    expect(electron.app.focuses).toEqual([]);
    expect(windows.isOpen("settings")).toBe(false);
    expect(electron.app.dock.visible).toBe(false);

    windows.showWelcome();
    const welcome = electron.BrowserWindow.instances[1];
    welcome?.emit("ready-to-show");
    electron.app.dock.shown[1]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(welcome?.isVisible()).toBe(true);
    expect(electron.app.dock.visible).toBe(true);
  });

  const presented = {
    settings: (windows: Windows) => windows.showSettings(),
    welcome: (windows: Windows) => windows.showWelcome(),
    contextDebug: (windows: Windows) => windows.showContextDebug(),
  } as const;
  type Presented = keyof typeof presented;

  /** Each of the app's own windows shows, whether it is ready before or after the icon, and puts the
   * app in the Dock on macOS only; closed, the icon leaves. */
  test.each((["darwin", "win32", "linux"] as const).flatMap((platform) =>
    (Object.keys(presented) as Presented[]).flatMap((name) => [true, false].map((readyFirst) => ({ platform, name, readyFirst })))),
  )("$name shows on $platform, ready before the icon: $readyFirst", async ({ platform, name, readyFirst }) => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    const windows = new Windows(() => null as never);
    presented[name](windows);
    const window = electron.BrowserWindow.instances[0];
    if (readyFirst) window?.emit("ready-to-show");
    electron.app.dock.shown[0]?.();
    if (!readyFirst) window?.emit("ready-to-show");
    await vi.advanceTimersByTimeAsync(0);
    expect(window?.isVisible()).toBe(true);
    expect(windows.isOpen(name)).toBe(true);
    expect(electron.app.dock.visible).toBe(platform === "darwin");
    windows.close(name);
    await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay * 2);
    expect(windows.isOpen(name)).toBe(false);
    expect(electron.app.dock.visible).toBe(false);
  });

  /** Whatever order the app's windows close in, the icon stays until the last one has. */
  const orders = (names: Presented[]): Presented[][] =>
    names.length <= 1 ? [names] : names.flatMap((name) => orders(names.filter((other) => other !== name)).map((rest) => [name, ...rest]));
  test.each(orders(Object.keys(presented) as Presented[]))("the Dock icon stays until the last window closes: %s, %s, %s", async (...order) => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const windows = new Windows(() => null as never);
    for (const name of order) presented[name](windows);
    electron.app.dock.shown[0]?.();
    for (const window of electron.BrowserWindow.instances) window.emit("ready-to-show");
    await vi.advanceTimersByTimeAsync(0);
    expect(electron.BrowserWindow.instances.every((window) => window.isVisible())).toBe(true);
    for (const [index, name] of order.entries()) {
      windows.close(name);
      await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay * 2);
      expect(electron.app.dock.visible).toBe(index === order.length - 1 ? false : true);
    }
    expect(electron.app.dock.calls).toEqual(["show", "hide"]);
  });

  /** The overlay and the paste history float over other apps: they never put the app in the Dock,
   * and the Dock is never touched off macOS, where Settings already shows in the taskbar. */
  test("only the Mac app's own windows put it in the Dock", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const mac = new Windows(() => null as never);
    mac.overlay();
    mac.showHistory({ x: 0, y: 0, width: config.pasteHistoryWindowWidth, height: 100 }, () => {});
    expect(electron.app.dock.calls).toEqual([]);

    for (const platform of ["win32", "linux"] as const) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const windows = new Windows(() => null as never);
      windows.showSettings();
      const settings = electron.BrowserWindow.instances.at(-1);
      settings?.emit("ready-to-show");
      await vi.advanceTimersByTimeAsync(0);
      expect(settings?.calls).toEqual(["show"]);
      windows.close("settings");
      await vi.advanceTimersByTimeAsync(config.dockHideAfterShowDelay);
    }
    expect(electron.app.dock.calls).toEqual([]);
  });
});
