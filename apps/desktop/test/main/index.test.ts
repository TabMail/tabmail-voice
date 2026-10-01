// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { connectorIDs } from "../../src/core/agent/connectors/index.js";
import { mailtoURL } from "../../src/core/agent/connectors/email.js";
import type { AudioCapture } from "../../src/core/audio/recorder.js";
import * as config from "../../src/core/config.js";
import { channels } from "../../src/shared/ipc.js";
import { eventually } from "../support/stubs.js";

/** The signal a tool runs with: a request never canceled. */
const signal = new AbortController().signal;

/** The main process as the app wires it, over stand-ins for Electron, the helpers and the
 * controller: which helper a dictation's microphone runs in, and what a restarted helper does.
 * Nothing reaches the network, the Keychain, the microphone or the desktop. */
const app = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, argument: unknown) => unknown>(),
  listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
  credential: null as string | null,
  refusesDelete: false,
  helpers: new Map<string, { onStart: (() => void) | undefined; onExit: (() => void) | undefined; requests: { method: string; params: unknown; signal?: AbortSignal }[]; events: Map<string, (message: Record<string, unknown>) => void>; hold: boolean; unanswered: { method: string; params: unknown; answer: (error?: Error) => void }[]; replies: Map<string, unknown> }>(),
  capture: null as AudioCapture | null,
  paste: null as ((text: string, signal: AbortSignal) => Promise<void>) | null,
  copy: null as ((text: string) => void) | null,
  corrections: undefined as { watch(pid: number, pasted: string): void; stop(): void } | undefined,
  prewarms: 0,
  /** The paste history the controller was given, what went on the clipboard, the history window's
   * openings, moves and closings, and each time the app was hidden. */
  history: null as { add(text: string): void; entries: readonly { id: number; text: string }[] } | null,
  clipboard: [] as string[],
  /** The clipboard refuses the next write. */
  clipboardFails: false,
  historyWindow: [] as string[],
  hides: 0,
  /** The windows other than the overlay that are open. */
  openWindows: [] as string[],
  /** What the history window does when it loses the focus. */
  historyBlur: null as (() => void) | null,
  audioCommands: [] as unknown[],
  overlay: null as { opensUpward: boolean; bubblesFitUnder: boolean; chatPlacement: object | null; onPlace: (() => void) | undefined; updates: [string, boolean][]; heights: number[] } | null,
  controller: null as { connectors: string[]; recentBubbles: string[]; runningConnectors: string[]; chat: object | null; onChatChange: ((isOpen: boolean) => void) | undefined; onPhaseChange: ((phase: { kind: string }) => void) | undefined; onNothingListening: (() => void) | undefined; onShowHistory: (() => void) | undefined; calls: string[] } | null,
  stored: new Map<string, unknown>(),
  opened: [] as string[],
  openFailure: null as Error | null,
  connectorTools: [] as { name: string; connector: string; run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> }[],
  scripts: [] as { source: string; args: readonly string[] }[],
  /** `app.getPath("appData")`, where VS Code keeps its settings; null for none. */
  appData: null as string | null,
  /** The full name `voice-macos` gives for the account; null for a reply without one. */
  fullName: null as string | null,
  /** The tray menu's actions and state, as the app gives them. */
  trayActions: null as { showWelcome: () => void; checkForUpdates: () => void; restartToUpdate: () => void } | null,
  trayState: null as (() => { update: unknown }) | null,
  /** A packaged build, which updates itself (ADR-DESK-041); a debug build otherwise. */
  packaged: false,
  /** `app.getVersion()`. */
  version: "0.0.0",
  /** `electron-updater`'s `autoUpdater` as the app last got it. */
  autoUpdater: null as (import("node:events").EventEmitter & { autoDownload: boolean; autoInstallOnAppQuit: boolean; logger: unknown; requestHeaders: Record<string, string> | null; checks: number; installs: number }) | null,
  /** Electron's own `autoUpdater` (Squirrel.Mac) as the app last got it. */
  squirrel: null as import("node:events").EventEmitter | null,
  /** How often the app refreshed its tray menu. */
  trayUpdates: 0,
  /** The message boxes shown, and the button each is answered with. */
  dialogs: [] as Record<string, unknown>[],
  dialogResponse: 1,
  /** The open dialogs shown, and what the user picks in the next one (null: canceled). */
  openDialogs: [] as Record<string, unknown>[],
  pickedPath: null as string | null,
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    // A fresh one for each test's launch: the mocked module outlives `vi.resetModules`.
    get autoUpdater() {
      app.squirrel ??= new EventEmitter();
      return app.squirrel;
    },
    app: {
      get isPackaged() {
        return app.packaged;
      },
      focus() {},
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      getPath: (name: string) => (name === "appData" && app.appData !== null ? app.appData : "/nonexistent"),
      getAppPath: () => "/nonexistent",
      getVersion: () => app.version,
      dock: { hide() {} },
      on() {},
      quit() {},
      getLoginItemSettings: () => ({ openAtLogin: false }),
      hide: () => {
        app.hides += 1;
      },
    },
    clipboard: {
      writeText: async (text: string) => {
        if (app.clipboardFails) throw new Error("the clipboard is busy");
        app.clipboard.push(text);
      },
    },
    screen: { getCursorScreenPoint: () => ({ x: 100, y: 100 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    shell: {
      openExternal: async (url: string) => {
        if (app.openFailure) throw app.openFailure;
        app.opened.push(url);
      },
    },
    systemPreferences: {},
    dialog: {
      showMessageBox: async (options: Record<string, unknown>) => {
        app.dialogs.push(options);
        return { response: app.dialogResponse };
      },
      showOpenDialog: async (options: Record<string, unknown>) => {
        app.openDialogs.push(options);
        return app.pickedPath === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [app.pickedPath] };
      },
    },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, argument: unknown) => unknown) => app.handlers.set(channel, handler),
      on() {},
    },
  };
});
vi.mock("electron-updater", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeAutoUpdater extends EventEmitter {
    autoDownload = false;
    autoInstallOnAppQuit = false;
    logger: unknown = "the console";
    requestHeaders: Record<string, string> | null = null;
    checks = 0;
    installs = 0;
    checkForUpdates() {
      this.checks += 1;
      return new Promise(() => {});
    }
    quitAndInstall() {
      this.installs += 1;
    }
  }
  // A fresh one for each test's launch: the mocked module outlives `vi.resetModules`.
  return {
    get autoUpdater() {
      app.autoUpdater ??= new FakeAutoUpdater();
      return app.autoUpdater;
    },
  };
});
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
vi.mock("../../src/core/backend/http.js", () => ({
  liveTransport: async () => {
    throw new Error("no network in tests");
  },
}));
vi.mock("../../src/main/storage/jsonFileStore.js", () => ({
  JSONFileStore: class {
    get(key: string) {
      return key === "hasFinishedWelcome" ? true : app.stored.get(key);
    }
    set(key: string, value: unknown) {
      app.stored.set(key, value);
    }
    remove(key: string) {
      app.stored.delete(key);
    }
  },
}));
vi.mock("../../src/main/native/osascript.js", () => ({
  osascript: {
    run: async (source: string, args: readonly string[]) => {
      app.scripts.push({ source, args });
      return "";
    },
  },
}));
vi.mock("../../src/main/storage/logFile.js", () => ({
  LogFile: class {
    append() {}
    async flush() {}
  },
}));
vi.mock("../../src/core/onboarding/permissions.js", () => ({
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
vi.mock("../../src/core/agent/connectors/thunderbird/emailClient.js", () => ({
  EmailClient: class {
    static hasTabMail() {
      return false;
    }
    static resolve() {
      return null;
    }
  },
}));
vi.mock("../../src/main/native/helperClient.js", () => ({
  HelperClient: class {
    onStart: (() => void) | undefined;
    onExit: (() => void) | undefined;
    readonly requests: { method: string; params: unknown; signal?: AbortSignal }[] = [];
    readonly events = new Map<string, (message: Record<string, unknown>) => void>();
    constructor(readonly options: { name: string }) {
      app.helpers.set(options.name, this);
    }
    on(event: string, handler: (message: Record<string, unknown>) => void) {
      this.events.set(event, handler);
    }
    // As the real client: `onStart` runs as it starts, even with no executable to spawn.
    start() {
      this.onStart?.();
    }
    stop() {}
    /** While set, a request waits until the test answers it, as a helper still applying it. */
    hold = false;
    readonly unanswered: { method: string; params: unknown; answer: (error?: Error) => void }[] = [];
    /** The helper's answer to a method, where the test gives one. */
    readonly replies = new Map<string, unknown>();
    async request(method: string, params?: unknown, _timeout?: number, signal?: AbortSignal) {
      this.requests.push({ method, params, ...(signal && { signal }) });
      if (this.hold) await new Promise<void>((resolve, reject) => this.unanswered.push({ method, params, answer: (error) => (error ? reject(error) : resolve()) }));
      if (method === "fullUserName" && app.fullName !== null) return { name: app.fullName };
      return this.replies.has(method) ? this.replies.get(method) : { value: null, events: [], contacts: [], items: [] };
    }
  },
}));
vi.mock("../../src/core/dictation/controller.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/dictation/controller.js")>()),
  DictationController: class {
    constructor(dependencies: { capture: AudioCapture; copy: (text: string) => void; paste: (text: string, signal: AbortSignal) => Promise<void>; history: NonNullable<typeof app.history>; connectorTools: typeof app.connectorTools; corrections?: typeof app.corrections }) {
      app.capture = dependencies.capture;
      app.history = dependencies.history;
      app.corrections = dependencies.corrections;
      app.connectorTools = dependencies.connectorTools;
      app.paste = dependencies.paste;
      app.copy = dependencies.copy;
      app.controller = this;
    }
    chat: object | null = null;
    onChatChange: ((isOpen: boolean) => void) | undefined;
    onPhaseChange: ((phase: { kind: string }) => void) | undefined;
    onNothingListening: (() => void) | undefined;
    onShowHistory: (() => void) | undefined;
    readonly calls: string[] = [];
    keepChatOpen() {
      this.calls.push("keepChatOpen");
    }
    closeChat() {
      this.calls.push("closeChat");
    }
    answerConfirmation(confirmed: boolean) {
      this.calls.push(`answerConfirmation ${confirmed}`);
    }
    phase = { kind: "idle" };
    mode = "dictation";
    tools = [];
    connectors: string[] = [];
    recentBubbles: string[] = [];
    runningConnectors: string[] = [];
    level = 0;
    language = null;
    tip = null;
    settings = { hotkey: "function" };
    emailAppPath = null;
    observe() {
      return () => {};
    }
    prewarm() {
      app.prewarms += 1;
    }
  },
}));
vi.mock("../../src/main/overlayWindow.js", () => ({
  OverlayWindowController: class {
    opensUpward = false;
    bubblesFitUnder = true;
    chatPlacement: object | null = null;
    pillPlace = { pill: { x: 700, y: 600 }, workArea: { x: 0, y: 25, width: 1440, height: 875 }, bubblesUnder: true };
    onPlace: (() => void) | undefined;
    readonly updates: [string, boolean][] = [];
    readonly heights: number[] = [];
    constructor() {
      app.overlay = this;
    }
    update(phase: { kind: string }, chatOpen = false) {
      this.updates.push([phase.kind, chatOpen]);
    }
    fitChat(height: number) {
      this.heights.push(height);
    }
  },
}));
vi.mock("../../src/main/tray.js", () => ({
  TrayMenu: class {
    constructor(_resources: string, state: () => { update: unknown }, actions: { showWelcome: () => void; checkForUpdates: () => void; restartToUpdate: () => void }) {
      app.trayActions = actions;
      app.trayState = state;
    }
    update() {
      app.trayUpdates += 1;
    }
  },
}));
vi.mock("../../src/main/windows.js", () => ({
  Windows: class {
    constructor(readonly state: (name: string) => unknown) {}
    overlay() {
      return {};
    }
    audio() {
      return { webContents: { isLoading: () => false, send: (_channel: string, command: unknown) => app.audioCommands.push(command) } };
    }
    push(name: string) {
      for (const listener of app.listeners.get("voice:state") ?? []) listener({}, name, this.state(name));
    }
    isOpen(name: string) {
      return app.openWindows.includes(name);
    }
    showWelcome() {}
    showHistory(bounds: { x: number; y: number; width: number; height: number }, onBlur: () => void) {
      app.historyBlur = onBlur;
      app.historyWindow.push(`show ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
    }
    fitHistory(bounds: { height: number }) {
      app.historyWindow.push(`history height ${bounds.height}`);
    }
    close(name: string) {
      if (name === "history") app.historyWindow.push("close");
    }
  },
}));

/** Launches the main process on `platform`. */
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

async function launch(platform: NodeJS.Platform): Promise<void> {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  vi.resetModules();
  await import("../../src/main/index.js");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  app.handlers.clear();
  app.listeners.clear();
  app.helpers.clear();
  app.capture = null;
  app.paste = null;
  app.copy = null;
  app.corrections = undefined;
  app.prewarms = 0;
  app.history = null;
  app.clipboard = [];
  app.clipboardFails = false;
  app.historyWindow = [];
  app.hides = 0;
  app.openWindows = [];
  app.historyBlur = null;
  app.audioCommands = [];
  app.overlay = null;
  app.controller = null;
  app.stored.clear();
  app.opened = [];
  app.openFailure = null;
  app.connectorTools = [];
  app.scripts = [];
  if (app.appData !== null) rmSync(app.appData, { recursive: true, force: true });
  app.appData = null;
  app.fullName = null;
  app.trayActions = null;
  app.trayState = null;
  app.packaged = false;
  app.version = "0.0.0";
  app.credential = null;
  app.autoUpdater = null;
  app.squirrel = null;
  app.trayUpdates = 0;
  app.dialogs = [];
  app.dialogResponse = 1;
  app.openDialogs = [];
  app.pickedPath = null;
});

/** Sends `command` to the main process as a window would. */
function send(command: unknown): Promise<unknown> {
  return Promise.resolve(app.handlers.get(channels.command)?.({}, command));
}

describe("main process wiring", () => {
  /** Launching prepares the microphone ahead of the first dictation, once, on every platform: the
   * helper's prepared engine on macOS, the audio window's worklet elsewhere (through `onStart`,
   * which runs even where `voice-macos` can't spawn). */
  test.each(["darwin", "linux"] as const)("launching on %s prepares the microphone once", async (platform) => {
    await launch(platform);
    expect(app.prewarms).toBe(1);
  });

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
   * matching `microphoneStop`; the helper's answer and its chunk events reach the dictation, and
   * the helper exiting under it is the dictation's microphone lost. */
  test("on macOS the capture runs in voice-macos", async () => {
    await launch("darwin");
    const helper = app.helpers.get("voice-macos");
    const capture = app.capture;
    expect(capture).not.toBeNull();
    const completions: (Error | null)[] = [];
    const chunks: Float32Array[] = [];
    let losses = 0;

    capture?.start(
      (samples) => chunks.push(samples),
      (error) => completions.push(error),
      () => {
        losses += 1;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const samples = new Float32Array([0.25, -0.5]);
    helper?.events.get("microphoneChunk")?.({ event: "microphoneChunk", session: 1, samples: Buffer.from(samples.buffer).toString("base64") });
    expect(completions).toEqual([null]);
    expect(chunks).toEqual([samples]);
    helper?.onExit?.();
    expect(losses).toBe(1);
    capture?.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const microphone = helper?.requests.filter((request) => request.method.startsWith("microphone") && request.method !== "microphonePrepare") ?? [];
    expect(microphone).toEqual([
      { method: "microphoneStart", params: { session: 1, sampleRate: config.recordingSampleRate } },
      { method: "microphoneStop", params: { session: 1 } },
    ]);
  });

  /** Elsewhere the microphone stays in the audio window, until those platforms have a native
   * helper: the capture's start and stop are commands to that window for the dictation's session,
   * and `voice-macos` is never asked for the microphone nor its exit taken for a lost one. */
  test("elsewhere the capture runs in the audio window", async () => {
    await launch("linux");
    const helper = app.helpers.get("voice-macos");
    const capture = app.capture;
    expect(capture).not.toBeNull();

    capture?.start(
      () => {},
      () => {},
      () => {},
    );
    capture?.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.audioCommands).toEqual([
      { type: "start", session: 1 },
      { type: "stop", session: 1 },
    ]);
    expect(helper?.requests.filter((request) => request.method.startsWith("microphone") && request.method !== "microphonePrepare")).toEqual([]);
    expect(helper?.onExit).toBeUndefined();
  });

  /** A dictation's paste reaches `voice-macos` with the dictation's session and signal, so a paste waiting out a
   * helper restart is called off when the dictation is. */
  test("a dictation's paste carries its signal to voice-macos", async () => {
    await launch("darwin");
    const helper = app.helpers.get("voice-macos");
    const { signal } = new AbortController();

    await app.paste?.("Hello.", signal);

    const inserts = helper?.requests.filter((request) => request.method === "insert") ?? [];
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.signal).toBe(signal);
    expect(inserts[0]?.params).toMatchObject({ text: "Hello." });
  });

  /** A text not pasted (ADR-DESK-042) goes on the clipboard. */
  test("a text not pasted is copied", async () => {
    await launch("darwin");

    app.copy?.("Hello.");
    expect(app.clipboard).toEqual(["Hello."]);
  });

  /** Electron 44's clipboard write is a promise: a refused one is logged, never left unhandled. */
  test("a clipboard write that fails is logged", async () => {
    await launch("darwin");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      app.clipboardFails = true;
      app.copy?.("Hello.");
      await new Promise((resolve) => setImmediate(resolve));
      expect(stderr).toHaveBeenCalledWith("main: couldn't copy to the clipboard: Error\n");
    } finally {
      stderr.mockRestore();
    }
  });

  /** A triple tap opens the paste history where the chat window opens, by the pill (ADR-DESK-043), which shows the controller's
   * history and takes its list's height; a click copies the entry, closes the window and gives the
   * user's app its focus back, as Escape does without copying. */
  test("the paste history opens by the pill, and a click copies its entry", async () => {
    await launch("darwin");
    const states: unknown[] = [];
    app.listeners.set("voice:state", [
      (_event, name, state) => {
        if (name === "history") states.push(state);
      },
    ]);
    app.history?.add("Hello there.");
    expect(states).toEqual([{ entries: [expect.objectContaining({ text: "Hello there." })] }]);

    app.controller?.onShowHistory?.();
    // Over the pill (its top edge's center at 700,600, the bubbles under it), the pill's gap clear.
    const top = 600 - config.chatPillGap - config.pasteHistoryMaxHeight;
    expect(app.historyWindow).toEqual([`show ${700 - config.pasteHistoryWindowWidth / 2},${top} ${config.pasteHistoryWindowWidth}x${config.pasteHistoryMaxHeight}`]);
    await send({ type: "historyHeight", height: 120 });
    await send({ type: "historyHeight", height: config.pasteHistoryMaxHeight + 100 });
    expect(app.historyWindow.slice(1)).toEqual(["history height 120", `history height ${config.pasteHistoryMaxHeight}`]);

    const id = app.history?.entries[0]?.id;
    await send({ type: "copyHistoryEntry", id });
    expect(app.clipboard).toEqual(["Hello there."]);
    expect(app.historyWindow.at(-1)).toBe("close");
    expect(app.hides).toBe(1);

    await send({ type: "closeHistory" });
    expect(app.clipboard).toEqual(["Hello there."]);
    expect(app.hides).toBe(2);

    // Opened again while open, its list measures itself again, so it takes that height once more.
    app.controller?.onShowHistory?.();
    const pushes = states.length;
    app.controller?.onShowHistory?.();
    expect(states.length).toBeGreaterThan(pushes);
    // It keeps the height its list last measured, never first its tallest (red-verified).
    await send({ type: "historyHeight", height: 150 });
    app.controller?.onShowHistory?.();
    expect(app.historyWindow.at(-1)).toMatch(/ \d+x150$/);

    // With the bubbles over the pill (by the bottom of the screen), it opens over them, as the chat
    // would, never over the pill alone where it would cover them (red-verified).
    (app.overlay as unknown as { pillPlace: { bubblesUnder: boolean } }).pillPlace.bubblesUnder = false;
    app.controller?.onShowHistory?.();
    const overBubbles = 600 - config.agentBubbleGap - config.agentBubbleDiameter - config.chatPillGap - 150;
    expect(app.historyWindow.at(-1)).toBe(`show ${700 - config.pasteHistoryWindowWidth / 2},${overBubbles} ${config.pasteHistoryWindowWidth}x150`);

    // A click elsewhere closes it, the focus already gone where the user clicked.
    app.controller?.onShowHistory?.();
    app.historyBlur?.();
    expect(app.historyWindow.at(-1)).toBe("close");
    expect(app.hides).toBe(2);
  });

  /** Closing the history hides the app, to give the user's app its focus back, only on macOS and only
   * with nothing else of the app's showing: not Settings, and not the chat, which the hide would take
   * with it while the next holds talk to it. An entry gone from the history copies nothing. */
  test("closing the paste history hides the app only when nothing else of it shows", async () => {
    await launch("darwin");
    for (const window of ["settings", "welcome", "contextDebug"]) {
      app.openWindows = [window];
      await send({ type: "closeHistory" });
    }
    app.openWindows = [];
    const controller = app.controller;
    if (!controller) throw new Error("no controller");
    controller.chat = {};
    await send({ type: "closeHistory" });
    expect(app.hides).toBe(0);
    controller.chat = null;
    await send({ type: "copyHistoryEntry", id: 999 });
    expect(app.hides).toBe(1);
    expect(app.clipboard).toEqual([]);
    expect(app.historyWindow).toEqual(["close", "close", "close", "close", "close"]);
  });

  test("closing the paste history elsewhere leaves the app shown", async () => {
    await launch("linux");
    await send({ type: "closeHistory" });
    expect(app.hides).toBe(0);
    expect(app.historyWindow).toEqual(["close"]);
  });

  /** Placing the overlay pushes its view the direction it opened in, which the hands-free tip is
   * placed by (over the pill only when the overlay opened upward), and whether agent mode's bubbles
   * fit under the pill; the view is given the connectors' bubbles the controller shows. */
  test("placing the overlay pushes the direction it opened in and the bubbles' room", async () => {
    await launch("darwin");
    const pushed: unknown[] = [];
    app.listeners.set("voice:state", [
      (_event, name, state) => {
        const overlayState = state as { opensUpward: boolean; bubblesFitUnder: boolean; connectors: string[] };
        if (name === "overlay") pushed.push([overlayState.opensUpward, overlayState.bubblesFitUnder, overlayState.connectors]);
      },
    ]);
    const overlay = app.overlay;
    expect(overlay).not.toBeNull();
    if (app.controller) app.controller.connectors = ["calendar", "web"];

    if (overlay) [overlay.opensUpward, overlay.bubblesFitUnder] = [true, false];
    overlay?.onPlace?.();
    if (overlay) [overlay.opensUpward, overlay.bubblesFitUnder] = [false, true];
    overlay?.onPlace?.();
    if (overlay) [overlay.opensUpward, overlay.bubblesFitUnder] = [false, false];
    overlay?.onPlace?.();

    expect(pushed).toEqual([
      [true, false, ["calendar", "web"]],
      [false, true, ["calendar", "web"]],
      [false, false, ["calendar", "web"]],
    ]);
  });

  /** The hotkey helper is told whenever the chat window opens or closes, so Escape closes it only
   * while it is open; a restarted helper is told again. The overlay turns into the chat window and
   * back. */
  test("the hotkey helper and the overlay follow the chat window", async () => {
    await launch("darwin");
    const hotkey = app.helpers.get("voice-hotkey");
    const controller = app.controller;
    const chatRequests = () => hotkey?.requests.filter((request) => request.method === "setChatOpen").map((request) => request.params) ?? [];
    expect(chatRequests()).toEqual([{ isOpen: false }]);

    if (controller) controller.chat = {};
    controller?.onChatChange?.(true);
    hotkey?.onStart?.();
    expect(app.overlay?.updates.at(-1)).toEqual(["idle", true]);
    if (controller) controller.chat = null;
    controller?.onChatChange?.(false);
    hotkey?.onStart?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chatRequests()).toEqual([{ isOpen: false }, { isOpen: true }, { isOpen: true }, { isOpen: false }, { isOpen: false }]);
    expect(app.overlay?.updates.at(-1)).toEqual(["idle", false]);
  });

  /** `voice-hotkey` applies the requests it holds in any order (each runs in its own task): the chat
   * window opening and closing at once still leaves it with the window closed, since it is told one
   * change at a time. Red against sending both at once: applied newest first, the window's opening
   * wins. */
  test("the hotkey helper ends with the chat window's last state", async () => {
    await launch("darwin");
    const hotkey = app.helpers.get("voice-hotkey");
    const controller = app.controller;
    if (!hotkey || !controller) throw new Error("not launched");
    hotkey.hold = true;
    let applied: unknown = null;

    controller.chat = {};
    controller.onChatChange?.(true);
    controller.chat = null;
    controller.onChatChange?.(false);
    // Answer whatever the helper holds, newest first, until nothing more comes.
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const held = hotkey.unanswered.splice(0).reverse();
      if (held.length === 0) break;
      for (const request of held) {
        if (request.method === "setChatOpen") applied = request.params;
        request.answer();
      }
    }

    expect(applied).toEqual({ isOpen: false });
    expect(hotkey.requests.filter((request) => request.method === "setChatOpen").map((request) => request.params)).toEqual([{ isOpen: false }, { isOpen: true }, { isOpen: false }]);
  });

  /** A change the helper fails (it exited, or timed out) holds up none after it. */
  test("a failed chat-window change holds up none after it", async () => {
    await launch("darwin");
    const hotkey = app.helpers.get("voice-hotkey");
    const controller = app.controller;
    if (!hotkey || !controller) throw new Error("not launched");
    hotkey.hold = true;
    const chatRequests = () => hotkey.requests.filter((request) => request.method === "setChatOpen").map((request) => request.params);

    controller.chat = {};
    controller.onChatChange?.(true);
    controller.chat = null;
    controller.onChatChange?.(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    hotkey.unanswered.splice(0).forEach((request) => request.answer(new Error("exited")));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chatRequests()).toEqual([{ isOpen: false }, { isOpen: true }, { isOpen: false }]);
  });

  /** The overlay page is given the conversation as the controller holds it, every turn, placed where
   * the overlay window placed it, and none once the window closes; and the bubbles' history and the
   * apps running. */
  test("the overlay page is given the conversation, where it opened and the bubbles' history", async () => {
    await launch("darwin");
    const controller = app.controller;
    const overlay = app.overlay;
    if (!controller || !overlay) throw new Error("not launched");
    const state = () => app.handlers.get(channels.getState)?.({}, "overlay") as { chat: unknown; chatPlacement: unknown };
    const chat = {
      turns: [
        { id: 0, request: "When is the launch", tool: "answer", reply: "Friday" },
        { id: 1, request: "And the party", tool: "answer", reply: "**Saturday**" },
      ],
      pendingRequest: "Where",
      closesAt: null,
    };

    controller.chat = chat;
    controller.recentBubbles = ["web", "answer"];
    controller.runningConnectors = ["web"];
    const placement = { below: false, maxHeight: config.chatMaxHeight, bubblesUnder: true, pillX: 206 };
    overlay.chatPlacement = placement;
    expect(state()).toMatchObject({ chat, chatPlacement: placement, recentBubbles: ["web", "answer"], runningConnectors: ["web"] });
    controller.chat = null;
    overlay.chatPlacement = null;
    expect(state()).toMatchObject({ chat: null, chatPlacement: null });
  });

  /** A follow-up's phases reach the overlay with the chat window open, so it stays the chat window;
   * without one, the pill shows. */
  test("a follow-up's phases keep the chat window", async () => {
    await launch("darwin");
    const controller = app.controller;

    if (controller) controller.chat = {};
    controller?.onPhaseChange?.({ kind: "arming" });
    expect(app.overlay?.updates.at(-1)).toEqual(["arming", true]);
    if (controller) controller.chat = null;
    controller?.onPhaseChange?.({ kind: "listening" });
    expect(app.overlay?.updates.at(-1)).toEqual(["listening", false]);
  });

  /** The chat window's commands (a touch, closing, the answer to its question) reach the controller
   * and the overlay; its links open only a web page,
   * and only while it is open. */
  test("the chat window's commands", async () => {
    await launch("darwin");
    const controller = app.controller;

    await send({ type: "keepChatOpen" });
    await send({ type: "closeChat" });
    await send({ type: "answerConfirmation", confirmed: true });
    await send({ type: "answerConfirmation", confirmed: false });
    await send({ type: "chatHeight", height: 180 });
    expect(await send({ type: "chatHeight", height: -1 })).toEqual({ error: expect.any(String) });
    await send({ type: "openChatLink", url: "https://example.com/closed" });
    if (controller) controller.chat = {};
    await send({ type: "openChatLink", url: "https://example.com/docs" });
    await send({ type: "openChatLink", url: "file:///Applications/Calculator.app" });

    expect(controller?.calls).toEqual(["keepChatOpen", "closeChat", "answerConfirmation true", "answerConfirmation false"]);
    expect(app.overlay?.heights).toEqual([180]);
    expect(app.opened).toEqual(["https://example.com/docs"]);
  });

  /** An agent tool's switch is stored and shows in the Settings and welcome windows; a name that is
   * no agent tool, or a value that is no boolean (even one that reads as on or off), is refused and
   * changes nothing. */
  test("an agent tool's switch", async () => {
    await launch("darwin");
    const state = (name: string) => app.handlers.get(channels.getState)?.({}, name) as { enabledTools: string[] };

    expect(await send({ type: "setAgentToolEnabled", tool: "answer", value: false })).toEqual({ error: null });
    for (const value of ["false", "true", 1, null]) {
      expect(await send({ type: "setAgentToolEnabled", tool: "answer", value })).toEqual({ error: expect.any(String) });
    }
    expect(state("settings").enabledTools).toEqual(["edit", "compose"]);
    expect(await send({ type: "setAgentToolEnabled", tool: "answer", value: true })).toEqual({ error: null });
    expect(state("settings").enabledTools).toEqual(["edit", "compose", "answer"]);
    expect(await send({ type: "setAgentToolEnabled", tool: "answer", value: false })).toEqual({ error: null });
    expect(await send({ type: "setAgentToolEnabled", tool: "retired-tool", value: false })).toEqual({ error: expect.any(String) });

    expect(state("settings").enabledTools).toEqual(["edit", "compose"]);
    expect(state("welcome").enabledTools).toEqual(["edit", "compose"]);
  });

  /** On macOS the Answer tool reaches Calendar, Reminders, Contacts and Files through `voice-macos`,
   * the email app, Notes and Messages through osascript, and the web with pages opened in the browser, and each has a switch, stored and shown in the Settings
   * and welcome windows; a name that is no app is refused. */
  test("on macOS, Calendar, Reminders, Contacts, Files, Email, Notes, Messages and Web and their switches", async () => {
    await launch("darwin");
    const state = (name: string) => app.handlers.get(channels.getState)?.({}, name) as { connectors: string[]; enabledConnectors: string[] };

    expect(app.connectorTools.map((tool) => tool.name)).toEqual(["calendar_read", "calendar_event_create", "reminders_read", "reminder_create", "contacts_search", "contacts_add", "files_search", "file_open", "email_compose", "notes_search", "notes_create", "messages_send", "web_read", "web_open"]);
    // Every app with a switch has its tools, and every tool's app a switch.
    expect(new Set(app.connectorTools.map((tool) => tool.connector))).toEqual(new Set(connectorIDs));
    await app.connectorTools.find((tool) => tool.name === "calendar_read")?.run({}, signal);
    await app.connectorTools.find((tool) => tool.name === "contacts_search")?.run({ query: "Sam" }, signal);
    await app.connectorTools.find((tool) => tool.name === "files_search")?.run({ query: "tax" }, signal);
    expect(app.helpers.get("voice-macos")?.requests.map((request) => request.method)).toEqual(expect.arrayContaining(["calendarEvents", "contactsSearch", "filesSearch"]));
    await app.connectorTools.find((tool) => tool.name === "notes_search")?.run({ query: "offsite" }, signal);
    await app.connectorTools.find((tool) => tool.name === "messages_send")?.run({ to: "sam@example.com", text: "Hi" }, signal);
    expect(app.scripts.map((script) => script.args)).toEqual([["offsite"], ["sam@example.com", "Hi"]]);
    await app.connectorTools.find((tool) => tool.name === "web_open")?.run({ url: "https://example.com/page" }, signal);
    expect(app.opened).toEqual(["https://example.com/page"]);

    expect(await send({ type: "setConnectorEnabled", connector: "calendar", value: false })).toEqual({ error: null });
    expect(await send({ type: "setConnectorEnabled", connector: "retired-app", value: false })).toEqual({ error: expect.any(String) });
    for (const name of ["settings", "welcome"]) {
      expect(state(name).connectors).toEqual(["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"]);
      expect(state(name).enabledConnectors).toEqual(["reminders", "contacts", "files", "email", "notes", "messages", "web"]);
    }
  });

  /** Settings and the welcome wizard offer the computer account's name: on macOS its full name from
   * `voice-macos`, else (here the helper gives none) its short name, as elsewhere. A name typed in
   * either is stored as typed and shown in both. */
  test.each(["darwin", "linux"] as const)("the offered name and the name typed, on %s", async (platform) => {
    await launch(platform);
    const state = (name: "settings" | "welcome") => app.handlers.get(channels.getState)?.({}, name) as { userName: string | null; suggestedName: string };
    if (platform === "darwin") expect(app.helpers.get("voice-macos")?.requests.map((request) => request.method)).toContain("fullUserName");
    else expect(app.helpers.get("voice-macos")?.requests.map((request) => request.method) ?? []).not.toContain("fullUserName");
    for (const name of ["settings", "welcome"] as const) expect(state(name)).toMatchObject({ userName: null, suggestedName: userInfo().username });

    expect(await send({ type: "setUserName", value: " Alex Example" })).toEqual({ error: null });
    for (const name of ["settings", "welcome"] as const) expect(state(name).userName).toBe(" Alex Example");
    expect(app.stored.get("userName")).toBe(" Alex Example");
  });

  /** A packaged build writes the debug log while debug mode is on for an account allowed it: on at
   * launch when stored on, off when switched off, off once the account signs out, and off for an
   * account not allowed it. */
  test("a packaged build logs while debug mode is on", async () => {
    const signIn = (email: string) => {
      app.credential = JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "user", email } });
    };
    app.packaged = true;
    Object.defineProperty(process, "resourcesPath", { value: "/nonexistent", configurable: true });
    app.stored.set("debugMode", true);
    signIn("tester@tabmail.ai");
    await launch("darwin");
    const { isDebugLogging } = await import("../../src/core/log.js");
    expect(isDebugLogging()).toBe(true);

    expect(await send({ type: "setDebugMode", value: false })).toEqual({ error: null });
    expect(isDebugLogging()).toBe(false);
    expect(await send({ type: "setDebugMode", value: true })).toEqual({ error: null });
    expect(isDebugLogging()).toBe(true);
    // Signed out, the switch left on logs nothing: no account is allowed it.
    expect(await send({ type: "signOut" })).toEqual({ error: null });
    expect(isDebugLogging()).toBe(false);

    signIn("tester@example.com");
    await launch("darwin");
    expect((await import("../../src/core/log.js")).isDebugLogging()).toBe(false);
  });

  /** Settings › General shows the app's own version. */
  test("the settings state carries the app's version", async () => {
    app.version = "9.8.7";
    await launch("darwin");
    expect((app.handlers.get(channels.getState)?.({}, "settings") as { version: string }).version).toBe("9.8.7");
  });

  /** Settings › Dictionary's commands change the stored dictionary and the learning switch, which the
   * state shows; learning is offered only on macOS, where the helper reads the field (ADR-DESK-038). */
  test.each(["darwin", "linux"] as const)("the dictionary's commands and state, on %s", async (platform) => {
    await launch(platform);
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as { dictionary: unknown; learnsWords: boolean; canLearnWords: boolean };
    expect(state()).toMatchObject({ dictionary: [], learnsWords: true, canLearnWords: platform === "darwin" });

    expect(await send({ type: "addDictionaryWord", word: " Xyvora " })).toEqual({ error: null });
    expect(await send({ type: "addDictionaryWord", word: "TabMail" })).toEqual({ error: null });
    expect(await send({ type: "removeDictionaryWord", word: "TabMail" })).toEqual({ error: null });
    expect(await send({ type: "setLearnsWords", value: false })).toEqual({ error: null });

    expect(state()).toMatchObject({ dictionary: [{ word: "Xyvora", learned: false }], learnsWords: false });
    expect(app.stored.get("dictionary")).toEqual([{ word: "Xyvora", learned: false }]);
    expect(app.stored.get("learnsWords")).toBe(false);
  });

  /** On macOS the correction watch reads the field through `voice-macos` and learns into the stored
   * dictionary; elsewhere there is none (no helper reads the field yet). */
  test.each(["darwin", "linux"] as const)("the correction watch's wiring, on %s", async (platform) => {
    await launch(platform);
    if (platform !== "darwin") {
      expect(app.corrections).toBeUndefined();
      return;
    }
    // Its two dependencies, as the watch calls them.
    const watch = app.corrections as unknown as { readField: (pid: number, excludedApps: readonly string[]) => Promise<string | null>; learn: (words: string[]) => void };
    const helper = app.helpers.get("voice-macos");
    await watch.readField(42, ["org.example.vault"]);
    expect(helper?.requests.filter((request) => request.method === "focusedFieldValue").map((request) => request.params)).toStrictEqual([
      { pid: 42, maxLength: config.correctionMaxFieldLength, excludedBundleIdentifiers: ["org.example.vault"] },
    ]);
    watch.learn(["Xyvora"]);
    expect(app.stored.get("dictionary")).toEqual([{ word: "Xyvora", learned: true }]);
  });

  /** The apps a dictation excludes from screen reading reach `voice-macos` with the screen read, as
   * the controller hands them over (ADR-DESK-045): dropped anywhere on the way, the helper would read
   * a password manager in front. */
  test("the screen read carries the dictation's excluded apps to voice-macos", async () => {
    await launch("darwin");
    const controller = app.controller as unknown as { captureContext: (excludedApps: readonly string[]) => Promise<unknown> | null };
    const helper = app.helpers.get("voice-macos");
    helper?.replies.set("readScreen", null);

    expect(await controller.captureContext(["com.example.vault", "org.example.bank"])).toBeNull();

    expect(helper?.requests.filter((request) => request.method === "readScreen").map((request) => request.params)).toStrictEqual([
      { excludedBundleIdentifiers: ["com.example.vault", "org.example.bank"] },
    ]);
  });

  /** Settings › Privacy's commands (ADR-DESK-045): Add App… asks for an app in the Applications
   * folder and excludes the one picked, by the identifier and name `voice-macos` gives for it; an app
   * is removed by its identifier; the state lists the user's apps. Offered on macOS only. */
  test("the excluded apps' commands and state, on macOS", async () => {
    await launch("darwin");
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as { excludedApps: unknown; canExcludeApps: boolean };
    const helper = app.helpers.get("voice-macos");
    expect(state()).toMatchObject({ excludedApps: [], canExcludeApps: true });

    // Canceled: nothing asked of the helper, nothing stored.
    expect(await send({ type: "excludeApp" })).toEqual({ error: null });
    expect(app.openDialogs).toEqual([expect.objectContaining({ defaultPath: config.applicationsDirectory, properties: ["openFile"], filters: [{ name: "Applications", extensions: ["app"] }] })]);
    expect(helper?.requests.some((request) => request.method === "appInfo")).toBe(false);
    expect(state()).toMatchObject({ excludedApps: [] });

    app.pickedPath = "/Applications/Example Bank.app";
    helper?.replies.set("appInfo", { bundleIdentifier: "org.example.bank", name: "Example Bank", path: app.pickedPath });
    expect(await send({ type: "excludeApp" })).toEqual({ error: null });
    expect(helper?.requests.filter((request) => request.method === "appInfo").map((request) => request.params)).toEqual([{ path: "/Applications/Example Bank.app" }]);
    expect(state()).toMatchObject({ excludedApps: [{ bundleIdentifier: "org.example.bank", name: "Example Bank" }] });
    expect(app.stored.get("excludedApps")).toEqual([{ bundleIdentifier: "org.example.bank", name: "Example Bank" }]);

    // What was picked is no app, or one that can't be stored: the pane is told why.
    helper?.replies.set("appInfo", null);
    expect(await send({ type: "excludeApp" })).toEqual({ error: "That app can't be excluded: it has no bundle identifier." });
    helper?.replies.set("appInfo", { bundleIdentifier: "org.example.notes", name: "", path: app.pickedPath });
    expect(await send({ type: "excludeApp" })).toEqual({ error: "That app can't be excluded." });
    expect(state()).toMatchObject({ excludedApps: [{ bundleIdentifier: "org.example.bank", name: "Example Bank" }] });

    expect(await send({ type: "removeExcludedApp", bundleIdentifier: "ORG.example.bank" })).toEqual({ error: null });
    expect(state()).toMatchObject({ excludedApps: [] });
    expect(app.stored.get("excludedApps")).toEqual([]);
  });

  test("no more apps are excluded once the list is full", async () => {
    app.stored.set("excludedApps", Array.from({ length: config.excludedAppsMax }, (_, index) => ({ bundleIdentifier: `org.example.app${index}`, name: `App ${index}` })));
    await launch("darwin");
    app.pickedPath = "/Applications/Example Bank.app";
    app.helpers.get("voice-macos")?.replies.set("appInfo", { bundleIdentifier: "org.example.bank", name: "Example Bank", path: app.pickedPath });

    expect(await send({ type: "excludeApp" })).toEqual({ error: `At most ${config.excludedAppsMax} apps can be excluded. Remove one to add another.` });
    expect((app.stored.get("excludedApps") as unknown[]).length).toBe(config.excludedAppsMax);
  });

  test("elsewhere, apps can't be excluded: nothing is asked", async () => {
    await launch("linux");
    app.pickedPath = "/Applications/Example Bank.app";
    const state = app.handlers.get(channels.getState)?.({}, "settings") as { canExcludeApps: boolean };
    expect(state.canExcludeApps).toBe(false);

    expect(await send({ type: "excludeApp" })).toEqual({ error: null });
    expect(app.openDialogs).toEqual([]);
    expect(app.stored.has("excludedApps")).toBe(false);
  });

  /** On macOS the name offered is the account's full name from `voice-macos`, and Next on the
   * wizard's name step, left as offered, stores it. */
  test("on macOS, the wizard offers the full name, and Next stores it", async () => {
    app.fullName = " Alex Example ";
    await launch("darwin");
    const state = (name: "settings" | "welcome") => app.handlers.get(channels.getState)?.({}, name) as { userName: string | null; suggestedName: string; step: string };
    expect(await eventually(() => state("settings").suggestedName === "Alex Example")).toBe(true);
    expect(state("welcome").suggestedName).toBe("Alex Example");

    app.trayActions?.showWelcome();
    expect(await send({ type: "setConsent", value: true })).toEqual({ error: null });
    await send({ type: "welcomeNext" });
    expect(state("welcome").step).toBe("name");
    expect(app.stored.get("userName")).toBeUndefined();
    await send({ type: "welcomeNext" });
    expect(state("welcome").step).not.toBe("name");
    expect(app.stored.get("userName")).toBe("Alex Example");
    expect(state("settings").userName).toBe("Alex Example");
  });

  /** Files reads the home folder as `~`: a found item's path is given to the model with it, and a
   * `~` path the model gives back opens the item there. */
  test("Files reads the home folder as ~", async () => {
    await launch("darwin");
    const home = homedir();
    const macHelper = app.helpers.get("voice-macos");
    macHelper?.replies.set("filesSearch", { items: [{ path: `${home}/Documents/Tax return.pdf`, name: "Tax return.pdf", kind: "PDF document", changed: null, subject: null, authors: [], isEmail: false }] });
    macHelper?.replies.set("fileOpen", { opened: true });

    expect(await app.connectorTools.find((tool) => tool.name === "files_search")?.run({ query: "tax" }, signal)).toContain(": ~/Documents/Tax return.pdf");
    expect(await app.connectorTools.find((tool) => tool.name === "file_open")?.run({ path: "~/Documents/Tax return.pdf" }, signal)).toBe("Opened Tax return.pdf.");
    expect(macHelper?.requests.find((request) => request.method === "fileOpen")?.params).toEqual({ path: `${home}/Documents/Tax return.pdf`, reveal: false });
  });

  /** A draft opens with the app macOS opens `mailto:` links with, named in the result; with none, the
   * tool says so and opens nothing. */
  test("a draft opens in the default email app", async () => {
    await launch("darwin");
    const compose = app.connectorTools.find((tool) => tool.name === "email_compose");
    const args = { to: ["sam@example.com"], subject: "Lunch", body: "Friday?" };
    const macHelper = app.helpers.get("voice-macos");

    // `launch` loads the app afresh, so the failure is its own module's class: matched by name.
    await expect(compose?.run(args, signal)).rejects.toMatchObject({ name: "NoEmailAppError" });
    expect(app.opened).toEqual([]);

    macHelper?.replies.set("emailApps", { systemDefault: { bundleIdentifier: "com.example.mail", name: "Example Mail" }, installed: [] });
    expect(await compose?.run(args, signal)).toBe("Opened a new email to sam@example.com in Example Mail, for the user to review and send. Nothing was sent.");
    expect(app.opened).toEqual([mailtoURL({ to: ["sam@example.com"], cc: [], bcc: [], subject: "Lunch", body: "Friday?" })]);
    expect(macHelper?.requests.filter((request) => request.method === "emailApps").at(-1)?.params).toEqual({ bundleIdentifiers: [] });

    // An app that fails to launch fails the call, so the model never says it opened.
    app.openFailure = new Error("Failed to open URL");
    await expect(compose?.run(args, signal)).rejects.toThrow("Failed to open URL");
  });

  /** Elsewhere the Answer tool reaches no app on the computer, and none has a switch. */
  test("elsewhere, no app and no switch", async () => {
    await launch("linux");
    const state = (name: string) => app.handlers.get(channels.getState)?.({}, name) as { connectors: string[] };

    expect(app.connectorTools).toEqual([]);
    expect(state("settings").connectors).toEqual([]);
    expect(state("welcome").connectors).toEqual([]);
    });

  /** On macOS, VS Code settings that hide the caret are offered for fixing in the welcome wizard and
   * Settings: the fix sets `editor.editContext` false in the file, keeping its comments, and both
   * open windows are shown it done. Settings that are fine, and every other platform, are never offered or written,
   * and pressing the button there shows nothing new. */
  test("the welcome wizard and Settings fix VS Code settings that hide the caret, on macOS only", async () => {
    app.appData = mkdtempSync(join(tmpdir(), "voice-appdata-"));
    const file = join(app.appData, "Code", "User", "settings.json");
    mkdirSync(join(app.appData, "Code", "User"), { recursive: true });
    const hiding = '{\n    // off on purpose\n    "editor.accessibilitySupport": "off"\n}\n';
    // Settings and the welcome wizard show the same.
    const state = () => {
      const [welcome, settings] = ["welcome", "settings"].map((name) => (app.handlers.get(channels.getState)?.({}, name) as { vscodeFix: string }).vscodeFix);
      expect(settings).toBe(welcome);
      return welcome;
    };
    const pushed: string[] = [];
    // Records afresh from here: launching pushes the windows too (the name the wizard offers, once read).
    const listen = () => {
      pushed.length = 0;
      app.listeners.set("voice:state", [
        (_event, name, pushedState) => {
          if (name === "welcome" || name === "settings") pushed.push(`${String(name)} ${(pushedState as { vscodeFix: string }).vscodeFix}`);
        },
      ]);
    };

    writeFileSync(file, hiding);
    await launch("linux");
    listen();
    expect(state()).toBe("notNeeded");
    expect(await send({ type: "fixVSCodeSettings" })).toEqual({ error: null });
    expect(readFileSync(file, "utf8")).toBe(hiding);
    expect(pushed).toEqual([]);

    await launch("darwin");
    listen();
    expect(state()).toBe("needed");
    expect(await send({ type: "fixVSCodeSettings" })).toEqual({ error: null });
    expect(pushed).toEqual(["welcome done", "settings done"]);
    expect(readFileSync(file, "utf8")).toBe('{\n    "editor.editContext": false,\n    // off on purpose\n    "editor.accessibilitySupport": "off"\n}\n');
    expect(state()).toBe("done");

    // Settings changed back by hand are offered again; settings that were always fine never are.
    writeFileSync(file, hiding);
    expect(state()).toBe("needed");
    const fine = '{ "editor.accessibilitySupport": "auto" }';
    writeFileSync(file, fine);
    await launch("darwin");
    pushed.length = 0;
    listen();
    expect(state()).toBe("notNeeded");
    expect(await send({ type: "fixVSCodeSettings" })).toEqual({ error: null });
    expect(readFileSync(file, "utf8")).toBe(fine);
    expect(pushed).toEqual([]);
  });

  /** The hotkey helper hears that nothing listens hands-free, so it stops keeping Space and Escape
   * from the app in front: when a dictation ends without the hotkey, and when a double tap's release
   * finds no hands-free dictation listening; never while one arms or listens. */
  test("the hotkey helper is told when nothing listens hands-free", async () => {
    await launch("darwin");
    const helper = app.helpers.get("voice-hotkey");
    const controller = app.controller;
    expect(controller).not.toBeNull();
    const ended = () => helper?.requests.filter((request) => request.method === "dictationEnded").length;

    controller?.onPhaseChange?.({ kind: "arming" });
    controller?.onPhaseChange?.({ kind: "listening" });
    expect(ended()).toBe(0);
    controller?.onPhaseChange?.({ kind: "transcribing" });
    expect(ended()).toBe(1);
    controller?.onNothingListening?.();
    expect(ended()).toBe(2);
  });

  describe("updates (ADR-DESK-041)", () => {
    /** A packaged build, launched with its resources where Electron puts them. */
    async function launchPackaged(): Promise<void> {
      app.packaged = true;
      Object.defineProperty(process, "resourcesPath", { value: "/nonexistent", configurable: true });
      await launch("darwin");
    }
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    /** `electron-updater` has downloaded `version`, and macOS has accepted it. */
    function downloaded(version: string): void {
      app.autoUpdater?.emit("update-downloaded", { version });
      app.squirrel?.emit("update-downloaded");
    }

    test("a debug build has no updater and no update item", async () => {
      await launch("darwin");

      expect(app.trayState?.().update).toBeNull();
      app.trayActions?.checkForUpdates();
      app.trayActions?.restartToUpdate();
    });

    test("a packaged build updates by itself, silently to the console, and shows it in the menu", async () => {
      await launchPackaged();
      const updater = app.autoUpdater;

      expect(updater?.autoDownload).toBe(true);
      expect(updater?.autoInstallOnAppQuit).toBe(true);
      expect(updater?.logger).toBeNull();
      expect(updater?.requestHeaders).toEqual({ "x-user-staging-id": "none" });
      expect(app.trayState?.().update).toEqual({ kind: "idle" });
      app.trayActions?.checkForUpdates();
      expect(updater?.checks).toBe(1);
      expect(app.trayState?.().update).toEqual({ kind: "checking" });
    });

    test("a packaged build looks for an update by itself after launching", async () => {
      vi.useFakeTimers();
      try {
        const launched = launchPackaged();
        await vi.advanceTimersByTimeAsync(0);
        await launched;
        expect(app.autoUpdater?.checks).toBe(0);

        await vi.advanceTimersByTimeAsync(config.updateFirstCheckDelay);
        expect(app.autoUpdater?.checks).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test("a download is not ready until macOS accepts it", async () => {
      await launchPackaged();

      app.autoUpdater?.emit("update-downloaded", { version: "9.9.9" });
      await settle();
      expect(app.trayState?.().update).toEqual({ kind: "idle" });
      expect(app.dialogs).toEqual([]);

      app.squirrel?.emit("update-downloaded");
      await settle();
      expect(app.trayState?.().update).toEqual({ kind: "ready", version: "9.9.9" });
      expect(app.dialogs).toEqual([expect.objectContaining({ message: "TabMail Voice 9.9.9 is ready." })]);
    });

    test("every change of the update's state reaches the menu", async () => {
      await launchPackaged();
      const before = app.trayUpdates;

      app.trayActions?.checkForUpdates();

      expect(app.trayUpdates).toBe(before + 1);
    });

    /** Settings › General's update button shows the update's state, pushed at each change, and does
     * what the menu's item does. */
    test("Settings shows the update's state and its button checks and restarts", async () => {
      await launchPackaged();
      const settingsUpdate = () => (app.handlers.get(channels.getState)?.({}, "settings") as { update: unknown }).update;
      const pushed: unknown[] = [];
      app.listeners.set("voice:state", [
        (_event, name, state) => {
          if (name === "settings") pushed.push((state as { update: unknown }).update);
        },
      ]);
      expect(settingsUpdate()).toEqual({ kind: "idle" });

      expect(await send({ type: "checkForUpdates" })).toEqual({ error: null });
      expect(app.autoUpdater?.checks).toBe(1);
      expect(settingsUpdate()).toEqual({ kind: "checking" });
      expect(pushed).toContainEqual({ kind: "checking" });

      downloaded("9.9.9");
      await settle();
      expect(settingsUpdate()).toEqual({ kind: "ready", version: "9.9.9" });
      expect(pushed).toContainEqual({ kind: "ready", version: "9.9.9" });
      expect(app.autoUpdater?.installs).toBe(0);
      await send({ type: "restartToUpdate" });
      expect(app.autoUpdater?.installs).toBe(1);
    });

    test("Check for Updates answers when the app is up to date", async () => {
      await launchPackaged();
      const updater = app.autoUpdater;
      if (updater) (updater as unknown as { checkForUpdates: () => Promise<unknown> }).checkForUpdates = () => Promise.resolve({ isUpdateAvailable: false });

      app.trayActions?.checkForUpdates();
      await settle();

      // The running version, as the app reports it.
      expect(app.dialogs).toEqual([expect.objectContaining({ message: "TabMail Voice is up to date.", detail: "Version 0.0.0 is the latest version.", buttons: ["OK"] })]);
    });

    test("the question waits for the dictation to end and the chat to close; Later is Return's and Escape's", async () => {
      await launchPackaged();
      const updater = app.autoUpdater;
      const controller = app.controller as unknown as { phase: { kind: string }; chat: object | null; onPhaseChange: (phase: { kind: string }) => void; onChatChange: (isOpen: boolean) => void };

      controller.phase = { kind: "listening" };
      downloaded("9.9.9");
      await settle();
      expect(app.dialogs).toEqual([]);
      expect(app.trayState?.().update).toEqual({ kind: "ready", version: "9.9.9" });

      // The dictation ends into the chat window: still not.
      controller.phase = { kind: "idle" };
      controller.chat = {};
      controller.onPhaseChange({ kind: "idle" });
      await settle();
      expect(app.dialogs).toEqual([]);

      controller.chat = null;
      controller.onChatChange(false);
      await settle();
      expect(app.dialogs).toHaveLength(1);
      const dialog = app.dialogs[0] as { buttons: string[]; defaultId: number; cancelId: number };
      expect(dialog.buttons[dialog.defaultId]).toBe("Later");
      expect(dialog.buttons[dialog.cancelId]).toBe("Later");
      // Answered Later: nothing installs until the quit, or the menu's Restart to Update.
      expect(updater?.installs).toBe(0);
      app.trayActions?.restartToUpdate();
      expect(updater?.installs).toBe(1);
    });

    /** A text copied instead of pasted (ADR-DESK-042) ends a dictation as a failure does. */
    test.each(["failed", "copied"])("after a %s dictation, Restart Now installs at once", async (ended) => {
      await launchPackaged();
      const updater = app.autoUpdater;
      const controller = app.controller as unknown as { phase: { kind: string }; onPhaseChange: (phase: { kind: string }) => void };
      app.dialogResponse = 0;

      controller.phase = { kind: "transcribing" };
      downloaded("9.9.9");
      await settle();
      expect(app.dialogs).toEqual([]);
      controller.phase = { kind: ended };
      controller.onPhaseChange({ kind: ended });
      await settle();

      expect((app.dialogs[0] as { buttons: string[] }).buttons[0]).toBe("Restart Now");
      expect(updater?.installs).toBe(1);
    });
  });
});
