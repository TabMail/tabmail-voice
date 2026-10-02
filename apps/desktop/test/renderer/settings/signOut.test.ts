// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type AccountModel, sessionToWire } from "../../../src/core/backend/account.js";
import type { VoiceBridge } from "../../../src/shared/ipc.js";
import { Fixtures } from "../../support/stubs.js";

/** The main process, the preload bridge and the Settings page wired as the app wires them, over an
 * in-memory Electron IPC and credential store; every other part of the app is a stand-in. Nothing
 * reaches the network, the real Keychain or the desktop. */
const app = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, argument: unknown) => unknown>(),
  listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
  credential: null as string | null,
  refusesDelete: false,
  account: null as AccountModel | null,
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: () => "/nonexistent",
    getAppPath: () => "/nonexistent",
    getVersion: () => "0.0.0",
    dock: { hide() {} },
    on() {},
    quit() {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
  },
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
  shell: {},
  systemPreferences: {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, argument: unknown) => unknown) => app.handlers.set(channel, handler),
    on() {},
  },
  contextBridge: {
    exposeInMainWorld: (_name: string, bridge: VoiceBridge) => {
      (window as unknown as { voice: VoiceBridge }).voice = bridge;
    },
  },
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) => app.listeners.set(channel, [...(app.listeners.get(channel) ?? []), listener]),
    removeListener: (channel: string, listener: unknown) => app.listeners.set(channel, (app.listeners.get(channel) ?? []).filter((next) => next !== listener)),
    invoke: async (channel: string, argument: unknown) => app.handlers.get(channel)?.({}, argument),
    send() {},
  },
}));
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    getPassword(): string | null {
      return app.credential;
    }
    getSecret(): number[] | null {
      const stored = app.credential;
      if (stored === null) return null;
      return [...(stored.startsWith("binary:") ? Buffer.from(stored.slice(7), "base64") : Buffer.from(stored, "utf16le"))];
    }
    setSecret(value: Uint8Array): void {

      app.credential = `binary:${Buffer.from(value).toString("base64")}`;
    }
    setPassword(value: string): void {
      app.credential = value;
    }
    deletePassword(): boolean {
      if (app.refusesDelete) throw new Error("denied");
      const had = app.credential !== null;
      app.credential = null;
      return had;
    }
  },
}));
vi.mock("../../../src/core/backend/http.js", () => ({
  liveTransport: async () => {
    throw new Error("no network in tests");
  },
}));
vi.mock("../../../src/main/storage/jsonFileStore.js", () => ({
  JSONFileStore: class {
    get(key: string) {
      return key === "hasFinishedWelcome" ? true : undefined;
    }
    set() {}
    remove() {}
  },
}));
vi.mock("../../../src/main/storage/logFile.js", () => ({
  LogFile: class {
    append() {}
    async flush() {}
  },
}));
vi.mock("../../../src/core/onboarding/permissions.js", () => ({
  PermissionsModel: class {
    microphone = "granted";
    accessibilityTrusted = true;
    observe() {
      return () => {};
    }
    startPollingAccessibility() {}
    refresh() {}
  },
}));
vi.mock("../../../src/core/agent/connectors/thunderbird/emailClient.js", () => ({
  EmailClient: class {
    static hasTabMail() {
      return false;
    }
    static resolve() {
      return null;
    }
  },
}));
vi.mock("../../../src/main/native/helperClient.js", () => ({
  HelperClient: class {
    on() {}
    start() {}
    stop() {}
    async request() {
      return { value: null };
    }
  },
}));
vi.mock("../../../src/core/dictation/controller.js", () => ({
  DictationController: class {
    constructor(dependencies: { account: AccountModel }) {
      app.account = dependencies.account;
    }
    phase = { kind: "idle" };
    mode = "dictation";
    tools = [];
    level = 0;
    language = null;
    tip = null;
    emailAppPath = null;
    observe() {
      return () => {};
    }
    prewarm() {}
  },
}));
vi.mock("../../../src/main/overlayWindow.js", () => ({
  OverlayWindowController: class {
    update() {}
  },
}));
vi.mock("../../../src/main/tray.js", () => ({
  TrayMenu: class {
    update() {}
  },
}));
vi.mock("../../../src/main/windows.js", () => ({
  Windows: class {
    constructor(readonly state: (name: string) => unknown) {}
    overlay() {
      return {};
    }
    push(name: string) {
      for (const listener of app.listeners.get("voice:state") ?? []) listener({}, name, this.state(name));
    }
  },
}));

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** Launches the app signed in, then opens Settings. */
async function signedInSettings(): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  app.credential = JSON.stringify(sessionToWire(Fixtures.session()));
  vi.resetModules();
  await import("../../../src/main/index.js");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(app.account?.isSignedIn).toBe(true);
  await import("../../../src/preload/index.js");
  await act(async () => {
    await import("../../../src/renderer/settings/index.js");
  });
}

afterEach(() => {
  app.handlers.clear();
  app.listeners.clear();
  app.refusesDelete = false;
  document.body.innerHTML = "";
});

describe("Sign Out, end to end", () => {
  /** The credential store refuses the delete: the app is signed out, the saved sign-in is still
   * stored, and Settings says so in the app's words (owner, 2026-09-27: sign out, and say so). */
  test("a refused delete signs out and Settings says the sign-in was kept", async () => {
    await signedInSettings();
    app.refusesDelete = true;
    const stored = app.credential;

    await act(async () => button("Sign Out").click());

    expect(app.account?.isSignedIn).toBe(false);
    expect(await app.account?.validToken()).toBeNull();
    expect(app.credential).toBe(stored);
    const { savedSignInKeptMessage } = await import("../../../src/main/storage/keychainSessionStore.js");
    expect(document.querySelector(".error")?.textContent).toBe(savedSignInKeptMessage);
    expect(button("Email Me a Code")).toBeDefined();
  });

  test("a sign-out the store carries out signs out, removes the sign-in and says nothing more", async () => {
    await signedInSettings();

    await act(async () => button("Sign Out").click());

    expect(app.account?.isSignedIn).toBe(false);
    expect(app.credential).toBeNull();
    expect(document.querySelector(".error")).toBeNull();
    expect(button("Email Me a Code")).toBeDefined();
  });
});
