// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { join } from "node:path";
import { app, BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import * as config from "../core/config.js";
import { log } from "../core/log.js";
import { channels, type WindowName, type WindowStates } from "../shared/ipc.js";

/** The renderer page of each window, built by Vite into `dist/renderer`. */
const pages: Record<WindowName | "audio", string> = {
  overlay: "overlay.html",
  settings: "settings.html",
  welcome: "welcome.html",
  contextDebug: "context-debug.html",
  audio: "audio.html",
};

/** Where the built app lives: the main script is `dist/node/main/main.js`. */
const distDirectory = join(__dirname, "../..");

/** Every window the app opens: at most one of each, locked down (context isolation, a sandboxed
 * preload, no navigation, no new windows), each drawing the state the main process pushes. */
export class Windows {
  private readonly open = new Map<WindowName | "audio", BrowserWindow>();

  constructor(private readonly state: <Name extends WindowName>(name: Name) => WindowStates[Name]) {}

  /** The overlay: transparent, never focused, above everything, on every Space, click-through. */
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
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
    }, (window) => {
      window.setAlwaysOnTop(true, "status");
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      window.setIgnoreMouseEvents(true);
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

  showSettings(): void {
    this.present("settings", { ...config.settingsWindowSize, title: "TabMail Voice Settings", resizable: false, minimizable: false, maximizable: false, fullscreenable: false });
  }

  showWelcome(): void {
    this.present("welcome", { ...config.welcomeWindowSize, title: "Welcome to TabMail Voice", resizable: false, minimizable: false, maximizable: false, fullscreenable: false });
  }

  showContextDebug(): void {
    this.present("contextDebug", { ...config.contextDebugWindowSize, title: "Last Screen Context" });
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
      ...options,
      webPreferences: {
        ...options.webPreferences,
        preload: join(distDirectory, "node/preload/preload.js"),
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
