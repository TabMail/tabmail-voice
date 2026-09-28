// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test, vi } from "vitest";
import type { AudioCapture } from "../src/core/audio.js";
import * as config from "../src/core/config.js";

/** The main process as the app wires it, over stand-ins for Electron, the helpers and the
 * controller: which helper a dictation's microphone runs in, and what a restarted helper does.
 * Nothing reaches the network, the Keychain, the microphone or the desktop. */
const app = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, argument: unknown) => unknown>(),
  listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
  credential: null as string | null,
  refusesDelete: false,
  helpers: new Map<string, { onStart: (() => void) | undefined; requests: { method: string; params: unknown }[]; events: Map<string, (message: Record<string, unknown>) => void> }>(),
  capture: null as AudioCapture | null,
  prewarms: 0,
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
}));
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    getPassword(): string | null {
      return app.credential;
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
vi.mock("../src/core/http.js", () => ({
  liveTransport: async () => {
    throw new Error("no network in tests");
  },
}));
vi.mock("../src/main/fileStore.js", () => ({
  FileStore: class {
    get(key: string) {
      return key === "hasFinishedWelcome" ? true : undefined;
    }
    set() {}
    remove() {}
  },
}));
vi.mock("../src/main/logFile.js", () => ({
  LogFile: class {
    append() {}
    async flush() {}
  },
}));
vi.mock("../src/core/permissions.js", () => ({
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
vi.mock("../src/core/agent/emailClient.js", () => ({
  EmailClient: class {
    static hasTabMail() {
      return false;
    }
    static resolve() {
      return null;
    }
  },
}));
vi.mock("../src/main/helperClient.js", () => ({
  HelperClient: class {
    onStart: (() => void) | undefined;
    readonly requests: { method: string; params: unknown }[] = [];
    readonly events = new Map<string, (message: Record<string, unknown>) => void>();
    constructor(readonly options: { name: string }) {
      app.helpers.set(options.name, this);
    }
    on(event: string, handler: (message: Record<string, unknown>) => void) {
      this.events.set(event, handler);
    }
    start() {}
    stop() {}
    async request(method: string, params?: unknown) {
      this.requests.push({ method, params });
      return { value: null };
    }
  },
}));
vi.mock("../src/core/dictationController.js", () => ({
  DictationController: class {
    constructor(dependencies: { capture: AudioCapture }) {
      app.capture = dependencies.capture;
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
    prewarm() {
      app.prewarms += 1;
    }
  },
}));
vi.mock("../src/main/overlayWindow.js", () => ({
  OverlayWindowController: class {
    update() {}
  },
}));
vi.mock("../src/main/tray.js", () => ({
  TrayMenu: class {
    update() {}
  },
}));
vi.mock("../src/main/windows.js", () => ({
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

/** Launches the main process on `platform`. */
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

async function launch(platform: NodeJS.Platform): Promise<void> {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  vi.resetModules();
  await import("../src/main/main.js");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  app.handlers.clear();
  app.listeners.clear();
  app.helpers.clear();
  app.capture = null;
  app.prewarms = 0;
});

describe("main process wiring", () => {
  /** A `voice-macos` that (re)starts gets the microphone prepared again, ahead of the next
   * dictation, and the activator started. */
  test("a restarted voice-macos prepares the microphone again", async () => {
    await launch("darwin");
    const helper = app.helpers.get("voice-macos");
    const before = app.prewarms;
    helper?.onStart?.();

    expect(app.prewarms).toBe(before + 1);
    expect(helper?.requests.map((request) => request.method)).toContain("startActivator");
  });

  /** On macOS a dictation's microphone runs in `voice-macos`: the capture's start is its
   * `microphoneStart`, for the dictation's session at the recording rate, and its stop the
   * matching `microphoneStop`; the helper's answer and its chunk events reach the dictation. */
  test("on macOS the capture runs in voice-macos", async () => {
    await launch("darwin");
    const helper = app.helpers.get("voice-macos");
    const capture = app.capture;
    expect(capture).not.toBeNull();
    const completions: (Error | null)[] = [];
    const chunks: Float32Array[] = [];

    capture?.start(
      (samples) => chunks.push(samples),
      (error) => completions.push(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const samples = new Float32Array([0.25, -0.5]);
    helper?.events.get("microphoneChunk")?.({ event: "microphoneChunk", session: 1, samples: Buffer.from(samples.buffer).toString("base64") });
    expect(completions).toEqual([null]);
    expect(chunks).toEqual([samples]);
    capture?.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const microphone = helper?.requests.filter((request) => request.method.startsWith("microphone") && request.method !== "microphonePrepare") ?? [];
    expect(microphone).toEqual([
      { method: "microphoneStart", params: { session: 1, sampleRate: config.recordingSampleRate } },
      { method: "microphoneStop", params: { session: 1 } },
    ]);
  });
});
