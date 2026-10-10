// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MenuState, UpdateState } from "../../src/core/ui/menuModel.js";
import { type TrayActions, TrayMenu } from "../../src/main/tray.js";

type Item = { label?: string; type?: string; enabled?: boolean; click?: () => void };

/** The menu, icons and tooltip as the tray last got them. */
const tray = vi.hoisted(() => ({ items: [] as Item[], icons: [] as unknown[], toolTip: "", themeChanged: [] as (() => void)[], dark: false }));

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: (items: Item[]) => items },
  nativeImage: {
    // Each image names its file; on Linux its pixels say which one it was (the marked one is fainter).
    createFromPath: (path: string) => ({
      file: path.split(/[\\/]/).at(-1),
      template: false,
      setTemplateImage(template: boolean) { this.template = template; },
      toBitmap: () => Buffer.from([10, 20, 30, path.endsWith("Marked.png") ? 64 : 128]),
      getSize: () => ({ width: 1, height: 1 }),
    }),
    createFromBitmap: (bitmap: Buffer) => ({ bitmap }),
  },
  nativeTheme: { get shouldUseDarkColors() { return tray.dark; }, on(_event: string, listener: () => void) { tray.themeChanged.push(listener); } },
  Tray: class {
    constructor(icon: unknown) { tray.icons.push(icon); }
    setImage(icon: unknown) { tray.icons.push(icon); }
    setToolTip(text: string) { tray.toolTip = text; }
    setContextMenu(items: Item[]) {
      tray.items = items;
    }
  },
}));

const ready: MenuState = { hasConsented: true, isSignedIn: true, microphoneGranted: true, accessibilityTrusted: true, hotkey: "function", debugMode: false, phase: { kind: "idle" }, update: null };

function menu(update: UpdateState | null, state: () => MenuState = () => ({ ...ready, update })) {
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
    installUpdate: action("installUpdate"),
    debug: null,
  };
  const trayMenu = new TrayMenu("/nonexistent", state, actions);
  const labels = tray.items.map((item) => item.label ?? item.type);
  return { trayMenu, labels, item: (label: string) => tray.items.find((item) => item.label === label), clicked };
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
    const { item, clicked } = menu({ kind: "ready", version: "1.2.3", installsOnQuit: true });

    item("Restart to Update to Version 1.2.3")?.click?.();
    expect(clicked).toEqual(["installUpdate"]);
  });

  test("Install installs it where an administrator does; Retry checks again", () => {
    const ready = menu({ kind: "ready", version: "1.2.3", installsOnQuit: false });
    ready.item("Install Version 1.2.3…")?.click?.();
    expect(ready.clicked).toEqual(["installUpdate"]);

    const failed = menu({ kind: "failed", version: "1.2.3", message: "x" });
    failed.item("Retry Update to Version 1.2.3")?.click?.();
    expect(failed.clicked).toEqual(["checkForUpdates"]);
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

function onLinux(desktop: string, run: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  vi.stubEnv("XDG_CURRENT_DESKTOP", desktop);
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    vi.unstubAllEnvs();
  }
}

/** While a permission is missing the icon carries a mark, so the user can see why dictation won't start. */
describe("TrayMenu's permission mark", () => {
  const icon = () => (tray.icons.at(-1) as { file?: string }).file;

  // The macOS icons, whatever the machine running the tests (the Windows and Linux release builds run them too).
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => Object.defineProperty(process, "platform", { value: "darwin", configurable: true }));
  afterEach(() => Object.defineProperty(process, "platform", platform));

  test("a ready app shows the plain icon", () => {
    menu(null);

    expect(icon()).toBe("trayTemplate.png");
    expect(tray.toolTip).toBe("TabMail Voice");
  });

  /** Only a missing permission marks it: signing in and finishing setup have their own menu items. */
  test.each([
    ["signed out", { isSignedIn: false }],
    ["setup unfinished", { hasConsented: false }],
  ])("%s with both permissions granted shows the plain icon", (_name, state) => {
    menu(null, () => ({ ...ready, ...state }));

    expect(icon()).toBe("trayTemplate.png");
    expect(tray.toolTip).toBe("TabMail Voice");
  });

  /** macOS tints a template image for the menu bar; an untinted black dot would vanish in a dark one.
   * The marked file's name doesn't end in "Template", so Electron wouldn't tell on its own. */
  test.each([
    ["plain", ready],
    ["marked", { ...ready, microphoneGranted: false }],
  ])("the %s icon is a template image", (_name, state) => {
    menu(null, () => state);

    expect(tray.icons.at(-1)).toMatchObject({ template: true });
  });

  test.each([
    ["the microphone", { microphoneGranted: false }],
    ["accessibility", { accessibilityTrusted: false }],
  ])("missing %s marks the icon until it is granted", (_name, missing) => {
    let state: MenuState = { ...ready, ...missing };
    const { trayMenu } = menu(null, () => state);
    expect(icon()).toBe("trayTemplateMarked.png");
    expect(tray.toolTip).toBe("TabMail Voice needs a permission");

    state = ready;
    trayMenu.update();
    expect(icon()).toBe("trayTemplate.png");
    expect(tray.toolTip).toBe("TabMail Voice");
  });

  test("an unchanged state leaves the icon alone", () => {
    const { trayMenu } = menu(null, () => ({ ...ready, microphoneGranted: false }));
    const set = tray.icons.length;

    trayMenu.update();
    expect(tray.icons.length).toBe(set);
  });

  test("Linux colours the marked icon for its panel, and again for the new theme, keeping the mark", () => {
    onLinux("KDE", () => {
      tray.themeChanged.length = 0;
      tray.dark = false;
      try {
        menu(null, () => ({ ...ready, accessibilityTrusted: false }));
        // KDE's panel follows the theme: dark text on a light one.
        expect(tray.icons.at(-1)).toEqual({ bitmap: Buffer.from([0, 0, 0, 64]) });

        tray.dark = true;
        expect(tray.themeChanged.length).toBeGreaterThan(0);
        for (const changed of tray.themeChanged) changed();
        expect(tray.icons.at(-1)).toEqual({ bitmap: Buffer.from([64, 64, 64, 64]) });
      } finally {
        tray.dark = false;
      }
    });
  });
});
