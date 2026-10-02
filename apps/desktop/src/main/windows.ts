// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { join } from "node:path";
import { app, BrowserWindow, type BrowserWindowConstructorOptions, nativeTheme } from "electron";
import * as config from "../core/config.js";
import { log } from "../core/log.js";
import type { Rect } from "../core/ui/overlayGeometry.js";
import { channels, type WindowName, type WindowStates } from "../shared/ipc.js";

/** The renderer page of each window, built by Vite into `dist/renderer`. */
const pages: Record<WindowName | "audio", string> = {
  overlay: "overlay/index.html",
  settings: "settings/index.html",
  welcome: "welcome/index.html",
  contextDebug: "contextDebug/index.html",
  history: "history/index.html",
  audio: "audio/index.html",
};

/** Where the built app lives: the main script is `dist/node/main/index.js`. */
const distDirectory = join(__dirname, "../..");

/** Every window the app opens: at most one of each, locked down (context isolation, a sandboxed
 * preload, no navigation, no new windows), each drawing the state the main process pushes. */
export class Windows {
  private readonly open = new Map<WindowName | "audio", BrowserWindow>();

  constructor(private readonly state: <Name extends WindowName>(name: Name) => WindowStates[Name]) {}

  /** The overlay: transparent, never focused, above everything, on every Space, click-through
   * except while it shows the chat window, whose first click counts (its close button, a link). */
  overlay(): BrowserWindow {
    return this.window("overlay", {
      ...config.overlayCanvasSize,
      type: "panel",
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      acceptFirstMouse: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
    }, (window) => {
      window.setAlwaysOnTop(true, "status");
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      // Click-through, but the pointer's moves still reach the page: a bubble shows what it is on hover.
      window.setIgnoreMouseEvents(true, { forward: true });
    });
  }

  /** The hidden window that owns the microphone (`getUserMedia` needs a renderer). */
  audio(): BrowserWindow {
    return this.window("audio", { show: false, width: 1, height: 1, skipTaskbar: true, webPreferences: { backgroundThrottling: false } }, (window) => {
      // A page whose renderer died stays dead: drop the window, and the next command opens a fresh
      // one (otherwise every dictation after a crash fails until the app is relaunched).
      window.webContents.on("render-process-gone", (_event, details) => {
        log.error(`windows: audio page gone (${details.reason})`);
        window.destroy();
      });
    });
  }

  isAudioWindow(contents: Electron.WebContents): boolean {
    return this.open.get("audio")?.webContents === contents;
  }

  /** Settings: on macOS the title bar gives way to the sidebar, which shows the frosted material
   * behind the window, as System Settings does; elsewhere the window has its own color. */
  showSettings(): void {
    const look: BrowserWindowConstructorOptions =
      process.platform === "darwin"
        ? { titleBarStyle: "hiddenInset", vibrancy: "sidebar", visualEffectState: "followWindow", backgroundColor: "#00000000" }
        : { backgroundColor: nativeTheme.shouldUseDarkColors ? config.settingsWindowColor.dark : config.settingsWindowColor.light };
    this.present("settings", { ...config.settingsWindowSize, ...look, title: "TabMail Voice Settings", resizable: false, minimizable: false, maximizable: false, fullscreenable: false });
  }

  showWelcome(): void {
    this.present("welcome", { ...config.welcomeWindowSize, title: "Welcome to TabMail Voice", resizable: false, minimizable: false, maximizable: false, fullscreenable: false });
  }

  showContextDebug(): void {
    this.present("contextDebug", { ...config.contextDebugWindowSize, title: "Last Screen Context" });
  }

  /** The paste history (ADR-DESK-043) at `bounds`: a small frameless window over every other, on
   * the Space in front, brought forward with the app so Escape reaches it; `onBlur` as it loses
   * focus (the user clicked elsewhere). Made hidden: it shows once its list has measured itself
   * (`fitHistory`), so it never opens at another height. Open already, it moves to `bounds`. */
  showHistory(bounds: Rect, onBlur: () => void): void {
    const look: BrowserWindowConstructorOptions =
      process.platform === "darwin"
        ? { vibrancy: "popover", visualEffectState: "active", backgroundColor: "#00000000" }
        : { backgroundColor: nativeTheme.shouldUseDarkColors ? config.settingsWindowColor.dark : config.settingsWindowColor.light };
    const existing = this.open.get("history");
    if (existing && !existing.isDestroyed()) {
      existing.setBounds(bounds);
      app.focus({ steal: true });
      existing.focus();
      return;
    }
    this.window("history", {
      ...bounds,
      ...look,
      type: "panel",
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
    }, (window) => {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      window.on("blur", onBlur);
    });
  }

  /** The paste history at `bounds`, its list measured: shown, with the focus, the first time. */
  fitHistory(bounds: Rect): void {
    const window = this.open.get("history");
    if (!window || window.isDestroyed()) return;
    window.setBounds(bounds);
    if (window.isVisible()) return;
    app.focus({ steal: true });
    window.show();
  }

  isOpen(name: WindowName): boolean {
    const window = this.open.get(name);
    return window !== undefined && !window.isDestroyed();
  }

  close(name: WindowName): void {
    this.open.get(name)?.close();
  }

  /** Sends `name`'s window its state, if it is open. */
  push(name: WindowName): void {
    const window = this.open.get(name);
    if (window && !window.isDestroyed()) window.webContents.send(channels.state, name, this.state(name));
  }

  /** A menu-bar app isn't active on its own, so its window would open behind the frontmost app:
   * bring the app and the window forward. */
  private present(name: WindowName, options: BrowserWindowConstructorOptions): void {
    const existing = this.open.get(name);
    if (existing && !existing.isDestroyed()) {
      app.focus({ steal: true });
      existing.show();
      existing.focus();
      return;
    }
    const window = this.window(name, { ...options, show: false, useContentSize: true });
    window.once("ready-to-show", () => {
      app.focus({ steal: true });
      window.show();
    });
  }

  private window(name: WindowName | "audio", options: BrowserWindowConstructorOptions, configure?: (window: BrowserWindow) => void): BrowserWindow {
    const existing = this.open.get(name);
    if (existing && !existing.isDestroyed()) return existing;
    const window = new BrowserWindow({
      ...(process.platform === "linux" ? {
        icon: join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"), "icon.png"),
      } : {}),
      ...options,
      webPreferences: {
        ...options.webPreferences,
        preload: join(distDirectory, "node/preload/index.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    configure?.(window);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => {
      if (this.open.get(name) === window) this.open.delete(name);
    });
    this.open.set(name, window);
    void window.loadFile(join(distDirectory, "renderer", pages[name]));
    return window;
  }
}
