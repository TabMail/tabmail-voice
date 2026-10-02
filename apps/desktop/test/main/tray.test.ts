// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test, vi } from "vitest";
import type { MenuState, UpdateState } from "../../src/core/ui/menuModel.js";
import { type TrayActions, TrayMenu } from "../../src/main/tray.js";

type Item = { label?: string; type?: string; enabled?: boolean; click?: () => void };

/** The menu as the tray last got it. */
const tray = vi.hoisted(() => ({ items: [] as Item[], icons: [] as unknown[] }));

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: (items: Item[]) => items },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {}, toBitmap: () => Buffer.from([10, 20, 30, 128]), getSize: () => ({ width: 1, height: 1 }) }), createFromBitmap: (bitmap: Buffer) => ({ bitmap }) },
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  Tray: class {
    constructor(icon: unknown) { tray.icons.push(icon); }
    setImage(icon: unknown) { tray.icons.push(icon); }
    setToolTip() {}
    setContextMenu(items: Item[]) {
      tray.items = items;
    }
  },
}));

const ready: MenuState = { hasConsented: true, isSignedIn: true, microphoneGranted: true, accessibilityTrusted: true, hotkey: "function", debugMode: false, phase: { kind: "idle" }, update: null };

function menu(update: UpdateState | null) {
  const clicked: string[] = [];
  const action = (name: string) => () => void clicked.push(name);
  const actions: TrayActions = {
    showWelcome: action("showWelcome"),
    showSettings: action("showSettings"),
    requestMicrophone: action("requestMicrophone"),
    requestAccessibility: action("requestAccessibility"),
    toggleDictation: action("toggleDictation"),
    quit: action("quit"),
    checkForUpdates: action("checkForUpdates"),
    restartToUpdate: action("restartToUpdate"),
    debug: null,
  };
  new TrayMenu("/nonexistent", () => ({ ...ready, update }), actions);
  const labels = tray.items.map((item) => item.label ?? item.type);
  return { labels, item: (label: string) => tray.items.find((item) => item.label === label), clicked };
}

/** The menu's update item (ADR-DESK-041): packaged builds only, just above Quit, and it does what it
 * says. */
describe("TrayMenu's update item", () => {
  test("a debug build has none", () => {
    const { labels } = menu(null);

    expect(labels.slice(-2)).toEqual(["Settings…", "Quit TabMail Voice"]);
  });

  test("Check for Updates… sits just above Quit and looks for one", () => {
    const { labels, item, clicked } = menu({ kind: "idle" });

    expect(labels.slice(-3)).toEqual(["Settings…", "Check for Updates…", "Quit TabMail Voice"]);
    expect(item("Check for Updates…")?.enabled).toBe(true);
    item("Check for Updates…")?.click?.();
    expect(clicked).toEqual(["checkForUpdates"]);
  });

  test("Restart to Update restarts into the downloaded version", () => {
    const { item, clicked } = menu({ kind: "ready", version: "1.2.3" });

    item("Restart to Update to Version 1.2.3")?.click?.();
    expect(clicked).toEqual(["restartToUpdate"]);
  });

  test("a download under way can't be clicked", () => {
    const { item } = menu({ kind: "downloading", version: "1.2.3" });

    expect(item("Downloading Version 1.2.3…")?.enabled).toBe(false);
  });
});


test.each([
  ["ubuntu:GNOME", [128, 128, 128, 128]],
  ["KDE", [0, 0, 0, 128]],
])("%s uses the panel-appropriate glyph with a light application theme", (desktop, pixels) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  vi.stubEnv("XDG_CURRENT_DESKTOP", desktop);
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    menu(null);
    expect(tray.icons.at(-1)).toEqual({ bitmap: Buffer.from(pixels) });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    vi.unstubAllEnvs();
  }
});
