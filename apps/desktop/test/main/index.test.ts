// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { screen as blankScreen } from "../support/screens.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConnectorTool } from "../../src/core/agent/connectors/contract.js";
import { connectorIDs } from "../../src/core/agent/connectors/index.js";
import { mailtoURL } from "../../src/core/agent/connectors/email.js";
import type { AudioCapture } from "../../src/core/audio/recorder.js";
import * as config from "../../src/core/config.js";
import { aiOffLine, resetCopyPath, unsavedBecauseOf } from "../../src/core/ui/fileProblems.js";
import { optedOutOfAIMemoryLine } from "../../src/core/settings.js";
import type { Rect } from "../../src/core/ui/overlayGeometry.js";
import type { MemoryPageState } from "../../src/core/memory/page.js";
import type { PersonalizationState } from "../../src/core/personalization/page.js";
import { memoryRow } from "../../src/core/memory/store.js";
import { memoryFolders } from "../../src/main/native/memoryHelper.js";
import { channels, type SettingsState } from "../../src/shared/ipc.js";
import { eventually, toolSettings } from "../support/stubs.js";

/** The signal a tool runs with: a request never canceled. */
const signal = new AbortController().signal;

/** The main process as the app wires it, over stand-ins for Electron, the helpers and the
 * controller: which helper a dictation's microphone runs in, and what a restarted helper does.
 * Nothing reaches the network, the Keychain, the microphone or the desktop. */
const app = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, argument: unknown) => unknown>(),
  listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
  /** The app's own events (`before-quit`), by name. */
  appEvents: new Map<string, (...args: unknown[]) => void>(),
  credential: null as string | null,
  refusesDelete: false,
  helpers: new Map<string, { options: { name: string; executable: string; args?: string[]; restartExitCode?: number; stopEndsAtOnce?: boolean }; lifecycle: string[]; onStart: (() => void) | undefined; onExit: (() => void) | undefined; requests: { method: string; params: unknown; signal?: AbortSignal }[]; events: Map<string, (message: Record<string, unknown>) => void>; hold: boolean; unanswered: { method: string; params: unknown; answer: (error?: Error) => void }[]; replies: Map<string, unknown> }>(),
  capture: null as AudioCapture | null,
  paste: null as ((text: string, signal: AbortSignal, target: number) => Promise<void>) | null,
  copy: null as ((text: string) => Promise<boolean>) | null,
  saveClipboard: null as (() => void) | null,
  corrections: undefined as { watch(target: number, pasted: string): void; stop(): void } | undefined,
  frontmostApp: undefined as (() => Promise<number | null>) | undefined,
  useWords: undefined as ((texts: readonly string[]) => void) | undefined,
  /** The dictation settings snapshot and the last-recording callback, as the app gave the controller. */
  dictationSettings: null as (() => { keepsRecording: boolean }) | null,
  keepRecording: undefined as ((wav: Uint8Array) => void) | undefined,
  prewarms: 0,
  /** The paste history the controller was given, what went on the clipboard, the history window's
   * openings, moves and closings, and each time the app was hidden. */
  history: null as { add(text: string): void; entries: readonly { id: number; text: string }[] } | null,
  clipboard: [] as string[],
  /** The clipboard refuses the next write. */
  clipboardFails: false,
  historyWindow: [] as string[],
  hides: 0,
  /** The codes `app.exit` was called with. */
  exits: [] as number[],
  /** How often the app asked Electron to quit. */
  quits: 0,
  /** The windows other than the overlay that are open. */
  openWindows: [] as string[],
  /** What the history window does when it loses the focus. */
  historyBlur: null as (() => void) | null,
  audioCommands: [] as unknown[],
  placementAreas: [] as (Rect | null | undefined)[],
  overlay: null as { locate: () => Promise<Rect | null>; opensUpward: boolean; bubblesFitUnder: boolean; chatPlacement: object | null; onPlace: (() => void) | undefined; updates: [string, boolean][]; heights: number[]; pointers: boolean[]; drags: unknown[]; isTakingClicks: boolean; hitTest?: string } | null,
  controller: null as { connectors: string[]; recentBubbles: string[]; runningBubble: string | null; chat: object | null; onChatChange: ((isOpen: boolean) => void) | undefined; onPhaseChange: ((phase: { kind: string }) => void) | undefined; onNothingListening: (() => void) | undefined; onShowHistory: (() => void) | undefined; calls: string[]; phase: object } | null,
  stored: new Map<string, unknown>(),
  /** Every file a store was opened on, by path, with its values (the preferences file's are `stored`). */
  files: new Map<string, Map<string, unknown>>(),
  /** Whether the preferences file can't be written: a value set is held, and reported unsaved. */
  savesFail: false,
  /** Why a file couldn't be read at launch, by its path: none is saved to (`JSONFileStore.problem`). */
  problems: new Map<string, import("../../src/core/util/keyValueStore.js").StoreProblem>(),
  /** The files not there at launch, by path (`JSONFileStore.isNew`). */
  missingFiles: new Set<string>(),
  /** The files shown in Finder. */
  shownFiles: [] as string[],
  opened: [] as string[],
  openFailure: null as Error | null,
  emailHandler: "",
  connectorTools: [] as ConnectorTool[],
  scripts: [] as { source: string; args: readonly string[] }[],
  /** `app.getPath("appData")`, where VS Code keeps its settings; null for none. */
  appData: null as string | null,
  /** `app.getPath("userData")`, the app's own folder (memory's is in it). */
  userData: "/nonexistent",
  /** The writing style and knowledge base the controller was given (ADR-DESK-063). */
  prompts: null as import("../../src/core/personalization/prompts.js").UserPrompts | null,
  /** Memory as the app made it: a stand-in that keeps it in a list. */
  memory: null as (import("../support/fakeMemory.js").FakeMemory & { options: { directory: string }; stops: number }) | null,
  /** The full name `voice-macos` gives for the account; null for a reply without one. */
  fullName: null as string | null,
  /** The tray menu's actions and state, as the app gives them. */
  trayActions: null as { showWelcome: () => void; showSettings: () => void; showFileProblem: (file: import("../../src/core/ui/fileProblems.js").StoredFile) => void; checkForUpdates: () => void; installUpdate: () => void; debug: { showLastScreenContext: () => void; hasLastRecording: () => boolean; showLogFile: () => void; showsSmokeTip: () => boolean; toggleSmokeTip: () => void } } | null,
  /** The windows the app asked to bring forward, in order. */
  presented: [] as string[],
  /** Every request that reached the network (`liveTransport`), by URL. */
  requests: [] as string[],
  /** The backend clients the app gives the dictation controller. */
  backend: null as {
    warmUp: (baseURL: string, accessToken: string) => Promise<void>;
    makeTranscriptionClient: (baseURL: string) => import("../../src/core/backend/transcription.js").TranscriptionClient;
    makeCompletionsClient: (baseURL: string) => import("../../src/core/backend/completions.js").CompletionsClient;
  } | null,
  trayState: null as (() => { update: unknown; fileProblems?: unknown; hasConsented?: unknown; optsOutOfAI?: unknown }) | null,
  /** A packaged build, which updates itself (ADR-DESK-041); a debug build otherwise. */
  packaged: false,
  /** `app.getVersion()`. */
  version: "0.0.0",
  /** `electron-updater`'s `autoUpdater` as the app last got it. */
  autoUpdater: null as (import("node:events").EventEmitter & { kind: string; autoDownload: boolean; autoInstallOnAppQuit: boolean; allowDowngrade: boolean; disableWebInstaller: boolean; verifyUpdateCodeSignature: unknown; logger: unknown; requestHeaders: Record<string, string> | null; feed: unknown; checks: number; installs: number; installedWith: unknown[] }) | null,
  /** Electron's own `autoUpdater` (Squirrel.Mac) as the app last got it. */
  squirrel: null as import("node:events").EventEmitter | null,
  /** How often the app refreshed its tray menu. */
  trayUpdates: 0,
  /** The application menu the app set, as its template; null for none set. */
  applicationMenu: null as unknown[] | null,
  /** The message boxes shown, and the button each is answered with. */
  dialogs: [] as Record<string, unknown>[],
  /** For each message box, whether the app's commands were wired by then: launch was done. */
  dialogsAfterLaunch: [] as boolean[],
  dialogResponse: 1,
  /** Answers for the next dialogs, in order, before `dialogResponse`. */
  /** Answers held back until a test resolves them, as a dialog left open. */
  dialogResponses: [] as (number | Promise<number>)[],
  /** The files the factory reset moved aside, and where. */
  movedAside: [] as { path: string; aside: string }[],
  moveAsideFails: false,
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
      commandLine: { appendSwitch: vi.fn() },
      get isPackaged() {
        return app.packaged;
      },
      focus() {},
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      getPath: (name: string) => (name === "appData" && app.appData !== null ? app.appData : name === "userData" ? app.userData : "/nonexistent"),
      getAppPath: () => "/nonexistent",
      getVersion: () => app.version,
      getApplicationNameForProtocol: () => app.emailHandler,
      dock: { hide() {} },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        app.appEvents.set(event, handler);
      },
      quit() {
        app.quits += 1;
      },
      exit: (code: number) => {
        app.exits.push(code);
      },
      getLoginItemSettings: () => ({ openAtLogin: false }),
      hide: () => {
        app.hides += 1;
      },
    },
    BrowserWindow: { getFocusedWindow: () => null },
    Menu: {
      buildFromTemplate: (template: unknown[]) => template,
      setApplicationMenu: (menu: unknown[] | null) => {
        app.applicationMenu = menu;
      },
    },
    clipboard: {
      writeText: async (text: string) => {
        if (app.clipboardFails) throw new Error("the clipboard is busy");
        app.clipboard.push(text);
      },
    },
    screen: { screenToDipRect: (_window: unknown, rect: Rect) => rect, getCursorScreenPoint: () => ({ x: 100, y: 100 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    shell: {
      showItemInFolder: (path: string) => void app.shownFiles.push(path),
      openExternal: async (url: string) => {
        if (app.openFailure) throw app.openFailure;
        app.opened.push(url);
      },
    },
    systemPreferences: {},
    dialog: {
      showMessageBox: async (options: Record<string, unknown>) => {
        app.dialogs.push(options);
        app.dialogsAfterLaunch.push(app.handlers.has(channels.command));
        return { response: await (app.dialogResponses.shift() ?? app.dialogResponse) };
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
    kind = "mac";
    autoDownload = false;
    autoInstallOnAppQuit = false;
    allowDowngrade = true;
    disableWebInstaller = false;
    verifyUpdateCodeSignature: unknown = "the library's";
    logger: unknown = "the console";
    requestHeaders: Record<string, string> | null = null;
    checks = 0;
    installs = 0;
    installedWith: unknown[] = [];
    feed: unknown = null;
    setFeedURL(options: unknown) {
      this.feed = options;
    }
    checkForUpdates() {
      this.checks += 1;
      return new Promise(() => {});
    }
    quitAndInstall(...args: unknown[]) {
      this.installs += 1;
      this.installedWith = args;
    }
  }
  /** Windows' and Linux's updaters, which the app makes itself: the test reaches the last one made. */
  class NsisUpdater extends FakeAutoUpdater {
    constructor() {
      super();
      this.kind = "nsis";
      app.autoUpdater = this;
    }
  }
  /** The Linux AppImage's: it installs by replacing the AppImage, and says whether it did. */
  class AppImageUpdater extends FakeAutoUpdater {
    constructor() {
      super();
      this.kind = "appimage";
      app.autoUpdater = this;
    }
    install(...args: unknown[]) {
      this.installs += 1;
      this.installedWith = args;
      return true;
    }
  }
  // A fresh one for each test's launch: the mocked module outlives `vi.resetModules`.
  return {
    NsisUpdater,
    AppImageUpdater,
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
vi.mock("../../src/core/backend/http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/backend/http.js")>()),
  liveTransport: async (request: { url: string }) => {
    app.requests.push(request.url);
    throw new Error("no network in tests");
  },
}));
vi.mock("../../src/main/storage/jsonFileStore.js", async () => {
  const { join } = await import("node:path");
  return {
    /** Each file its own values, kept across launches: the app folder's preferences file is
     * `app.stored`, any other is in `app.files` by its path. As the real store, one that couldn't be
     * read (`app.problems`) starts at the defaults and keeps what is set for this launch only. */
    JSONFileStore: class {
      private values: Map<string, unknown>;
      private readonly file: Map<string, unknown>;
      private wasReset = false;
      problem: import("../../src/core/util/keyValueStore.js").StoreProblem | undefined;
      readonly isNew: boolean;
      constructor(private readonly path: string) {
        this.isNew = app.missingFiles.has(path);
        const file = path === join(app.userData, "settings.json") ? app.stored : (app.files.get(path) ?? new Map<string, unknown>());
        app.files.set(path, file);
        this.file = file;
        this.problem = app.problems.get(path);
        this.values = this.problem === undefined ? file : new Map<string, unknown>();
      }
      /** As the real store: the file moved aside (`app.movedAside`), the store afresh and saved again;
       * `app.moveAsideFails` makes the move fail, changing nothing. */
      moveAside(aside: string) {
        if (this.problem === undefined || app.moveAsideFails) throw new Error("not moved");
        app.movedAside.push({ path: this.path, aside });
        this.wasReset = true;
        this.file.clear();
        this.values = this.file;
        this.problem = undefined;
      }
      get(key: string) {
        // Set up, unless a test stores otherwise or the file was reset.
        if (key === "hasFinishedWelcome" && this.values === app.stored && !app.stored.has(key) && !this.wasReset) return true;
        return this.values.get(key);
      }
      set(key: string, value: unknown) {
        this.values.set(key, value);
        return this.problem === undefined && !app.savesFail;
      }
      setAll(values: Record<string, unknown>) {
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) this.values.delete(key);
          else this.values.set(key, value);
        }
        return this.problem === undefined && !app.savesFail;
      }
      remove(key: string) {
        this.values.delete(key);
      }
    },
  };
});
vi.mock("../../src/main/native/macos/osascript.js", () => ({
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
    constructor(readonly options: { name: string; executable: string; args?: string[]; restartExitCode?: number; stopEndsAtOnce?: boolean }) {
      app.helpers.set(options.name, this);
      this.replies.set("captureTarget", { window: options.name === "voice-screen-reader" ? "00000000-0000-0000-0000-000000000001" : 42, pid: 42 });
      this.replies.set("preparePaste", { transaction: 7 });
    }
    /** "start", "stop" and "restart", as the app called them. */
    readonly lifecycle: string[] = [];
    on(event: string, handler: (message: Record<string, unknown>) => void) {
      this.events.set(event, handler);
    }
    // As the real client: `onStart` runs as it starts, even with no executable to spawn.
    start() {
      this.lifecycle.push("start");
      this.onStart?.();
    }
    stop() {
      this.lifecycle.push("stop");
    }
    restart() {
      this.lifecycle.push("restart");
    }
    /** While set, a request waits until the test answers it, as a helper still applying it. */
    hold = false;
    readonly unanswered: { method: string; params: unknown; answer: (error?: Error) => void }[] = [];
    /** The helper's answer to a method, where the test gives one. */
    readonly replies = new Map<string, unknown>();
    async request(method: string, params?: unknown, _timeout?: number, signal?: AbortSignal) {
      this.requests.push({ method, params, ...(signal && { signal }) });
      if (this.hold) await new Promise<void>((resolve, reject) => this.unanswered.push({ method, params, answer: (error) => (error ? reject(error) : resolve()) }));
      if (method === "fullUserName" && app.fullName !== null) return { name: app.fullName };
      if (typeof this.replies.get(method) === "function") return (this.replies.get(method) as (params: unknown) => unknown)(params);
      return this.replies.has(method) ? this.replies.get(method) : { value: null, events: [], calendars: [], contacts: [], items: [] };
    }
  },
}));
vi.mock("../../src/main/native/memoryHelper.js", async (importOriginal) => {
  const { FakeMemory } = await import("../support/fakeMemory.js");
  return {
    ...(await importOriginal<typeof import("../../src/main/native/memoryHelper.js")>()),
    MemoryHelper: class extends FakeMemory {
      stops = 0;
      constructor(readonly options: { directory: string }) {
        super();
        app.memory = this;
      }
      stop() {
        this.stops += 1;
      }
    },
  };
});
vi.mock("../../src/core/dictation/controller.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/dictation/controller.js")>()),
  DictationController: class {
    constructor(dependencies: { warmUp: (baseURL: string, accessToken: string) => Promise<void>; makeTranscriptionClient: (baseURL: string) => import("../../src/core/backend/transcription.js").TranscriptionClient; makeCompletionsClient: (baseURL: string) => import("../../src/core/backend/completions.js").CompletionsClient; capture: AudioCapture; copy: (text: string) => Promise<boolean>; saveClipboard: () => void; paste: (text: string, signal: AbortSignal, target: number) => Promise<void>; history: NonNullable<typeof app.history>; connectorTools: typeof app.connectorTools; corrections?: typeof app.corrections; frontmostApp: NonNullable<typeof app.frontmostApp>; useWords: NonNullable<typeof app.useWords>; settings: NonNullable<typeof app.dictationSettings>; prompts: NonNullable<typeof app.prompts>; keepRecording?: typeof app.keepRecording }) {
      app.dictationSettings = dependencies.settings;
      app.backend = dependencies;
      app.keepRecording = dependencies.keepRecording;
      app.capture = dependencies.capture;
      app.prompts = dependencies.prompts;
      app.history = dependencies.history;
      app.corrections = dependencies.corrections;
      app.frontmostApp = dependencies.frontmostApp;
      app.useWords = dependencies.useWords;
      app.connectorTools = dependencies.connectorTools;
      app.paste = dependencies.paste;
      app.copy = dependencies.copy;
      app.saveClipboard = dependencies.saveClipboard;
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
    async copyNotPasted() {
      this.calls.push("copyNotPasted");
    }
    dismissNotPasted() {
      this.calls.push("dismissNotPasted");
    }
    closeChat() {
      this.calls.push("closeChat");
    }
    dismissChat() {
      this.calls.push("dismissChat");
    }
    answerConfirmation(confirmed: boolean) {
      this.calls.push(`answerConfirmation ${confirmed}`);
    }
    phase = { kind: "idle" };
    mode = "dictation";
    tools = [];
    connectors: string[] = [];
    recentBubbles: string[] = [];
    runningBubble: string | null = null;
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
    readonly pointers: boolean[] = [];
    isTakingClicks = false;
    constructor(_window: unknown, readonly locate: () => Promise<Rect | null>, readonly place?: (area: Rect) => Rect | null, _fallback?: unknown, readonly hitTest?: string) {
      app.overlay = this;
    }
    refreshPlacement() {
      app.placementAreas.push(this.place?.({ x: 0, y: 0, width: 1440, height: 900 }));
    }
    update(phase: { kind: string }, chatOpen = false) {
      this.updates.push([phase.kind, chatOpen]);
    }
    fitChat(height: number) {
      this.heights.push(height);
    }
    pointerOver(over: boolean) {
      this.pointers.push(over);
    }
    readonly drags: unknown[] = [];
    startChatDrag() {
      this.drags.push("start");
    }
    dragChat(delta: { x: number; y: number }) {
      this.drags.push(delta);
    }
  },
}));
vi.mock("../../src/main/tray.js", () => ({
  TrayMenu: class {
    constructor(_resources: string, state: () => { update: unknown; fileProblems?: unknown }, actions: NonNullable<typeof app.trayActions>) {
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
    showWelcome() {
      app.presented.push("welcome");
    }
    showSettings() {
      app.presented.push("settings");
    }
    showContextDebug() {
      app.presented.push("contextDebug");
    }
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
const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;

async function launch(platform: NodeJS.Platform, linuxExecutable = "/opt/TabMail Voice/tabmail-voice"): Promise<void> {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  // A Linux app runs from a POSIX path, whatever machine runs the tests (the Windows release build too).
  if (platform === "linux") Object.defineProperty(process, "execPath", { value: linuxExecutable, configurable: true });
  vi.resetModules();
  await import("../../src/main/index.js");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  Object.defineProperty(process, "execPath", execPathDescriptor);
  app.handlers.clear();
  app.listeners.clear();
  app.appEvents.clear();
  app.helpers.clear();
  app.capture = null;
  app.paste = null;
  app.copy = null;
  app.saveClipboard = null;
  app.corrections = undefined;
  app.frontmostApp = undefined;
  app.useWords = undefined;
  app.prewarms = 0;
  app.history = null;
  app.clipboard = [];
  app.clipboardFails = false;
  app.historyWindow = [];
  app.hides = 0;
  app.openWindows = [];
  app.historyBlur = null;
  app.audioCommands = [];
  app.placementAreas = [];
  app.overlay = null;
  app.controller = null;
  app.stored.clear();
  app.files.clear();
  app.savesFail = false;
  app.problems.clear();
  app.missingFiles.clear();
  app.shownFiles = [];
  app.opened = [];
  app.requests = [];
  app.openFailure = null;
  app.connectorTools = [];
  app.scripts = [];
  if (app.appData !== null) rmSync(app.appData, { recursive: true, force: true });
  app.appData = null;
  if (app.userData !== "/nonexistent") rmSync(app.userData, { recursive: true, force: true });
  app.userData = "/nonexistent";
  app.memory = null;
  app.prompts = null;
  app.fullName = null;
  app.trayActions = null;
  app.dictationSettings = null;
  app.keepRecording = undefined;
  app.presented = [];
  app.trayState = null;
  app.packaged = false;
  app.version = "0.0.0";
  app.credential = null;
  app.autoUpdater = null;
  app.squirrel = null;
  app.trayUpdates = 0;
  app.dialogs = [];
  app.dialogsAfterLaunch = [];
  app.dialogResponse = 1;
  app.dialogResponses = [];
  app.movedAside = [];
  app.moveAsideFails = false;
  app.exits = [];
  app.quits = 0;
  app.openDialogs = [];
  app.pickedPath = null;
});

/** Sends `command` to the main process as a window would. */
function send(command: unknown): Promise<unknown> {
  return Promise.resolve(app.handlers.get(channels.command)?.({}, command));
}

describe("main process wiring", () => {
test("the real capture pipeline reads the delayed captured identity in both scopes after focus changes", async () => {
  await launch("darwin");
  const reader = app.helpers.get("voice-screen-reader")!;
  const captured = { window: "00000000-0000-0000-0000-000000000001", pid: 42 };
  const identity = Promise.withResolvers<typeof captured>();
  reader.replies.set("captureTarget", identity.promise);
  let front = "Captured";
  reader.replies.set("readScreen", (params: { target?: typeof captured; wholeWindow?: boolean }) => blankScreen({
    appName: params.target?.window === captured.window ? "Captured" : front,
    renderedText: `${params.target?.window === captured.window ? "Captured" : front} ${params.wholeWindow ? "whole" : "shown"}`,
  }));
  const controller = app.controller as unknown as {
    captureContext: (policy: { apps: string[]; sites: string[] }, target: Promise<number | null>) => Promise<unknown>;
    captureWindow: (shown: Promise<unknown>) => Promise<unknown>;
  };
  const target = app.frontmostApp!();
  const shown = controller.captureContext({ apps: [], sites: [] }, target);
  expect(reader.requests.some(request => request.method === "readScreen")).toBe(false);
  front = "Competing";
  identity.resolve(captured);
  expect(await shown).toMatchObject({ renderedText: "Captured shown" });
  const whole = await controller.captureWindow(shown);
  expect(whole).toMatchObject({ renderedText: "Captured whole" });
  expect(JSON.stringify([await shown, whole])).not.toContain("Competing");
});


  test("shell geometry events move, hide and restore active overlay placement", async () => {
    await launch("win32");
    const helper = app.helpers.get("voice-windows")!;
    const emit = () => helper.events.get("shellGeometryChanged")?.({ event: "shellGeometryChanged" });
    helper.replies.set("shellExclusionBounds", [{ x: 0, y: 0, width: 700, height: 900 }]);
    emit();
    await vi.waitFor(() => expect(app.placementAreas).toEqual([{ x: 724, y: 0, width: 716, height: 900 }]));
    helper.replies.set("shellExclusionBounds", [{ x: 0, y: 0, width: 1440, height: 900 }]);
    emit();
    await vi.waitFor(() => expect(app.placementAreas.at(-1)).toBeNull());
    helper.replies.set("shellExclusionBounds", []);
    emit();
    await vi.waitFor(() => expect(app.placementAreas).toEqual([
      { x: 724, y: 0, width: 716, height: 900 }, null, { x: 0, y: 0, width: 1440, height: 900 },
    ]));
    const queries = () => helper.requests.filter((request) => request.method === "shellExclusionBounds").length;
    const before = queries();
    emit();
    await vi.waitFor(() => expect(queries()).toBe(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.placementAreas).toHaveLength(3);
  });

  /** Launching prepares the microphone ahead of the first dictation, once, on every platform: the
   * helper's prepared engine on macOS, the audio window's worklet elsewhere (through `onStart`,
   * which runs even where `voice-macos` can't spawn). */
  test.each(["darwin", "win32", "linux"] as const)("launching on %s prepares the microphone once", async (platform) => {
    await launch(platform);
    expect(app.prewarms).toBe(1);
  });

  /** In the Dock while Settings is open (ADR-DESK-065), the Mac app has the menu bar: its own menu,
   * Edit (copy and paste in the fields) and Window, never Electron's default with its View (reload,
   * developer tools) and Help (Electron's website). Windows and Linux are left as they were. */
  test.each(["darwin", "win32", "linux"] as const)("the application menu on %s", async (platform) => {
    app.applicationMenu = null;
    await launch(platform);
    expect(app.applicationMenu).toEqual(platform === "darwin" ? [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }] : null);
  });

  /** A `voice-microphone` that (re)starts, as it does after each dictation, gets the
   * microphone prepared again, ahead of the next dictation; a `voice-macos` that does gets its
   * activator started, and leaves the microphone, which isn't its own, alone. The app starts
   * `voice-microphone` afresh at once when it exits with the code it ends itself with. */
  test("a restarted voice-microphone prepares the microphone again, and a restarted voice-macos only starts its activator", async () => {
    await launch("darwin");
    const microphone = app.helpers.get("voice-microphone");
    const helper = app.helpers.get("voice-macos");
    const before = app.prewarms;
    microphone?.onStart?.();
    expect(app.prewarms).toBe(before + 1);

    const activators = () => helper?.requests.filter((request) => request.method === "startActivator").length ?? 0;
    const started = activators();
    helper?.onStart?.();
    expect(app.prewarms).toBe(before + 1);
    expect(activators()).toBe(started + 1);
    expect(microphone?.options).toMatchObject({ restartExitCode: config.microphoneHelperRestartExitCode });
    expect(helper?.options).not.toHaveProperty("restartExitCode");
  });

  /** Every platform runs `voice-microphone`, a helper of its own (`voice-microphone.exe` on
   * Windows), started afresh at once when it exits with its restart code; a restart prepares the
   * microphone again, and a restart of the platform helper does not. */
  test.each(["win32", "linux"] as const)("on %s the microphone is voice-microphone's, prepared again when it restarts", async (platform) => {
    await launch(platform);
    const microphone = app.helpers.get("voice-microphone");
    expect(microphone?.options).toMatchObject({ restartExitCode: config.microphoneHelperRestartExitCode, executable: expect.stringMatching(platform === "win32" ? /voice-microphone\.exe$/ : /voice-microphone$/) });
    const before = app.prewarms;
    microphone?.onStart?.();
    expect(app.prewarms).toBe(before + 1);
    app.helpers.get(platform === "win32" ? "voice-windows" : "voice-linux")?.onStart?.();
    expect(app.prewarms).toBe(before + 1);
  });

  /** A dictation's microphone runs in `voice-microphone` on every platform: the capture's start is
   * its `microphoneStart`, for the dictation's session at the recording rate, and its stop the
   * matching `microphoneStop`; the helper's answer and its chunk events reach the dictation, and the
   * helper exiting under it is the dictation's microphone lost. The platform helper is never asked
   * for the microphone, nor its exit taken for a lost one. */
  test.each(["darwin", "win32", "linux"] as const)("on %s capture uses voice-microphone", async (platform) => {
    await launch(platform);
    const helper = app.helpers.get("voice-microphone");
    const platformHelper = app.helpers.get(platform === "win32" ? "voice-windows" : platform === "linux" ? "voice-linux" : "voice-macos");
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
    expect(app.audioCommands).toEqual([]);
    expect(completions).toEqual([null]);
    expect(chunks).toEqual([samples]);
    platformHelper?.onExit?.();
    expect(losses).toBe(0);
    helper?.onExit?.();
    expect(losses).toBe(1);
    capture?.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const microphone = helper?.requests.filter((request) => request.method.startsWith("microphone") && request.method !== "microphonePrepare") ?? [];
    expect(microphone).toEqual([
      { method: "microphoneStart", params: { session: 1, sampleRate: config.recordingSampleRate } },
      { method: "microphoneStop", params: { session: 1 } },
    ]);
    expect(platformHelper?.requests.filter((request) => request.method.startsWith("microphone"))).toEqual([]);
  });

  /** A dictation's paste reaches `voice-macos` with the dictation's session and signal, so a paste waiting out a
   * helper restart is called off when the dictation is. */
  test("a dictation's paste carries its signal to voice-macos", async () => {
    await launch("darwin");
    const helper = app.helpers.get("voice-macos");
    const { signal } = new AbortController();

    const target = await app.frontmostApp!();
    await app.paste?.("Hello.", signal, target!);

    const inserts = helper?.requests.filter((request) => request.method === "preparePaste") ?? [];
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.signal).toBe(signal);
    expect(inserts[0]?.params).toMatchObject({ text: "Hello." });
  });

  /** The chat window takes clicks only where it is, by the pointer's moves where a click-through
   * window still gets them (macOS, Windows); over the overlay's whole frame on Linux, where it
   * doesn't. */
  test.each([["darwin", "pointer"], ["win32", "pointer"], ["linux", "frame"]] as const)("on %s the chat window takes clicks by its %s", async (platform, hitTest) => {
    await launch(platform);
    expect(app.overlay?.hitTest).toBe(hitTest);
  });

  test("on Linux, Right Alt the Shell can't hold reaches the open Settings window", async () => {
    await launch("linux");
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as { hotkeyUnavailable?: boolean };
    expect(state().hotkeyUnavailable).toBeUndefined();
    const pushed: unknown[] = [];
    app.listeners.set("voice:state", [(_event, name, pushedState) => { if (name === "settings") pushed.push((pushedState as { hotkeyUnavailable?: boolean }).hotkeyUnavailable); }]);
    app.helpers.get("voice-hotkey")!.events.get("hotkeyUnavailable")?.({ event: "hotkeyUnavailable" });
    expect(pushed).toEqual([true]);
    expect(state().hotkeyUnavailable).toBe(true);
  });

  test("Linux placement prefers the focused element's caret over compositor geometry; the screen is read elsewhere", async () => {
    await launch("linux");
    const accessible = app.helpers.get("voice-linux")!, compositor = app.helpers.get("voice-hotkey")!, reader = app.helpers.get("voice-screen-reader")!;
    reader.replies.set("readScreen", null);
    const before = { accessible: accessible.requests.length, compositor: compositor.requests.length };
    const caret = app.overlay!.locate();
    const capture = app.controller as unknown as { captureContext: (exclusions: { apps: string[]; sites: string[] }) => Promise<unknown> };
    await capture.captureContext({ apps: [], sites: [] });
    const dispatched = accessible.requests.slice(before.accessible).map(request => request.method);
    expect.soft(dispatched).toEqual(["caretAnchor"]);
    expect.soft(reader.requests.map(request => request.method)).toEqual(["readScreen"]);
    expect.soft(compositor.requests.slice(before.compositor)).toEqual([{ method: "caretAnchor", params: {}, signal: undefined }]);
    expect(await caret).toBeNull();
    compositor.replies.set("caretAnchor", { x: 200, y: 300, width: 1, height: 20 });
    expect(await app.overlay?.locate()).toEqual({ x: 200, y: 300, width: 1, height: 20 });
    accessible.replies.set("caretAnchor", { x: 640, y: 300, width: 2, height: 19 });
    expect(await app.overlay?.locate()).toEqual({ x: 640, y: 300, width: 2, height: 19 });
  });

  test("Windows paste keeps its original window and uses the cancellable Windows helper", async () => {
    await launch("win32");
    const helper = app.helpers.get("voice-windows");
    const target = await app.frontmostApp!();
    await app.paste?.("Synthetic text", signal, target!);
    expect(helper?.requests.find((request) => request.method === "insert")).toMatchObject({
      params: { text: "Synthetic text", target: { window: 42, pid: 42 }, deadline: expect.any(Number) }, signal,
    });
    expect(helper?.requests.map((request) => request.method)).not.toContain("startActivator");
    expect(app.helpers.get("voice-macos")?.requests).toEqual([]);
  });

  /** The clipboard is saved for the paste to put back by the helper that pastes, never waited for
   * (ADR-DESK-002); a save that fails is only logged. */
  test.each([["darwin", "voice-macos"], ["win32", "voice-windows"], ["linux", "voice-linux"]] as const)("on %s the clipboard is saved by %s", async (platform, name) => {
    await launch(platform);
    const helper = app.helpers.get(name);
    app.saveClipboard?.();
    expect(helper?.requests.filter((request) => request.method === "clipboardSave")).toHaveLength(1);
  });

  /** A text not pasted (ADR-DESK-042) goes on the clipboard when its note is clicked, and the
   * controller hears it is there. */
  test("a text not pasted is copied", async () => {
    await launch("darwin");

    expect(await app.copy?.("Hello.")).toBe(true);
    expect(app.clipboard).toEqual(["Hello."]);
  });

  /** Electron 44's clipboard write is a promise: a refused one is logged, never left unhandled, and
   * the controller hears it isn't there, for the note to say so. */
  test("a clipboard write that fails is logged", async () => {
    await launch("darwin");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      app.clipboardFails = true;
      expect(await app.copy?.("Hello.")).toBe(false);
      expect(app.clipboard).toEqual([]);
      expect(stderr).toHaveBeenCalledWith("main: couldn't copy to the clipboard: Error\n");
    } finally {
      stderr.mockRestore();
    }
  });

  test.each(["darwin", "win32", "linux"] as const)("history preserves inset bounds through opening, fitting and reopening on %s", async (platform) => {
    await launch(platform);
    const { Windows } = await import("../../src/main/windows.js");
    const { pillPosition } = await import("../../src/core/ui/overlayGeometry.js");
    const show = vi.spyOn(Windows.prototype, "showHistory");
    const fit = vi.spyOn(Windows.prototype, "fitHistory");
    const margin = config.pasteHistoryShadowMargin;
    for (const width of [240, 325, 1440]) {
      const workArea = { x: -1500, y: -200, width, height: 900 };
      for (const x of [workArea.x, workArea.x + width]) {
        for (const y of [-150, 600]) {
          const pill = pillPosition({ x, y, width: 1, height: 20 }, workArea);
          Object.assign(app.overlay!, { pillPlace: { pill, workArea, bubblesUnder: y < 0 } });
          app.controller?.onShowHistory?.();
          const opening = show.mock.calls.at(-1)![0];
          const cardWidth = Math.min(config.pasteHistoryWindowWidth, width - 2 * config.overlayEdgeInset);
          expect(opening.width).toBe(cardWidth + 2 * margin);
          expect(opening.x + margin).toBeGreaterThanOrEqual(workArea.x + config.overlayEdgeInset);
          expect(opening.x + opening.width - margin).toBeLessThanOrEqual(workArea.x + width - config.overlayEdgeInset);
          await send({ type: "historyHeight", height: 120 });
          const measured = fit.mock.calls.at(-1)![0];
          expect([measured.x, measured.width]).toEqual([opening.x, opening.width]);
          app.controller?.onShowHistory?.();
          expect(show.mock.calls.at(-1)![0]).toEqual(measured);
          expect(app.clipboard).toEqual([]);
          await send({ type: "closeHistory" });
          expect(app.historyWindow.at(-1)).toBe("close");
        }
      }
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
    // Its card over the pill (its top edge's center at 700,600, the bubbles under it), the pill's gap
    // clear; the window around it larger on each side by the margin its glow takes.
    const margin = config.pasteHistoryShadowMargin;
    const around = (x: number, y: number, height: number) => `show ${x - margin},${y - margin} ${config.pasteHistoryWindowWidth + 2 * margin}x${height + 2 * margin}`;
    const top = 600 - config.chatPillGap - config.pasteHistoryMaxHeight;
    expect(app.historyWindow).toEqual([around(700 - config.pasteHistoryWindowWidth / 2, top, config.pasteHistoryMaxHeight)]);
    await send({ type: "historyHeight", height: 120 });
    await send({ type: "historyHeight", height: config.pasteHistoryMaxHeight + 100 });
    expect(app.historyWindow.slice(1)).toEqual([`history height ${120 + 2 * margin}`, `history height ${config.pasteHistoryMaxHeight + 2 * margin}`]);

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
    expect(app.historyWindow.at(-1)).toMatch(new RegExp(` \\d+x${150 + 2 * margin}$`));

    // With the bubbles over the pill (by the bottom of the screen), it opens over them, as the chat
    // would, never over the pill alone where it would cover them (red-verified).
    (app.overlay as unknown as { pillPlace: { bubblesUnder: boolean } }).pillPlace.bubblesUnder = false;
    app.controller?.onShowHistory?.();
    const overBubbles = 600 - config.agentBubbleGap - config.agentBubbleDiameter - config.chatPillGap - 150;
    expect(app.historyWindow.at(-1)).toBe(around(700 - config.pasteHistoryWindowWidth / 2, overBubbles, 150));

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

  /** The overlay is told whether a voice is heard and whether a transcription is being tried again,
   * as the controller says: its waveform takes its recording colour and its thinking circle turns toward purple by them (owner, 2026-10-02). */
  test("the overlay is told of a voice heard and of a retry", async () => {
    await launch("darwin");
    const pushed: [boolean, boolean][] = [];
    app.listeners.set("voice:state", [
      (_event, name, state) => {
        const overlayState = state as { hasVoice: boolean; isRetrying: boolean };
        if (name === "overlay") pushed.push([overlayState.hasVoice, overlayState.isRetrying]);
      },
    ]);
    const controller = app.controller;
    expect(controller).not.toBeNull();
    for (const [hasVoice, isRetrying] of [[true, false], [false, true], [true, true]] as const) {
      if (controller) Object.defineProperties(controller, { hasVoice: { value: hasVoice, configurable: true }, isRetrying: { value: isRetrying, configurable: true } });
      app.overlay?.onPlace?.();
    }
    expect(pushed).toEqual([[true, false], [false, true], [true, true]]);
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

  /** While the chat window is open, a click elsewhere and another app in front close it, through the
   * controller, which keeps it unless idle; with Settings' switch off, neither closes anything
   * (ADR-DESK-022). macOS and Windows tell every click, so one the overlay takes (on the chat) closes
   * nothing; GNOME tells only clicks elsewhere, and its overlay frame takes every click on it, so
   * there a click told closes the chat whatever the overlay takes. */
  test.each(["darwin", "win32", "linux"] as const)("a click elsewhere or an app switch closes the chat window, on %s", async (platform) => {
    await launch(platform);
    const hotkey = app.helpers.get("voice-hotkey");
    const controller = app.controller;
    const overlay = app.overlay;
    if (!hotkey || !controller || !overlay) throw new Error("not launched");
    const click = () => hotkey.events.get("chatMouseDown")?.({ event: "chatMouseDown" });
    const appSwitch = () => hotkey.events.get("chatFocusChanged")?.({ event: "chatFocusChanged" });
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as { closesChatElsewhere: boolean };
    expect(state().closesChatElsewhere).toBe(true);

    overlay.isTakingClicks = true;
    click();
    const told = platform === "linux" ? ["dismissChat"] : [];
    expect(controller.calls).toEqual(told);
    overlay.isTakingClicks = false;
    click();
    appSwitch();
    expect(controller.calls).toEqual([...told, "dismissChat", "dismissChat"]);

    expect(await send({ type: "setClosesChatElsewhere", value: false })).toEqual({ error: null });
    expect(state().closesChatElsewhere).toBe(false);
    expect(app.stored.get("closesChatElsewhere")).toBe(false);
    overlay.isTakingClicks = false;
    click();
    appSwitch();
    expect(controller.calls).toEqual([...told, "dismissChat", "dismissChat"]);
    // Switched on again: both close it again.
    expect(await send({ type: "setClosesChatElsewhere", value: true })).toEqual({ error: null });
    expect(state().closesChatElsewhere).toBe(true);
    expect(app.stored.get("closesChatElsewhere")).toBe(true);
    click();
    appSwitch();
    expect(controller.calls).toEqual([...told, "dismissChat", "dismissChat", "dismissChat", "dismissChat"]);
    expect(await send({ type: "setClosesChatElsewhere", value: "no" } as never)).toEqual({ error: expect.any(String) });
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
   * running bubble. */
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
    controller.runningBubble = "web";
    const placement = { below: false, maxHeight: config.chatMaxHeight, bubblesUnder: true, pillX: 206 };
    overlay.chatPlacement = placement;
    expect(state()).toMatchObject({ chat, chatPlacement: placement, recentBubbles: ["web", "answer"], runningBubble: "web" });
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
    await send({ type: "pointerOver", over: true });
    await send({ type: "pointerOver", over: false });
    expect(await send({ type: "pointerOver", over: "yes" } as never)).toEqual({ error: expect.any(String) });
    await send({ type: "chatDragStart" });
    await send({ type: "dragChat", dx: 12, dy: -30 });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(await send({ type: "dragChat", dx: bad, dy: 0 })).toEqual({ error: expect.any(String) });
      expect(await send({ type: "dragChat", dx: 0, dy: bad })).toEqual({ error: expect.any(String) });
    }
    expect(await send({ type: "dragChat", dx: 1 } as never)).toEqual({ error: expect.any(String) });
    expect(app.overlay?.drags).toEqual(["start", { x: 12, y: -30 }]);
    await send({ type: "openChatLink", url: "https://example.com/closed" });
    if (controller) controller.chat = {};
    await send({ type: "openChatLink", url: "https://example.com/docs" });
    await send({ type: "openChatLink", url: "file:///Applications/Calculator.app" });

    expect(controller?.calls).toEqual(["keepChatOpen", "closeChat", "answerConfirmation true", "answerConfirmation false"]);
    expect(app.overlay?.heights).toEqual([180]);
    expect(app.overlay?.pointers).toEqual([true, false]);
    // macOS forwards the pointer's moves through a click-through window; Linux can't (`ChatHitTest`).
    expect(app.overlay?.hitTest).toBe("pointer");
    expect(app.opened).toEqual(["https://example.com/docs"]);
  });

  /** The note for a text not pasted: a click reaches the controller, which copies the text, and its
   * x, which dismisses it. */
  test("the not-pasted note's commands", async () => {
    await launch("darwin");

    await send({ type: "copyNotPasted" });
    await send({ type: "dismissNotPasted" });

    expect(app.controller?.calls).toEqual(["copyNotPasted", "dismissNotPasted"]);
  });

  /** The note for a text not pasted reaches the overlay's page with the whole text it shows and a
   * click copies, under the message; showing it copies nothing, and the copy writes that whole text. */
  test("the not-pasted note's text reaches the overlay", async () => {
    await launch("darwin");
    const states: unknown[] = [];
    app.listeners.set("voice:state", [
      (_event, name, state) => {
        if (name === "overlay") states.push(state);
      },
    ]);
    const text = "Move the review to Friday.\nAnd send the agenda tonight.";
    const note = { kind: "notPasted", message: "Couldn't paste. Click to copy.", text };
    if (app.controller) app.controller.phase = note;

    app.overlay?.onPlace?.();
    expect(states).toEqual([expect.objectContaining({ phase: note })]);
    expect(app.clipboard).toEqual([]);
    expect(await app.copy?.(text)).toBe(true);
    expect(app.clipboard).toEqual([text]);
  });

  /** An agent tool's switch is stored and shows in the Settings and welcome windows; a name that is
   * no switchable agent tool (Answer has none), or a value that is no boolean (even one that reads as
   * on or off), is refused and changes nothing. */
  test("an agent tool's switch", async () => {
    await launch("darwin");
    const state = (name: string) => app.handlers.get(channels.getState)?.({}, name) as { enabledTools: string[] };

    expect(await send({ type: "setAgentToolEnabled", tool: "compose", value: false })).toEqual({ error: null });
    for (const value of ["false", "true", 1, null]) {
      expect(await send({ type: "setAgentToolEnabled", tool: "compose", value })).toEqual({ error: expect.any(String) });
    }
    expect(state("settings").enabledTools).toEqual(["edit"]);
    expect(await send({ type: "setAgentToolEnabled", tool: "compose", value: true })).toEqual({ error: null });
    expect(state("settings").enabledTools).toEqual(["edit", "compose"]);
    expect(await send({ type: "setAgentToolEnabled", tool: "compose", value: false })).toEqual({ error: null });
    expect(await send({ type: "setAgentToolEnabled", tool: "retired-tool", value: false })).toEqual({ error: expect.any(String) });
    // Answer has no switch, nor has Thunderbird's tool while it isn't offered (ADR-DESK-037): one sent
    // anyway is refused and changes nothing.
    expect(await send({ type: "setAgentToolEnabled", tool: "answer", value: false })).toEqual({ error: expect.any(String) });
    expect(await send({ type: "setAgentToolEnabled", tool: "thunderbird", value: false })).toEqual({ error: expect.any(String) });

    expect(state("settings").enabledTools).toEqual(["edit"]);
    expect(state("welcome").enabledTools).toEqual(["edit"]);
  });

  /** On macOS the Answer tool reaches Calendar, Reminders, Contacts and Files through `voice-macos`,
   * the email app, Notes and Messages through osascript, and the web with pages opened in the browser, and each has a switch, stored and shown in the Settings
   * and welcome windows; a name that is no app is refused. */
  test("on macOS, Calendar, Reminders, Contacts, Files, Email, Notes, Messages and Web and their switches", async () => {
    await launch("darwin");
    const state = (name: string) => app.handlers.get(channels.getState)?.({}, name) as { connectors: string[]; enabledConnectors: string[] };

    expect(app.connectorTools.map((tool) => tool.name)).toEqual(["calendar_read", "calendar_event_create", "calendar_event_read", "calendar_event_edit", "calendar_event_delete", "reminders_read", "reminder_create", "contacts_search", "contacts_add", "files_search", "file_open", "file_read_pdf", "email_compose", "notes_search", "notes_create", "messages_send", "web_read", "web_open", "change_setting"]);
    // Every app with a switch has its tools, and every tool's app a switch.
    expect(new Set(app.connectorTools.map((tool) => tool.connector))).toEqual(new Set(connectorIDs));
    await app.connectorTools.find((tool) => tool.name === "calendar_read")?.run({}, signal, toolSettings);
    await app.connectorTools.find((tool) => tool.name === "contacts_search")?.run({ query: "Sam" }, signal, toolSettings);
    await app.connectorTools.find((tool) => tool.name === "files_search")?.run({ query: "tax" }, signal, toolSettings);
    expect(app.helpers.get("voice-macos")?.requests.map((request) => request.method)).toEqual(expect.arrayContaining(["calendarEvents", "calendars", "contactsSearch", "filesSearch"]));
    await app.connectorTools.find((tool) => tool.name === "notes_search")?.run({ query: "offsite" }, signal, toolSettings);
    await app.connectorTools.find((tool) => tool.name === "messages_send")?.run({ to: "sam@example.com", text: "Hi" }, signal, toolSettings);
    expect(app.scripts.map((script) => script.args)).toEqual([["offsite"], ["sam@example.com", "Hi"]]);
    await app.connectorTools.find((tool) => tool.name === "web_open")?.run({ url: "https://example.com/page" }, signal, toolSettings);
    expect(app.opened).toEqual(["https://example.com/page"]);

    expect(await send({ type: "setConnectorEnabled", connector: "calendar", value: false })).toEqual({ error: null });
    expect(await send({ type: "setConnectorEnabled", connector: "retired-app", value: false })).toEqual({ error: expect.any(String) });
    for (const name of ["settings", "welcome"]) {
      expect(state(name).connectors).toEqual(["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web", "settings"]);
      expect(state(name).enabledConnectors).toEqual(["reminders", "contacts", "files", "email", "notes", "messages", "web", "settings"]);
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

  /** The debug items and the last recording follow debug mode in a packaged build (ADR-DESK-018,
   * amended 2026-10-27): the menu shows them while it is on, a dictation keeps its audio only if it
   * started with it on, and switching it off (or signing out) deletes the file. */
  describe("debug mode in a packaged build", () => {
    let folder: string;
    const lastRecording = () => join(folder, config.debugLastRecordingFileName);
    const signIn = (email: string) => {
      app.credential = JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "user", email } });
    };
    const menuDebugMode = () => (app.trayState?.() as unknown as { debugMode: boolean }).debugMode;
    const gone = () => vi.waitFor(() => expect(existsSync(lastRecording())).toBe(false));

    beforeEach(() => {
      folder = mkdtempSync(join(tmpdir(), "voice-debug-mode-"));
      vi.doMock("node:os", async () => ({ ...await vi.importActual<typeof import("node:os")>("node:os"), tmpdir: () => folder }));
      app.packaged = true;
      Object.defineProperty(process, "resourcesPath", { value: "/nonexistent", configurable: true });
    });

    afterEach(() => {
      vi.doUnmock("node:os");
      rmSync(folder, { recursive: true, force: true });
    });

    test("on: the menu shows the debug items and a dictation keeps its recording", async () => {
      app.stored.set("debugMode", true);
      signIn("tester@tabmail.ai");
      await launch("darwin");
      expect(menuDebugMode()).toBe(true);
      expect(app.dictationSettings?.().keepsRecording).toBe(true);
      expect(app.trayActions?.debug.hasLastRecording()).toBe(false);

      app.keepRecording?.(Uint8Array.from([1, 2, 3]));
      await vi.waitFor(() => expect(readFileSync(lastRecording())).toEqual(Buffer.from([1, 2, 3])));
      expect(app.trayActions?.debug.hasLastRecording()).toBe(true);
    });

    test("switching it off hides the items, keeps no more and deletes the file; on again keeps again", async () => {
      app.stored.set("debugMode", true);
      signIn("tester@tabmail.ai");
      await launch("darwin");
      app.keepRecording?.(Uint8Array.from([1]));
      await vi.waitFor(() => expect(existsSync(lastRecording())).toBe(true));

      expect(await send({ type: "setDebugMode", value: false })).toEqual({ error: null });
      expect(menuDebugMode()).toBe(false);
      expect(app.dictationSettings?.().keepsRecording).toBe(false);
      await gone();

      expect(await send({ type: "setDebugMode", value: true })).toEqual({ error: null });
      expect(menuDebugMode()).toBe(true);
      expect(app.dictationSettings?.().keepsRecording).toBe(true);
    });

    /** Everything behind the debug items goes when debug mode does: the sample tip, the last screen
     * context (and the window showing it is redrawn), and a recording whose dictation started in
     * debug mode but ends after it went off. */
    test("switching it off clears the smoke tip and the last screen context, and keeps no recording still in progress", async () => {
      app.stored.set("debugMode", true);
      signIn("tester@tabmail.ai");
      await launch("darwin");
      const contextShown = () => (app.handlers.get(channels.getState)?.({}, "contextDebug") as { context: unknown }).context;
      app.helpers.get("voice-screen-reader")!.replies.set("readScreen", () => blankScreen({ appName: "Shown", renderedText: "Shown" }));
      const controller = app.controller as unknown as { captureContext: (policy: { apps: string[]; sites: string[] }) => Promise<unknown> };
      await controller.captureContext({ apps: [], sites: [] });
      expect(contextShown()).not.toBeNull();
      app.trayActions?.debug.toggleSmokeTip();
      expect(app.trayActions?.debug.showsSmokeTip()).toBe(true);
      const pushed: string[] = [];
      app.listeners.set("voice:state", [...(app.listeners.get("voice:state") ?? []), (...args: unknown[]) => void pushed.push(String(args[1]))]);

      expect(await send({ type: "setDebugMode", value: false })).toEqual({ error: null });
      expect(contextShown()).toBeNull();
      expect(app.trayActions?.debug.showsSmokeTip()).toBe(false);
      expect(pushed).toEqual(expect.arrayContaining(["contextDebug", "overlay"]));

      // The dictation that started with debug mode on ends now: nothing is kept.
      app.keepRecording?.(Uint8Array.from([1]));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(lastRecording())).toBe(false);
    });

    test("on at launch, and an unrelated settings change while on, keep the file", async () => {
      writeFileSync(lastRecording(), "audio");
      app.stored.set("debugMode", true);
      signIn("tester@tabmail.ai");
      await launch("darwin");
      expect(await send({ type: "setSmartDictation", value: true })).toEqual({ error: null });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readFileSync(lastRecording(), "utf8")).toBe("audio");
      expect(app.trayActions?.debug.hasLastRecording()).toBe(true);
    });

    test("signing out deletes the file: no account is allowed debug mode", async () => {
      app.stored.set("debugMode", true);
      signIn("tester@tabmail.ai");
      await launch("darwin");
      app.keepRecording?.(Uint8Array.from([1]));
      await vi.waitFor(() => expect(existsSync(lastRecording())).toBe(true));

      expect(await send({ type: "signOut" })).toEqual({ error: null });
      expect(menuDebugMode()).toBe(false);
      await gone();
    });

    test("off at launch (switch off, or an account not allowed) deletes a file left from before", async () => {
      for (const [email, switchOn] of [["tester@tabmail.ai", false], ["tester@example.com", true]] as const) {
        writeFileSync(lastRecording(), "audio");
        app.stored.set("debugMode", switchOn);
        signIn(email);
        await launch("darwin");
        expect(menuDebugMode()).toBe(false);
        expect(app.dictationSettings?.().keepsRecording).toBe(false);
        await gone();
      }
    });
  });

  /** Settings › General shows the app's own version. */
  test("the settings state carries the app's version", async () => {
    app.version = "9.8.7";
    await launch("darwin");
    expect((app.handlers.get(channels.getState)?.({}, "settings") as { version: string }).version).toBe("9.8.7");
  });

  /** Settings › Dictionary's commands change the stored dictionary and the learning switch, which the
   * state shows; learning is offered where the native helper reads the field (ADR-DESK-038). */
  test.each(["darwin", "win32", "linux"] as const)("the dictionary's commands and state, on %s", async (platform) => {
    await launch(platform);
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as { dictionary: unknown; learnsWords: boolean; canLearnWords: boolean };
    expect(state()).toMatchObject({ dictionary: [], learnsWords: true, canLearnWords: true });

    expect(await send({ type: "addDictionaryWord", word: " Xyvora " })).toEqual({ error: null });
    expect(await send({ type: "addDictionaryWord", word: "TabMail" })).toEqual({ error: null });
    expect(await send({ type: "removeDictionaryWord", word: "TabMail" })).toEqual({ error: null });
    expect(await send({ type: "setLearnsWords", value: false })).toEqual({ error: null });

    expect(state()).toMatchObject({ dictionary: [{ word: "Xyvora", learned: false, lastUsed: 1 }], learnsWords: false });
    expect(app.stored.get("dictionary")).toEqual([{ word: "Xyvora", learned: false, lastUsed: 1 }]);
    expect(app.stored.get("learnsWords")).toBe(false);
  });

  /** On every platform the correction watch reads the field through `voice-field-reader`, never the
   * main helper that pastes, and learns into the stored dictionary. */
  test.each([
    ["darwin", "voice-macos", "voice-field-reader"],
    ["win32", "voice-windows", "voice-field-reader.exe"],
    ["linux", "voice-linux", "voice-field-reader"],
  ] as const)("the correction watch's wiring, on %s", async (platform, mainName, executable) => {
    await launch(platform);
    const reader = app.helpers.get("voice-field-reader")!;
    const main = app.helpers.get(mainName)!;
    expect(reader.options).toMatchObject({ stopEndsAtOnce: true });
    expect(reader.options.args ?? []).toEqual([]);
    expect(basename(reader.options.executable)).toBe(executable);
    expect(dirname(reader.options.executable)).toBe(dirname(main.options.executable));
    expect(reader.lifecycle).toEqual(["start"]);
    // Its two dependencies, as the watch calls them, on the paste's own target: the app or window the
    // main helper names at key-down, which the field reader names by the identity both share (the
    // process on macOS and Linux, where the main helper's window token is its own; the window's handle
    // on Windows).
    const watch = app.corrections as unknown as { field: { value: (target: number, exclusions: { apps: string[]; sites: string[] }) => Promise<string | null> }; learn: (words: string[]) => void };
    app.helpers.get(platform === "darwin" ? "voice-screen-reader" : mainName)!.replies.set("captureTarget", { window: platform === "darwin" ? "00000000-0000-0000-0000-000000000001" : 42, pid: platform === "linux" ? 4242 : 42 });
    const target = await app.frontmostApp!();
    expect(target).toBe(1);
    await watch.field.value(target!, { apps: ["org.example.vault"], sites: ["example.com"] });
    expect(reader.requests.filter((request) => request.method === "focusedFieldValue").map((request) => request.params)).toStrictEqual([
      { ...{ darwin: { pid: 42 }, win32: { window: 42 }, linux: { pid: 4242 } }[platform], maxLength: config.correctionMaxFieldLength, excludedAppIDs: ["org.example.vault"], excludedHosts: ["example.com"] },
    ]);
    if (platform === "linux") {
      // A token the main helper did not name last has no process here: nothing is read.
      expect(await watch.field.value(43, { apps: [], sites: [] })).toBeNull();
      expect(reader.requests.filter((request) => request.method === "focusedFieldValue")).toHaveLength(1);
    }
    expect(reader.requests.some((request) => request.method === "frontmostApp")).toBe(false);
    expect(main.requests.some((request) => request.method === "focusedFieldValue")).toBe(false);
    watch.learn(["Xyvora"]);
    expect(app.stored.get("dictionary")).toEqual([{ word: "Xyvora", learned: true, lastUsed: 1 }]);

    app.appEvents.get("before-quit")?.({ preventDefault() {} });
    await vi.waitFor(() => expect(reader.lifecycle).toEqual(["start", "stop"]));
  });

  /** A dictation's text reaches the settings, marking the dictionary's words in it used (ADR-DESK-038,
   * Amendment 2026-10-02): unwired, a full dictionary would drop the words the user says most. */
  test("the controller marks the dictionary's words used in the settings", async () => {
    await launch("darwin");
    (app.corrections as unknown as { learn: (words: string[]) => void }).learn(["Xyvora"]);
    app.useWords?.(["ask xyvora about it"]);
    expect(app.stored.get("dictionary")).toEqual([{ word: "Xyvora", learned: true, lastUsed: 2 }]);
  });

  /** The apps and websites a dictation excludes from screen reading reach `voice-screen-reader` with the screen
   * read, as the controller hands them over (ADR-DESK-045, ADR-DESK-047): dropped anywhere on the way, the
   * helper would read a password manager in front. */
  test("the screen read carries the dictation's excluded apps and websites to voice-screen-reader", async () => {
    await launch("darwin");
    const controller = app.controller as unknown as { captureContext: (exclusions: { apps: string[]; sites: string[] }) => Promise<unknown> | null };
    const helper = app.helpers.get("voice-screen-reader");
    helper?.replies.set("readScreen", null);

    expect(await controller.captureContext({ apps: ["com.example.vault", "org.example.bank"], sites: ["example.com"] })).toBeNull();

    expect(helper?.requests.filter((request) => request.method === "readScreen").map((request) => request.params)).toStrictEqual([
      { excludedAppIDs: ["com.example.vault", "org.example.bank"], excludedHosts: ["example.com"], read: 1, wholeWindow: false },
    ]);
  });

  /** Once the screen read has answered, the whole window is read (ADR-DESK-016, 2026-10-25), numbered
   * after it, with the same exclusions, bound to the window that read read (`sameWindowAs`); the
   * controller reaches it through `captureWindow`. */
  test("the whole window is read by voice-screen-reader after the screen read", async () => {
    await launch("darwin");
    const controller = app.controller as unknown as {
      captureContext: (exclusions: { apps: string[]; sites: string[] }) => Promise<unknown> | null;
      captureWindow: (capture: Promise<unknown>) => Promise<unknown> | null;
    };
    const helper = app.helpers.get("voice-screen-reader")!;
    const shown = { ...blankScreen({ appName: "Example Notes" }), renderedText: "Shown" };
    helper.replies.set("readScreen", shown);
    const capture = controller.captureContext({ apps: [], sites: ["example.com"] })!;
    const window = controller.captureWindow(capture);

    expect(await window).toEqual(shown);
    expect(helper.requests.map((request) => request.params)).toStrictEqual([
      { excludedAppIDs: [], excludedHosts: ["example.com"], read: 1, wholeWindow: false },
      { excludedAppIDs: [], excludedHosts: ["example.com"], read: 2, wholeWindow: true, sameWindowAs: 1 },
    ]);
  });

  /** A dictation that stops waiting for its screen read asks `voice-screen-reader` for what that read,
   * by its number, has read so far (ADR-DESK-053), and the capture yields the answer. */
  test("a stopped screen read asks voice-screen-reader for what it has read so far", async () => {
    await launch("darwin");
    const controller = app.controller as unknown as {
      captureContext: (exclusions: { apps: string[]; sites: string[] }) => Promise<unknown> | null;
      stopContext: (read: Promise<unknown>) => void;
    };
    const helper = app.helpers.get("voice-screen-reader")!;
    helper.replies.set("readScreen", null);
    helper.hold = true;
    const capture = controller.captureContext({ apps: [], sites: [] })!;
    controller.stopContext(capture);

    expect(helper.requests.map((request) => [request.method, request.params])).toStrictEqual([
      ["readScreen", { excludedAppIDs: [], excludedHosts: [], read: 1, wholeWindow: false }],
      ["readScreenStop", { read: 1 }],
    ]);
    for (const { answer } of helper.unanswered) answer();
    expect(await capture).toBeNull();
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
    expect(await send({ type: "excludeApp" })).toEqual({ error: "That app can't be excluded: its application identifier could not be read." });
    helper?.replies.set("appInfo", { bundleIdentifier: "org.example.notes", name: "", path: app.pickedPath });
    expect(await send({ type: "excludeApp" })).toEqual({ error: "That app can't be excluded." });
    expect(state()).toMatchObject({ excludedApps: [{ bundleIdentifier: "org.example.bank", name: "Example Bank" }] });

    expect(await send({ type: "removeExcludedApp", bundleIdentifier: "ORG.example.bank" })).toEqual({ error: null });
    expect(state()).toMatchObject({ excludedApps: [] });
    expect(app.stored.get("excludedApps")).toEqual([]);
  });

  /** A slow screen read must never hold up a paste: on every platform it runs in voice-screen-reader,
   * a program of its own (ADR-DESK-053), started with the app and ended at once when the app quits;
   * the main helper, which pastes, is never asked to read the screen. */
  test.each([
    ["darwin", "voice-macos", "voice-screen-reader"],
    ["win32", "voice-windows", "voice-screen-reader.exe"],
    ["linux", "voice-linux", "voice-screen-reader"],
  ] as const)("on %s the screen is read by its own program, never the one that pastes", async (platform, mainName, executable) => {
    await launch(platform);
    const reader = app.helpers.get("voice-screen-reader")!;
    const main = app.helpers.get(mainName)!;
    expect(reader.options).toMatchObject({ stopEndsAtOnce: true });
    expect(reader.options.args ?? []).toEqual([]);
    expect(basename(reader.options.executable)).toBe(executable);
    expect(dirname(reader.options.executable)).toBe(dirname(main.options.executable));
    expect(reader.lifecycle).toEqual(["start"]);

    reader.replies.set("readScreen", { hidden: true });
    const controller = app.controller as unknown as { captureContext: (exclusions: { apps: string[]; sites: string[] }) => Promise<unknown> | null };
    expect(await controller.captureContext({ apps: [], sites: [] })).toEqual({ hidden: true });
    expect(main.requests.some((request) => request.method === "readScreen")).toBe(false);

    app.appEvents.get("before-quit")?.({ preventDefault() {} });
    await vi.waitFor(() => expect(reader.lifecycle).toEqual(["start", "stop"]));
  });

  test("Windows privacy picks an executable and passes native IDs through screen and correction reads", async () => {
    await launch("win32");
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as { canExcludeApps: boolean; builtInExcludedApps: unknown };
    expect(state()).toMatchObject({ canExcludeApps: true, builtInExcludedApps: config.windowsBuiltInExcludedApps });
    expect(await send({ type: "excludeApp" })).toEqual({ error: null });
    expect(app.openDialogs).toEqual([expect.objectContaining({ filters: [{ name: "Applications", extensions: ["exe"] }] })]);
    const helper = app.helpers.get("voice-windows");
    expect(helper?.requests.some((request) => request.method === "appInfo")).toBe(false);
    app.pickedPath = "C:\\Apps\\Example.exe";
    helper?.replies.set("appInfo", { bundleIdentifier: "Example.exe", name: "Example", path: app.pickedPath });
    expect(await send({ type: "excludeApp" })).toEqual({ error: null });
    expect(app.stored.get("excludedApps")).toEqual([{ bundleIdentifier: "Example.exe", name: "Example" }]);
    expect(helper?.requests.filter((request) => request.method === "appInfo").map((request) => request.params)).toEqual([{ path: app.pickedPath }]);
    const controller = app.controller as unknown as { captureContext: (exclusions: { apps: string[]; sites: string[] }) => Promise<unknown> | null };
    const reader = app.helpers.get("voice-screen-reader");
    reader?.replies.set("readScreen", null);
    await controller.captureContext({ apps: ["Example.exe"], sites: ["example.com"] });
    expect(reader?.requests.filter((request) => request.method === "readScreen").map((request) => request.params)).toEqual([{ excludedAppIDs: ["Example.exe"], excludedHosts: ["example.com"], read: 1, wholeWindow: false }]);
    expect(helper?.requests.some((request) => request.method === "readScreen")).toBe(false);
    expect(await send({ type: "removeExcludedApp", bundleIdentifier: "example.EXE" })).toEqual({ error: null });
    expect(app.stored.get("excludedApps")).toEqual([]);
    expect(app.helpers.get("voice-macos")?.requests.some((request) => request.method === "appInfo")).not.toBe(true);
  });

  test("no more apps are excluded once the list is full, and one short of it takes one", async () => {
    app.stored.set("excludedApps", Array.from({ length: config.exclusionsMax - 1 }, (_, index) => ({ bundleIdentifier: `org.example.app${index}`, name: `App ${index}` })));
    await launch("darwin");
    app.pickedPath = "/Applications/Example Bank.app";
    app.helpers.get("voice-macos")?.replies.set("appInfo", { bundleIdentifier: "org.example.bank", name: "Example Bank", path: app.pickedPath });

    expect(await send({ type: "excludeApp" })).toEqual({ error: null });
    app.pickedPath = "/Applications/Example Notes.app";
    app.helpers.get("voice-macos")?.replies.set("appInfo", { bundleIdentifier: "org.example.notes", name: "Example Notes", path: app.pickedPath });
    expect(await send({ type: "excludeApp" })).toEqual({ error: `At most ${config.exclusionsMax} apps can be excluded. Remove one to add another.` });
    expect((app.stored.get("excludedApps") as { bundleIdentifier: string }[]).map((one) => one.bundleIdentifier).slice(-1)).toEqual(["org.example.bank"]);
    expect((app.stored.get("excludedApps") as unknown[]).length).toBe(config.exclusionsMax);
  });

  /** Settings › Privacy's website commands (ADR-DESK-047): a site is added by its address and kept by
   * its host, removed by its host, and the pane is told why one couldn't be added. */
  test("the excluded websites' commands and state", async () => {
    await launch("darwin");
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as { excludedSites: unknown };
    expect(state()).toMatchObject({ excludedSites: [] });

    expect(await send({ type: "excludeSite", site: "https://Mail.Example.com/inbox" })).toEqual({ error: null });
    expect(await send({ type: "excludeSite", site: "example.org" })).toEqual({ error: null });
    expect(state()).toMatchObject({ excludedSites: ["mail.example.com", "example.org"] });
    expect(app.stored.get("excludedSites")).toEqual(["mail.example.com", "example.org"]);

    expect(await send({ type: "excludeSite", site: "not a site" })).toEqual({ error: "That isn't a website's address." });
    expect(state()).toMatchObject({ excludedSites: ["mail.example.com", "example.org"] });

    expect(await send({ type: "removeExcludedSite", host: "Mail.Example.com" })).toEqual({ error: null });
    expect(state()).toMatchObject({ excludedSites: ["example.org"] });
    expect(app.stored.get("excludedSites")).toEqual(["example.org"]);
  });

  /** An exclusion or a removal that could not be written to disk did not happen: the command says
   * so, and the state is as it was. */
  test("an exclusion that could not be saved says so, added or removed, and the lists are as they were", async () => {
    await launch("darwin");
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as { excludedSites: unknown; excludedApps: unknown };
    const unsaved = "This couldn't be saved, so it is not excluded. Check the disk and try again.";
    const unremoved = "This couldn't be saved, so it is still excluded. Check the disk and try again.";
    app.pickedPath = "/Applications/Example Bank.app";
    app.helpers.get("voice-macos")?.replies.set("appInfo", { bundleIdentifier: "org.example.bank", name: "Example Bank", path: app.pickedPath });
    app.savesFail = true;

    expect(await send({ type: "excludeSite", site: "example.org" })).toEqual({ error: unsaved });
    expect(await send({ type: "excludeApp" })).toEqual({ error: unsaved });
    expect(state()).toMatchObject({ excludedSites: [], excludedApps: [] });

    app.savesFail = false;
    expect(await send({ type: "excludeSite", site: "example.org" })).toEqual({ error: null });
    expect(await send({ type: "excludeApp" })).toEqual({ error: null });

    app.savesFail = true;
    expect(await send({ type: "removeExcludedSite", host: "example.org" })).toEqual({ error: unremoved });
    expect(await send({ type: "removeExcludedApp", bundleIdentifier: "org.example.bank" })).toEqual({ error: unremoved });
    expect(state()).toMatchObject({ excludedSites: ["example.org"], excludedApps: [{ bundleIdentifier: "org.example.bank" }] });
    // Nothing is unsaved for one that is not there.
    expect(await send({ type: "removeExcludedSite", host: "example.net" })).toEqual({ error: null });

    app.savesFail = false;
    expect(await send({ type: "removeExcludedSite", host: "example.org" })).toEqual({ error: null });
    expect(await send({ type: "removeExcludedApp", bundleIdentifier: "org.example.bank" })).toEqual({ error: null });
    expect(state()).toMatchObject({ excludedSites: [], excludedApps: [] });
  });

  test("no more websites are excluded once the list is full, and one short of it takes one", async () => {
    app.stored.set("excludedSites", Array.from({ length: config.exclusionsMax - 1 }, (_, index) => `site${index}.example.com`));
    await launch("darwin");

    expect(await send({ type: "excludeSite", site: "example.org" })).toEqual({ error: null });
    expect(await send({ type: "excludeSite", site: "example.net" })).toEqual({ error: `At most ${config.exclusionsMax} websites can be excluded. Remove one to add another.` });
    expect((app.stored.get("excludedSites") as string[]).slice(-1)).toEqual(["example.org"]);
    expect((app.stored.get("excludedSites") as unknown[]).length).toBe(config.exclusionsMax);
  });

  test("Linux exclusions use desktop app identity and its application picker", async () => {
    await launch("linux");
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as { canExcludeApps: boolean; excludedApps: unknown };
    expect(state().canExcludeApps).toBe(true);
    const helper = app.helpers.get("voice-linux")!;
    app.pickedPath = "/usr/share/applications/example.desktop";
    helper.replies.set("appInfo", { bundleIdentifier: "example.desktop", name: "Example", path: app.pickedPath });
    expect(await send({ type: "excludeApp" })).toEqual({ error: null });
    expect(app.openDialogs).toEqual([expect.objectContaining({ filters: [{ name: "Applications", extensions: ["desktop"] }] })]);
    expect(helper.requests.filter((request) => request.method === "appInfo").map((request) => request.params)).toEqual([{ path: app.pickedPath }]);
    expect(state().excludedApps).toEqual([{ bundleIdentifier: "example.desktop", name: "Example" }]);
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
    // This launch models macOS, even when the test runner itself is on Windows.
    const home = "/Users/example";
    vi.doMock("node:os", async () => ({ ...await vi.importActual<typeof import("node:os")>("node:os"), homedir: () => home }));
    try {
      await launch("darwin");
      const macHelper = app.helpers.get("voice-macos");
      macHelper?.replies.set("filesSearch", { items: [{ path: `${home}/Documents/Tax return.pdf`, name: "Tax return.pdf", kind: "PDF document", changed: null, subject: null, authors: [], isEmail: false }] });
      macHelper?.replies.set("fileOpen", { opened: true });

      expect(await app.connectorTools.find((tool) => tool.name === "files_search")?.run({ query: "tax" }, signal, toolSettings)).toContain(": ~/Documents/Tax return.pdf");
      expect(await app.connectorTools.find((tool) => tool.name === "file_open")?.run({ path: "~/Documents/Tax return.pdf" }, signal, toolSettings)).toBe("Opened Tax return.pdf.");
      expect(macHelper?.requests.find((request) => request.method === "fileOpen")?.params).toEqual({ path: `${home}/Documents/Tax return.pdf`, reveal: false });
    } finally {
      vi.doUnmock("node:os");
    }
  });

  /** A draft opens with the app macOS opens `mailto:` links with, named in the result; with none, the
   * tool says so and opens nothing. */
  test("a draft opens in the default email app", async () => {
    await launch("darwin");
    const compose = app.connectorTools.find((tool) => tool.name === "email_compose");
    const args = { to: ["sam@example.com"], subject: "Lunch", body: "Friday?" };
    const macHelper = app.helpers.get("voice-macos");

    // `launch` loads the app afresh, so the failure is its own module's class: matched by name.
    await expect(compose?.run(args, signal, toolSettings)).rejects.toMatchObject({ name: "NoEmailAppError" });
    expect(app.opened).toEqual([]);

    macHelper?.replies.set("emailApps", { systemDefault: { bundleIdentifier: "com.example.mail", name: "Example Mail" }, installed: [] });
    expect(await compose?.run(args, signal, toolSettings)).toBe("Opened a new email to sam@example.com in Example Mail, for the user to review and send. Nothing was sent.");
    expect(app.opened).toEqual([mailtoURL({ to: ["sam@example.com"], cc: [], bcc: [], subject: "Lunch", body: "Friday?" })]);
    expect(macHelper?.requests.filter((request) => request.method === "emailApps").at(-1)?.params).toEqual({ bundleIdentifiers: [] });

    // An app that fails to launch fails the call, so the model never says it opened.
    app.openFailure = new Error("Failed to open URL");
    await expect(compose?.run(args, signal, toolSettings)).rejects.toThrow("Failed to open URL");
  });

  test.each(["win32", "linux"] as const)("shared Answer tools and switches work on %s", async (platform) => {
    await launch(platform);
    const state = (name: string) => app.handlers.get(channels.getState)?.({}, name) as { connectors: string[] };
    expect(app.connectorTools.map((tool) => tool.name)).toEqual(["calendar_read", "calendar_event_create", ...(platform === "linux" ? ["calendar_event_read", "calendar_event_edit", "calendar_event_delete", "reminders_read", "reminder_create"] : []), "contacts_search", "contacts_add", "files_search", "file_open", "file_read_pdf", "email_compose", ...(platform === "linux" ? ["notes_search", "notes_create"] : []), "web_read", "web_open", "change_setting"]);
    if (platform === "win32") {
      const create = app.connectorTools.find((tool) => tool.name === "calendar_event_create");
      const confirmation = await create?.confirmation({ title: "Synthetic event", start_iso: "2027-05-12" }, signal, toolSettings);
      // The words name where it goes, and so does the card the window draws.
      expect(typeof confirmation === "object" && confirmation !== null ? confirmation.text : confirmation).toContain("Destination: TabMail Voice calendar (local to this PC)");
      expect(typeof confirmation === "object" && confirmation !== null ? confirmation.event.lines[0] : null).toEqual({ icon: "calendar", text: "TabMail Voice calendar (local to this PC)", detail: null, tone: "plain" });
    }
    const expectedConnectors = ["calendar", ...(platform === "linux" ? ["reminders"] : []), "contacts", "files", "email", ...(platform === "linux" ? ["notes"] : []), "web", "settings"];
    expect(state("settings").connectors).toEqual(expectedConnectors);
    expect(state("welcome").connectors).toEqual(expectedConnectors);
    const web = app.connectorTools.find((tool) => tool.name === "web_open");
    expect(web).toBeDefined();
    expect(await web?.run({ url: "https://example.com/page" }, signal, toolSettings)).toContain("Opened");
    const compose = app.connectorTools.find((tool) => tool.name === "email_compose");
    expect(compose).toBeDefined();
    const args = { to: ["sam@example.com"], subject: "Lunch", body: "Friday?" };
    app.emailHandler = "";
    await expect(compose?.run(args, signal, toolSettings)).rejects.toMatchObject({ name: "NoEmailAppError" });
    expect(app.opened).toEqual(["https://example.com/page"]);
    app.emailHandler = "Example Mail";
    expect(await compose?.run(args, signal, toolSettings)).toContain("Example Mail");
    expect(app.opened.at(-1)).toBe(mailtoURL({ to: args.to, cc: [], bcc: [], subject: args.subject, body: args.body }));
    app.openFailure = new Error("Failed to open URL");
    await expect(compose?.run(args, signal, toolSettings)).rejects.toThrow("Failed to open URL");
    // These shared tools never invoke AppleScript or the macOS native connector APIs.
    expect(app.scripts).toEqual([]);
    const forbidden = ["calendarEvents", "contactsSearch", "filesSearch", "emailApps"];
    expect(app.helpers.get("voice-macos")?.requests.some((request) => forbidden.includes(request.method))).toBe(false);
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

  /** Settings › Memory (ADR-DESK-061): memory is in the app's own folder, read only once something
   * was kept there, and each command of the section reaches it. */
  test("Settings › Memory's commands reach memory in the app's own folder", async () => {
    app.userData = mkdtempSync(join(tmpdir(), "voice-user-data-"));
    await launch("darwin");
    const memory = app.memory;
    if (memory === null) throw new Error("no memory");
    const directory = join(app.userData, "memory");
    expect(memory.options.directory).toBe(directory);
    const page = () => (app.handlers.get(channels.getState)?.({}, "settings") as { memory: MemoryPageState }).memory;
    // The Settings window learns the page's state only by push.
    const pushed: MemoryPageState[] = [];
    app.listeners.set("voice:state", [
      (_event, name, state) => {
        if (name === "settings") pushed.push((state as { memory: MemoryPageState }).memory);
      },
    ]);
    const now = Date.now();
    memory.rows.push(memoryRow("asked about Friday", "the review", now - 1_000, "1"), memoryRow("other", "reply", now - 2_000, "2"));

    // Nothing kept on disk yet: nothing is asked of memory.
    await send({ type: "loadMemory" });
    expect(page().usage).toEqual({ docs: 0, usedBytes: 0 });
    expect(memory.searches).toEqual([]);

    const database = memoryFolders(directory).databaseFile;
    mkdirSync(dirname(database), { recursive: true });
    writeFileSync(database, "");
    await send({ type: "loadMemory" });
    expect(page().usage?.docs).toBe(2);
    expect(pushed.at(-1)?.usage?.docs).toBe(2);
    expect(page().entries.map((entry) => entry.memId)).toEqual(["turn:1", "turn:2"]);

    await send({ type: "searchMemory", query: "friday" });
    expect(memory.searches.at(-1)?.query).toBe("friday");
    expect(page().entries.map((entry) => entry.memId)).toEqual(["turn:1"]);

    const trim = vi.spyOn(memory, "trim");
    const limit = config.memorySizeLimitChoices[0] ?? 0;
    await send({ type: "setMemorySizeLimit", value: limit });
    expect(app.stored.get("memorySizeLimit")).toBe(limit);
    expect(trim).toHaveBeenCalledWith(limit);

    await send({ type: "removeMemory", memId: "turn:2" });
    expect(memory.rows.map((row) => row.memId)).toEqual(["turn:1"]);

    await send({ type: "clearMemory" });
    expect(memory.rows).toEqual([]);
    expect(page().status).toBe("Memory cleared.");
    expect(pushed.at(-1)?.status).toBe("Memory cleared.");
  });

  /** The default event duration (owner, 2026-10-18): Settings shows it, and both its menu and agent
   * mode's `change_setting` store it, pushing the new value to the Settings window; one the file
   * can't keep is reported, not claimed. */
  test.each(["darwin", "win32", "linux"] as const)("the default event duration is set from Settings and by change_setting, on %s", async (platform) => {
    await launch(platform);
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as { eventDuration: number };
    const pushed: number[] = [];
    app.listeners.set("voice:state", [
      (_event, name, pushedState) => {
        if (name === "settings") pushed.push((pushedState as { eventDuration: number }).eventDuration);
      },
    ]);
    expect(state().eventDuration).toBe(config.eventDurationDefault);

    expect(await send({ type: "setEventDuration", value: 90 })).toEqual({ error: null });
    expect(app.stored.get("eventDurationMinutes")).toBe(90);
    expect(state().eventDuration).toBe(90);
    expect(pushed.at(-1)).toBe(90);
    expect(await send({ type: "setEventDuration", value: config.eventDurationMax + 1 })).toEqual({ error: expect.any(String) });
    expect(state().eventDuration).toBe(90);

    const change = app.connectorTools.find((tool) => tool.name === "change_setting");
    await expect(change?.run({ setting: "calendar.default_event_duration_minutes", value: 50 }, signal, toolSettings)).resolves.toContain("50 min");
    expect(app.stored.get("eventDurationMinutes")).toBe(50);
    expect(state().eventDuration).toBe(50);
    expect(pushed.at(-1)).toBe(50);

    app.savesFail = true;
    expect(await send({ type: "setEventDuration", value: 30 })).toEqual({ error: "The default event duration couldn't be saved. Check the disk and try again." });
    await expect(change?.run({ setting: "calendar.default_event_duration_minutes", value: 30 }, signal, toolSettings)).rejects.toThrow("The setting couldn't be saved. Nothing was changed.");
    expect(state().eventDuration).toBe(50);
  });

  /** A file there at launch that couldn't be read (ADR-DESK-063) is never saved to: the user is told
   * at once how to fix it by hand, its Fix item stays in the menu, and every change it would have kept
   * says how to fix it. The app itself never resets, moves or writes over it. */
  test("a knowledge base file that couldn't be read is told of at launch, and nothing is saved to it", async () => {
    const path = join(app.userData, "userPrompts.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    await launch("darwin");

    // Told once launch is done, on a task of its own.
    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);
    expect(app.dialogsAfterLaunch).toEqual([true]);
    expect(app.dialogs[0]).toMatchObject({ type: "warning", message: "TabMail Voice's knowledge base file is damaged.", buttons: ["Show File", "Reset to Defaults…", "Close"], cancelId: 2 });
    expect(app.dialogs[0]?.detail).toContain(path);
    expect(app.trayState?.().fileProblems).toEqual(["knowledgeBase"]);
    expect((app.handlers.get(channels.getState)?.({}, "settings") as SettingsState).fileProblems).toEqual(["knowledgeBase"]);

    const page = () => (app.handlers.get(channels.getState)?.({}, "settings") as { personalization: PersonalizationState }).personalization;
    const defaults = page().knowledgeBase;
    for (const command of [
      { type: "editKnowledgeBase", shown: defaults, bullets: [...defaults, "Prefers short replies."] },
      { type: "editWritingStyle", section: "Language", shown: ["I write in English Only."], bullets: ["I write in German."] },
      { type: "resetKnowledgeBase" },
      { type: "resetWritingStyle" },
      { type: "restorePromptHistory", id: "no-such-entry" },
    ]) {
      expect(await send(command), command.type).toEqual({ error: unsavedBecauseOf("knowledgeBase") });
    }
    // The settings file read, so a setting is saved as ever.
    expect(await send({ type: "setSmartDictation", value: false })).toEqual({ error: null });
    expect(app.files.get(path)?.size).toBe(0);
    expect(page().knowledgeBase).toEqual(defaults);

    // The menu's Fix item tells it again, and Show File shows it; Close does nothing more.
    app.dialogResponse = 0;
    app.trayActions?.showFileProblem("knowledgeBase");
    expect(await eventually(() => app.shownFiles.length > 0)).toBe(true);
    expect(app.shownFiles).toEqual([path]);
    expect(app.dialogs).toHaveLength(2);
  });

  /** Every command that keeps a choice in the settings file says, each time, that it wasn't saved and
   * how to fix the file; what it changed holds until quit, and the file is never written. */
  test("a settings file that couldn't be read is told of at launch, and every setting changed says how to fix it", async () => {
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind: "permission", path, code: "EACCES" });
    app.stored.set("readsScreen", false);
    app.dialogResponse = 2;
    await launch("darwin");

    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);
    expect(app.dialogs[0]).toMatchObject({ message: "TabMail Voice doesn't have permission to read its settings file." });
    expect(app.trayState?.().fileProblems).toEqual(["settings"]);
    const settingsState = () => app.handlers.get(channels.getState)?.({}, "settings") as SettingsState;
    expect(settingsState().fileProblems).toEqual(["settings"]);

    for (const command of [
      { type: "setHotkey", hotkey: "rightOption" },
      { type: "setReadsScreen", value: false },
      { type: "setUserName", value: "Sam Example" },
      { type: "addDictionaryWord", word: "Xyvora" },
      { type: "removeDictionaryWord", word: "Xyvora" },
      { type: "setLearnsWords", value: false },
      { type: "setSmartDictation", value: false },
      { type: "setOptsOutOfAI", value: true },
      { type: "setClosesChatElsewhere", value: false },
      { type: "setEventDuration", value: 30 },
      { type: "excludeApp" },
      { type: "removeExcludedApp", bundleIdentifier: "com.example.app" },
      { type: "excludeSite", site: "example.com" },
      { type: "removeExcludedSite", host: "example.com" },
      { type: "setEmailClient", bundleIdentifier: null },
      { type: "setAgentToolEnabled", tool: "compose", value: false },
      { type: "setConnectorEnabled", connector: "notes", value: false },
      { type: "setDebugMode", value: true },
      { type: "setMemorySizeLimit", value: config.memorySizeLimitChoices.find((value) => value !== config.memorySizeLimitDefault) ?? 0 },
      { type: "setConsent", value: true },
      { type: "welcomeNext" },
    ]) {
      expect(await send(command), command.type).toEqual({ error: unsavedBecauseOf("settings") });
    }
    // What a command changed holds until quit; the file is as it was.
    expect(settingsState().smartDictation).toBe(false);
    expect([...app.stored.entries()]).toEqual([["readsScreen", false]]);
    // A command that keeps nothing in it answers as ever, never with the fix.
    expect(await send({ type: "keepChatOpen" })).toEqual({ error: null });
    // Every one `commandWrites` gives no file: signing in, above all, must still work.
    for (const command of [
      { type: "sendCode", email: "user@example.com" },
      { type: "verify", email: "user@example.com", code: "123456" },
      { type: "signOut" },
      { type: "setOpenAtLogin", value: true },
      { type: "loadMemory" },
      { type: "searchMemory", query: "example" },
      { type: "removeMemory", memId: "example" },
      { type: "clearMemory" },
      { type: "requestMicrophone" },
      { type: "requestAccessibility" },
      { type: "enableGnomeIntegration" },
      { type: "checkForUpdates" },
      { type: "installUpdate" },
      { type: "welcomeBack" },
      { type: "welcomeGoTo", index: 0 },
      { type: "fixVSCodeSettings" },
      { type: "openURL", url: "https://example.com" },
      { type: "keepChatOpen" },
      { type: "closeChat" },
      { type: "openChatLink", url: "https://example.com" },
      { type: "answerConfirmation", confirmed: false },
      { type: "chatHeight", height: 100 },
      { type: "pointerOver", over: false },
      { type: "chatDragStart" },
      { type: "dragChat", dx: 0, dy: 0 },
      { type: "copyNotPasted" },
      { type: "dismissNotPasted" },
      { type: "copyHistoryEntry", id: 0 },
      { type: "closeHistory" },
      { type: "historyHeight", height: 100 },
    ]) {
      expect(await send(command), command.type).not.toEqual({ error: unsavedBecauseOf("settings") });
    }

    const change = app.connectorTools.find((tool) => tool.name === "change_setting");
    await expect(change?.run({ setting: "calendar.default_event_duration_minutes", value: 30 }, signal, toolSettings)).rejects.toThrow(unsavedBecauseOf("settings"));
  });

  test("files that read show no notice and no Fix item", async () => {
    await launch("darwin");
    expect(app.dialogs).toEqual([]);
    expect(app.trayState?.().fileProblems).toEqual([]);
  });

  /** Settings › Personalization's commands (ADR-DESK-063): each changes the stored texts and the
   * state Settings shows, and pushes it; one the file can't keep is reported and changes nothing. */
  test("the writing style and knowledge base are edited, reset and restored from Settings", async () => {
    await launch("darwin");
    const page = () => (app.handlers.get(channels.getState)?.({}, "settings") as { personalization: PersonalizationState }).personalization;
    const pushed: PersonalizationState[] = [];
    app.listeners.set("voice:state", [
      (_event, name, pushedState) => {
        if (name === "settings") pushed.push((pushedState as { personalization: PersonalizationState }).personalization);
      },
    ]);
    const promptsFile = () => app.files.get(join(app.userData, "userPrompts.json"));
    const storedKB = () => promptsFile()?.get("user_prompts:user_kb.md");
    const storedStyle = () => promptsFile()?.get("user_prompts:user_composition.md");
    const language = () => page().writingStyle.find((one) => one.section === "Language")?.bullets;
    const defaults = page().knowledgeBase;
    expect(defaults).toHaveLength(3);
    expect(language()).toEqual(["I write in English Only."]);
    expect(page().history).toEqual([]);

    expect(await send({ type: "editKnowledgeBase", shown: defaults, bullets: [...defaults, "Prefers short replies."] })).toEqual({ error: null });
    expect(storedKB()).toContain("- Prefers short replies.");
    expect(page().knowledgeBase).toEqual([...defaults, "Prefers short replies."]);
    expect(pushed.at(-1)?.knowledgeBase).toEqual([...defaults, "Prefers short replies."]);

    expect(await send({ type: "editWritingStyle", section: "Language", shown: ["I write in English Only."], bullets: ["I write in English and French."] })).toEqual({ error: null });
    expect(storedStyle()).toContain("- I write in English and French.");
    expect(storedStyle()).not.toContain("English Only");
    expect(language()).toEqual(["I write in English and French."]);
    expect(pushed.at(-1)?.writingStyle.find((one) => one.section === "Language")?.bullets).toEqual(["I write in English and French."]);

    // A reset brings the default back, recording the text as it was first.
    expect(await send({ type: "resetKnowledgeBase" })).toEqual({ error: null });
    expect(page().knowledgeBase).toEqual(defaults);
    expect(pushed.at(-1)?.knowledgeBase).toEqual(defaults);
    const kbReset = page().history[0];
    expect(kbReset).toMatchObject({ source: "reset", fields: ["kb"], restores: ["Prefers short replies."] });
    expect(await send({ type: "resetWritingStyle" })).toEqual({ error: null });
    expect(language()).toEqual(["I write in English Only."]);

    // Restoring the knowledge base's reset puts back both texts as they were then.
    expect(await send({ type: "restorePromptHistory", id: kbReset?.id })).toEqual({ error: null });
    expect(page().knowledgeBase).toEqual([...defaults, "Prefers short replies."]);
    expect(language()).toEqual(["I write in English and French."]);
    expect(pushed.at(-1)?.knowledgeBase).toEqual([...defaults, "Prefers short replies."]);

    // The file can't be written: each command says so, and the texts stay as they are.
    app.savesFail = true;
    const [kbBefore, styleBefore] = [storedKB(), storedStyle()];
    const shownBefore = { knowledgeBase: page().knowledgeBase, writingStyle: page().writingStyle };
    const unsaved = { error: "This couldn't be saved, so nothing changed. Check the disk and try again." };
    for (const command of [
      { type: "editKnowledgeBase", shown: shownBefore.knowledgeBase, bullets: ["Only this."] },
      { type: "editWritingStyle", section: "Language", shown: ["I write in English and French."], bullets: ["I write in German."] },
      { type: "resetKnowledgeBase" },
      { type: "resetWritingStyle" },
      { type: "restorePromptHistory", id: kbReset?.id },
    ]) {
      expect(await send(command), command.type).toEqual(unsaved);
      expect(storedKB(), command.type).toBe(kbBefore);
      expect(storedStyle(), command.type).toBe(styleBefore);
      expect({ knowledgeBase: page().knowledgeBase, writingStyle: page().writingStyle }, command.type).toEqual(shownBefore);
    }
  });

  /** The knowledge base changed outside Settings (by `kb_add` or `kb_del`): the Settings
   * window is pushed the new state. */
  test("a knowledge base change made outside Settings reaches the Settings window", async () => {
    await launch("darwin");
    const pushed: string[][] = [];
    app.listeners.set("voice:state", [
      (_event, name, pushedState) => {
        if (name === "settings") pushed.push((pushedState as { personalization: PersonalizationState }).personalization.knowledgeBase);
      },
    ]);
    expect(app.prompts?.updateKnowledgeBase((current) => `${current}\n- Learned in a chat.`)).toBe("saved");
    expect(pushed.at(-1)).toContain("Learned in a chat.");
  });

  /** Edits still waiting for their quiet period are recorded in the history when the app quits, not
   * lost. */
  test("quitting records the edits waiting for their quiet period", async () => {
    await launch("darwin");
    const page = () => (app.handlers.get(channels.getState)?.({}, "settings") as { personalization: PersonalizationState }).personalization;
    const defaults = page().knowledgeBase;
    expect(await send({ type: "editKnowledgeBase", shown: defaults, bullets: [...defaults, "Prefers short replies."] })).toEqual({ error: null });
    const promptsFile = app.files.get(join(app.userData, "userPrompts.json"));
    expect(promptsFile?.get("prompt_history")).toBeUndefined();

    app.appEvents.get("before-quit")?.({ preventDefault() {} });
    await vi.waitFor(() => expect(app.quits).toBe(1));
    const history = promptsFile?.get("prompt_history") as { source: string; fields: string[]; kb: string }[];
    expect(history.map(({ source, fields }) => ({ source, fields }))).toEqual([{ source: "local_edit", fields: ["kb"] }]);
    expect(history[0]?.kb).toContain("- Prefers short replies.");
  });

  /** The writing style and knowledge base are the computer user's: kept in their own file in the
   * app's folder, apart from the preferences, and read again at the next launch; another user's
   * folder has its own. */
  test("the knowledge base is kept in the app's folder, apart from the preferences, across launches", async () => {
    const [first, second] = [mkdtempSync(join(tmpdir(), "TabMailVoiceTests-")), mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"))];
    const page = () => (app.handlers.get(channels.getState)?.({}, "settings") as { personalization: PersonalizationState }).personalization;
    const relaunch = async (userData: string) => {
      app.handlers.clear();
      app.listeners.clear();
      app.userData = userData;
      await launch("darwin");
    };
    try {
      await relaunch(first);
      const defaults = page().knowledgeBase;
      expect(await send({ type: "editKnowledgeBase", shown: defaults, bullets: [...defaults, "Prefers short replies."] })).toEqual({ error: null });
      expect(app.files.get(join(first, "userPrompts.json"))?.get("user_prompts:user_kb.md")).toContain("- Prefers short replies.");
      expect([...app.stored.keys()].filter((key) => key.startsWith("user_prompts:") || key === "prompt_history")).toEqual([]);

      await relaunch(second);
      expect(page().knowledgeBase).toEqual(defaults);

      await relaunch(first);
      expect(page().knowledgeBase).toEqual([...defaults, "Prefers short replies."]);
    } finally {
      app.userData = "/nonexistent";
      for (const folder of [first, second]) rmSync(folder, { recursive: true, force: true });
    }
  });

  /** Memory is the computer user's, not the account's (ADR-DESK-061): signing out and signing in
   * with another account keep it, in the same folder; quitting ends its helper. */
  test("memory stays across sign-out and another account, and its helper ends at quit", async () => {
    const signIn = (id: string, email: string) => {
      app.credential = JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id, email } });
    };
    app.userData = mkdtempSync(join(tmpdir(), "voice-user-data-"));
    signIn("user", "tester@example.com");
    await launch("darwin");
    const memory = app.memory;
    if (memory === null) throw new Error("no memory");
    const directory = join(app.userData, "memory");
    const database = memoryFolders(directory).databaseFile;
    mkdirSync(dirname(database), { recursive: true });
    writeFileSync(database, "kept");
    memory.rows.push(memoryRow("asked about Friday", "the review", Date.now() - 1_000, "1"));
    const clear = vi.spyOn(memory, "clear");

    expect(await send({ type: "signOut" })).toEqual({ error: null });
    expect(clear).not.toHaveBeenCalled();
    expect(memory.rows.map((row) => row.memId)).toEqual(["turn:1"]);
    expect(readFileSync(database, "utf8")).toBe("kept");

    signIn("other-user", "other@example.com");
    await launch("darwin");
    expect(app.memory?.options.directory).toBe(directory);
    expect(readFileSync(database, "utf8")).toBe("kept");

    app.appEvents.get("before-quit")?.({ preventDefault() {} });
    await vi.waitFor(() => expect(app.memory?.stops).toBe(1));
  });

  /** ADR-DESK-061 (ADR-DESK-049's tip): what's new about memory is a tip shown once at a dictation, to a user
   * who set the app up before; one still in the welcome wizard reads it on the consent page, and
   * never gets the tip. Nothing is shown at launch. */
  test.each([
    { finishedWelcome: true, tipShows: true },
    { finishedWelcome: false, tipShows: false },
  ])("set up before: $finishedWelcome; the what's-new tip may show: $tipShows", async ({ finishedWelcome, tipShows }) => {
    app.stored.set("hasFinishedWelcome", finishedWelcome);
    await launch("darwin");
    expect(app.dialogs).toEqual([]);
    expect(app.stored.get("tip.agentKnowledgeBase.learned") === true).toBe(!tipShows);
  });

  /** Each way a user opens a window opens the one it names: the tray's Settings and Welcome Guide,
   * the debug build's last screen context, a second launch (Settings), and a first run (the welcome
   * guide). */
  test("each way to open a window opens the window it names", async () => {
    app.stored.set("hasFinishedWelcome", false);
    await launch("darwin");
    expect(app.presented).toEqual(["welcome"]);
    app.presented = [];
    app.trayActions?.showSettings();
    app.trayActions?.showWelcome();
    app.trayActions?.debug.showLastScreenContext();
    app.appEvents.get("second-instance")?.();
    expect(app.presented).toEqual(["settings", "welcome", "contextDebug", "settings"]);
  });

  /** A settings file that can't be read reads as setup never done, but the welcome wizard never
   * opens then (owner, 2026-10-27): at launch and from the menu (Finish Setting Up and Welcome Guide
   * both call `showWelcome`), every way into it tells how to fix the file instead. */
  test.each(["permission", "damaged", "unreadable"] as const)("a settings file that can't be read (%s) never opens the welcome wizard, and offers the fix steps instead", async (kind) => {
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind, path, code: kind === "damaged" ? "invalid" : "EIO" });
    app.dialogResponse = 2;
    await launch("darwin");

    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.dialogs).toHaveLength(1);
    const fix = app.dialogs[0];
    expect(fix?.message).toContain("settings file");
    expect(app.presented).toEqual([]);
    expect(app.trayState?.().hasConsented).toBe(false);

    app.trayActions?.showWelcome();
    expect(await eventually(() => app.dialogs.length === 2)).toBe(true);
    expect(app.dialogs[1]).toEqual(fix);
    expect(app.presented).toEqual([]);
  });

  /** While the settings file can't be read its AI features are off (owner, 2026-10-27): no request
   * that carries what the user said reaches the network, whatever asks; signing in still does. With
   * the file read, the same requests go out. */
  test("a settings file that can't be read lets no AI request reach TabMail, and signing in still works", async () => {
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    await launch("darwin");
    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);

    await expect(app.backend?.warmUp("https://api.example.com", "token")).rejects.toThrow(aiOffLine);
    // The two that carry what the user said, the audio and the text.
    await expect(app.backend?.makeTranscriptionClient("https://api.example.com").transcribe(new Uint8Array([1]), null, [], "token")).rejects.toThrow(aiOffLine);
    await expect(app.backend?.makeCompletionsClient("https://api.example.com").complete({ role: "user", content: "hello", vars: {} }, "token")).rejects.toThrow(aiOffLine);
    expect(app.requests).toEqual([]);

    // Signing in isn't AI: it reaches TabMail as ever.
    await send({ type: "sendCode", email: "user@example.com" });
    await send({ type: "verify", email: "user@example.com", code: "123456" });
    expect(app.requests).toHaveLength(2);
  });

  /** Only the settings file turns the network off: with the knowledge base file alone unreadable,
   * requests go out as ever. */
  // Opt Out of AI is read once at a hold's start (ADR-DESK-010 amendment 2026-10-28): the transport leaves
  // a request a hold already made to finish.
  test.each([["every file reads", null], ["only the knowledge base file can't be read", "userPrompts.json"], ["Opt Out of AI on", "optsOutOfAI"]])("with %s a request reaches TabMail", async (_case, unreadable) => {
    if (unreadable === "optsOutOfAI") app.stored.set("optsOutOfAI", true);
    else if (unreadable !== null) {
      const path = join(app.userData, unreadable);
      app.problems.set(path, { kind: "damaged", path, code: "invalid" });
      app.dialogResponse = 2;
    }
    await launch("darwin");
    await send({ type: "sendCode", email: "user@example.com" });
    // Every client reaches it: the warm-up, transcription and completions too.
    const backend = app.backend;
    if (backend === null) throw new Error("no controller");
    await backend.warmUp("https://api.example.com", "token").catch(() => {});
    await backend.makeTranscriptionClient("https://api.example.com").transcribe(new Uint8Array([1]), null, [], "token").catch(() => {});
    await backend.makeCompletionsClient("https://api.example.com").complete({ role: "user", content: "hello", vars: {} }, "token").catch(() => {});
    expect(app.requests).toHaveLength(4);
  });

  /** While AI features are off, Settings › Memory lists the newest, removes one and clears all: they
   * are local and send nothing, so what memory holds can always be deleted. A typed search, which
   * memory's helper runs a model over, and the size limit, which trims memory, are refused (owner,
   * 2026-10-28). Both states AI is off in are the same: a settings file that can't be read, and Opt
   * Out of AI. */
  test("a settings file that can't be read lets Settings › Memory list, remove and clear, but not search or set the limit", async () => {
    app.userData = mkdtempSync(join(tmpdir(), "voice-user-data-"));
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    const database = memoryFolders(join(app.userData, "memory")).databaseFile;
    mkdirSync(dirname(database), { recursive: true });
    writeFileSync(database, "");
    await launch("darwin");
    const memory = app.memory;
    if (memory === null) throw new Error("no memory");
    const [search, trim, remove, clear] = (["search", "trim", "remove", "clear"] as const).map((method) => vi.spyOn(memory, method));

    expect(await send({ type: "searchMemory", query: "friday" })).toEqual({ error: `${aiOffLine}.` });
    // The size limit is kept in the settings file: it says how to fix it, as every such command does.
    expect(await send({ type: "setMemorySizeLimit", value: config.memorySizeLimitChoices.find((value) => value !== config.memorySizeLimitDefault) ?? 0 })).toEqual({ error: unsavedBecauseOf("settings") });
    expect([search?.mock.calls.length, trim?.mock.calls.length]).toEqual([0, 0]);
    for (const command of [{ type: "loadMemory" }, { type: "removeMemory", memId: "turn:1" }, { type: "clearMemory" }] as const) {
      expect(await send(command)).toEqual({ error: null });
    }
    expect(remove?.mock.calls).toEqual([[["turn:1"]]]);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(search?.mock.calls.map(([asked]) => (asked as { query: string }).query)).toEqual(["", "", ""]);
    expect([trim?.mock.calls.length, app.requests.length]).toEqual([0, 0]);
  });

  /** Opt Out of AI (owner, 2026-10-28): Settings › Memory lists the newest (a search typed before isn't
   * run again), removes one and clears all, and refuses a typed search and the size limit, saying
   * how to turn AI back on; signing in, Settings and the menu work as ever, and switching it off again
   * lets memory be searched. */
  test("Opt Out of AI lets Settings › Memory list, remove and clear, but not search or set the limit, and is kept", async () => {
    app.userData = mkdtempSync(join(tmpdir(), "voice-user-data-"));
    const database = memoryFolders(join(app.userData, "memory")).databaseFile;
    mkdirSync(dirname(database), { recursive: true });
    writeFileSync(database, "");
    await launch("darwin");
    const memory = app.memory;
    if (memory === null) throw new Error("no memory");
    const [search, trim, remove, clear] = (["search", "trim", "remove", "clear"] as const).map((method) => vi.spyOn(memory, method));
    const queries = () => search?.mock.calls.map(([asked]) => (asked as { query: string }).query);
    const settingsState = () => app.handlers.get(channels.getState)?.({}, "settings") as SettingsState;
    expect([settingsState().optsOutOfAI, app.trayState?.().optsOutOfAI]).toEqual([false, false]);
    // With AI on, the list keeps the search typed: after a removal, Clear All and a reload.
    expect(await send({ type: "searchMemory", query: "friday" })).toEqual({ error: null });
    for (const command of [{ type: "removeMemory", memId: "turn:2" }, { type: "clearMemory" }, { type: "loadMemory" }] as const) {
      expect(await send(command)).toEqual({ error: null });
    }
    expect([queries(), remove?.mock.calls, clear?.mock.calls.length]).toEqual([["friday", "friday", "friday", "friday"], [[["turn:2"]]], 1]);
    remove?.mockClear();
    clear?.mockClear();

    expect(await send({ type: "setOptsOutOfAI", value: true })).toEqual({ error: null });
    expect(app.stored.get("optsOutOfAI")).toBe(true);
    expect([settingsState().optsOutOfAI, app.trayState?.().optsOutOfAI]).toEqual([true, true]);
    search?.mockClear();
    const limit = config.memorySizeLimitChoices.find((value) => value !== config.memorySizeLimitDefault) ?? 0;
    for (const command of [{ type: "searchMemory", query: "friday" }, { type: "setMemorySizeLimit", value: limit }] as const) {
      expect(await send(command)).toEqual({ error: `${optedOutOfAIMemoryLine}.` });
    }
    expect([app.stored.has("memorySizeLimit"), queries(), trim?.mock.calls.length]).toEqual([false, [], 0]);
    // Each command that reads the list again, run right after a search typed while AI was on, reads
    // the newest: opening the section, a removal, Clear All, and a Clear All that failed.
    clear?.mockRejectedValueOnce(new Error("busy"));
    for (const [command, error] of [
      [{ type: "loadMemory" }, null],
      [{ type: "removeMemory", memId: "turn:1" }, null],
      [{ type: "clearMemory" }, "Memory couldn't be cleared. Try again."],
      [{ type: "clearMemory" }, null],
    ] as const) {
      expect(await send({ type: "setOptsOutOfAI", value: false })).toEqual({ error: null });
      expect(await send({ type: "searchMemory", query: "friday" })).toEqual({ error: null });
      expect(await send({ type: "setOptsOutOfAI", value: true })).toEqual({ error: null });
      expect(await send(command), command.type).toEqual({ error });
      expect(queries()?.slice(-2), command.type).toEqual(["friday", ""]);
    }
    expect([remove?.mock.calls, clear?.mock.calls.length, trim?.mock.calls.length]).toEqual([[[["turn:1"]]], 2, 0]);
    // Signing in still reaches TabMail; memory sent nothing.
    expect(app.requests).toHaveLength(0);
    await send({ type: "sendCode", email: "user@example.com" });
    expect(app.requests).toHaveLength(1);
  });

  /** A removal while AI features are off, in either state, answers and reads the list again only once
   * memory has removed the request: the list shown then no longer holds it, and nothing is sent. */
  test.each(["Opt Out of AI on", "the settings file can't be read"] as const)("with %s, a removal reads the list again only once memory has removed it", async (mode) => {
    app.userData = mkdtempSync(join(tmpdir(), "voice-user-data-"));
    const path = join(app.userData, "settings.json");
    if (mode === "the settings file can't be read") {
      app.problems.set(path, { kind: "damaged", path, code: "invalid" });
      app.dialogResponse = 2;
    }
    const database = memoryFolders(join(app.userData, "memory")).databaseFile;
    mkdirSync(dirname(database), { recursive: true });
    writeFileSync(database, "");
    await launch("darwin");
    const memory = app.memory;
    if (memory === null) throw new Error("no memory");
    memory.rows.push(memoryRow("first request", "first reply", Date.now() - 1000, "first"), memoryRow("second request", "second reply", Date.now(), "second"));
    if (mode === "Opt Out of AI on") expect(await send({ type: "setOptsOutOfAI", value: true })).toEqual({ error: null });
    expect(await send({ type: "loadMemory" })).toEqual({ error: null });
    const search = vi.spyOn(memory, "search");
    // Memory's removal held until released, as a busy helper would.
    const remove = memory.remove.bind(memory);
    let release = () => {};
    const removing = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(memory, "remove").mockImplementation(async (ids) => {
      await removing;
      return remove(ids);
    });
    let answered = false;
    const pending = send({ type: "removeMemory", memId: "turn:first" }).then((result) => {
      answered = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([answered, search.mock.calls.length, memory.rows.map((row) => row.memId)]).toEqual([false, 0, ["turn:first", "turn:second"]]);
    release();
    expect(await pending).toEqual({ error: null });
    const shown = app.handlers.get(channels.getState)?.({}, "settings") as SettingsState;
    expect([memory.rows.map((row) => row.memId), shown.memory.entries.map((row) => row.memId)]).toEqual([["turn:second"], ["turn:second"]]);
    expect([search.mock.calls.map(([asked]) => asked.query), app.requests.length]).toEqual([[""], 0]);
  });

  /** What applies is what is saved (owner, 2026-10-28): Opt Out of AI that couldn't be written says so,
   * on or off, and Settings, the menu and AI features are as they were. */
  test("Opt Out of AI that couldn't be saved says so, and the switch shows what is saved", async () => {
    await launch("darwin");
    const settingsState = () => app.handlers.get(channels.getState)?.({}, "settings") as SettingsState;
    const unsaved = { error: "This couldn't be saved, so nothing changed. Check the disk and try again." };
    const pushes = app.trayUpdates;
    app.savesFail = true;
    expect(await send({ type: "setOptsOutOfAI", value: true })).toEqual(unsaved);
    expect([settingsState().optsOutOfAI, app.trayState?.().optsOutOfAI, app.stored.has("optsOutOfAI"), app.trayUpdates]).toEqual([false, false, false, pushes]);
    await send({ type: "sendCode", email: "user@example.com" });
    expect(await send({ type: "loadMemory" })).toEqual({ error: null });

    app.savesFail = false;
    expect(await send({ type: "setOptsOutOfAI", value: true })).toEqual({ error: null });
    app.savesFail = true;
    expect(await send({ type: "setOptsOutOfAI", value: false })).toEqual(unsaved);
    expect([settingsState().optsOutOfAI, app.trayState?.().optsOutOfAI, app.stored.get("optsOutOfAI")]).toEqual([true, true, true]);
    expect(await send({ type: "searchMemory", query: "friday" })).toEqual({ error: `${optedOutOfAIMemoryLine}.` });
  });

  /** A settings file removed by hand (the fix dialog's first way) took the user's size limit with it: at
   * the next launch, with memory's database there, the limit is "Not set", as after the reset, and
   * memory is never trimmed to the default. Without memory, or with the file there, nothing changes. */
  test.each([
    ["removed by hand, memory kept", true, true, null],
    ["not there, and no memory yet", true, false, undefined],
    ["there, with memory", false, true, undefined],
  ])("a settings file %s: the size limit stored is %s", async (_, missing, hasMemory, expected) => {
    app.userData = mkdtempSync(join(tmpdir(), "voice-user-data-"));
    if (missing) app.missingFiles.add(join(app.userData, "settings.json"));
    if (hasMemory) {
      const database = memoryFolders(join(app.userData, "memory")).databaseFile;
      mkdirSync(dirname(database), { recursive: true });
      writeFileSync(database, "");
    }
    await launch("darwin");
    const memory = app.memory;
    if (memory === null) throw new Error("no memory");
    const trim = vi.spyOn(memory, "trim");
    const sizeLimit = () => (app.handlers.get(channels.getState)?.({}, "settings") as SettingsState).memory.sizeLimit;
    const shown = expected === null ? null : config.memorySizeLimitDefault;
    // Shown from the start, before Settings › Memory reads memory.
    expect(sizeLimit()).toBe(shown);
    expect(await send({ type: "loadMemory" })).toEqual({ error: null });
    expect([app.stored.get("memorySizeLimit"), sizeLimit(), trim.mock.calls.length]).toEqual([expected, shown, 0]);
  });

  /** The size limit the user chose was in the settings file that couldn't be read: the reset leaves it
   * "Not set", and memory is never trimmed until the user picks one (owner, 2026-10-28). */
  test("a settings reset never trims memory: its size limit is not set until the user picks one", async () => {
    app.userData = mkdtempSync(join(tmpdir(), "voice-user-data-"));
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    const database = memoryFolders(join(app.userData, "memory")).databaseFile;
    mkdirSync(dirname(database), { recursive: true });
    writeFileSync(database, "");
    await launch("darwin");
    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);
    const memory = app.memory;
    if (memory === null) throw new Error("no memory");
    const trim = vi.spyOn(memory, "trim");
    const sizeLimit = () => (app.handlers.get(channels.getState)?.({}, "settings") as SettingsState).memory.sizeLimit;
    expect(sizeLimit()).toBeNull();

    app.dialogResponses = [1, 0];
    app.trayActions?.showFileProblem("settings");
    expect(await eventually(() => app.movedAside.length === 1)).toBe(true);
    expect(await send({ type: "loadMemory" })).toEqual({ error: null });
    expect([app.stored.get("memorySizeLimit"), sizeLimit(), trim.mock.calls.length]).toEqual([null, null, 0]);

    const choice = config.memorySizeLimitChoices[0] ?? 0;
    // A first pick that couldn't be saved leaves it not set: nothing is trimmed, now or later.
    app.savesFail = true;
    expect(await send({ type: "setMemorySizeLimit", value: choice })).toEqual({ error: "That size limit couldn't be saved. Try again." });
    expect([app.stored.has("memorySizeLimit"), app.stored.get("memorySizeLimit"), sizeLimit(), trim.mock.calls.length]).toEqual([true, null, null, 0]);
    app.savesFail = false;
    expect(await send({ type: "setMemorySizeLimit", value: choice })).toEqual({ error: null });
    expect([app.stored.get("memorySizeLimit"), sizeLimit(), trim.mock.calls]).toEqual([choice, choice, [[choice]]]);
  });

  test("a knowledge base file that can't be read leaves Settings › Memory reaching memory", async () => {
    app.userData = mkdtempSync(join(tmpdir(), "voice-user-data-"));
    const path = join(app.userData, "userPrompts.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    const database = memoryFolders(join(app.userData, "memory")).databaseFile;
    mkdirSync(dirname(database), { recursive: true });
    writeFileSync(database, "");
    await launch("darwin");
    const memory = app.memory;
    if (memory === null) throw new Error("no memory");
    const stats = vi.spyOn(memory, "stats");

    expect(await send({ type: "loadMemory" })).toEqual({ error: null });
    expect(stats).toHaveBeenCalled();
  });

  /** The user's factory reset (owner, 2026-10-27), offered by the fix dialog after the steps by hand:
   * never on its own, and nothing moves until its one confirmation is answered Reset. */
  test("a file that can't be read is never reset unless the user asks and confirms", async () => {
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    await launch("darwin");
    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);
    expect(app.dialogs[0]).toMatchObject({ buttons: ["Show File", "Reset to Defaults…", "Close"], defaultId: 2, cancelId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.movedAside).toEqual([]);

    // Reset to Defaults…, then Cancel.
    app.dialogResponses = [1, 1];
    app.trayActions?.showFileProblem("settings");
    expect(await eventually(() => app.dialogs.length === 3)).toBe(true);
    expect(app.dialogs[2]).toMatchObject({ message: "Reset your settings to the defaults?", buttons: ["Reset", "Cancel"], defaultId: 1, cancelId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.movedAside).toEqual([]);
    expect(app.presented).toEqual([]);
    expect(app.trayState?.().fileProblems).toEqual(["settings"]);
  });

  test("a confirmed reset of the settings file keeps it as a dated copy and starts setup as at a first launch", async () => {
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    await launch("darwin");
    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);
    // Changes this session made, held until quit only.
    await send({ type: "setReadsScreen", value: false });
    const state = () => app.handlers.get(channels.getState)?.({}, "settings") as SettingsState;
    const [defaultHotkey, otherHotkey] = state().availableHotkeys;
    await send({ type: "setHotkey", hotkey: otherHotkey });
    expect(state().hotkey).toBe(otherHotkey);
    const configured = () => app.helpers.get("voice-hotkey")!.requests.filter((request) => request.method === "configure");
    const pushed: unknown[] = [];
    app.listeners.set("voice:state", [...(app.listeners.get("voice:state") ?? []), (_event, name, pushedState) => void (name === "settings" && pushed.push((pushedState as SettingsState).fileProblems))]);
    const trayUpdates = app.trayUpdates;

    const before = Math.floor(Date.now() / 1_000) * 1_000;
    app.dialogResponses = [1, 0];
    app.trayActions?.showFileProblem("settings");
    expect(await eventually(() => app.movedAside.length === 1)).toBe(true);
    const after = Date.now();
    const moved = app.movedAside[0];
    if (moved === undefined) throw new Error("not moved");
    expect(moved.path).toBe(path);
    // Dated with the time of the reset.
    const stamps: string[] = [];
    for (let time = before; time <= after; time += 1_000) stamps.push(resetCopyPath(path, new Date(time)));
    expect(stamps).toContain(moved.aside);
    expect(dirname(moved.aside)).toBe(dirname(path));
    expect(basename(moved.aside)).toMatch(/^settings \(before reset \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\)\.json$/);
    // The confirmation said where it is kept.
    expect(app.dialogs[2]?.detail).toContain(moved.aside);
    // As at a first launch: the welcome wizard, consent not given, and no Fix item.
    expect(await eventually(() => app.presented.includes("welcome"))).toBe(true);
    expect(app.trayState?.().hasConsented).toBe(false);
    expect(app.trayState?.().fileProblems).toEqual([]);
    expect(app.trayUpdates).toBeGreaterThan(trayUpdates);
    // As at a first launch, the wizard's consent page says what's new: the tip that would is learned.
    expect(app.stored.get("tip.agentKnowledgeBase.learned")).toBe(true);
    // Settings shows the defaults, and the hotkey the session had changed is the default key again.
    expect(pushed).toContainEqual([]);
    expect(state().hotkey).toBe(defaultHotkey);
    expect(configured().at(-1)).toMatchObject({ params: expect.objectContaining({ hotkey: defaultHotkey }) });
    // Saved again from now on, on the defaults: the change held in memory is gone.
    expect(app.stored.has("readsScreen")).toBe(false);
    expect(await send({ type: "setLearnsWords", value: false })).toEqual({ error: null });
    expect(app.stored.get("learnsWords")).toBe(false);
  });

  /** Only the settings file's reset is a first launch: a knowledge base reset leaves setup not yet
   * finished as it was, the wizard not opened again. */
  test("a knowledge base reset opens no wizard, setup finished or not", async () => {
    const path = join(app.userData, "userPrompts.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.stored.set("hasFinishedWelcome", false);
    app.dialogResponse = 2;
    await launch("darwin");
    expect(await eventually(() => app.dialogs.length === 1 && app.presented.includes("welcome"))).toBe(true);
    const presented = app.presented.length;

    app.dialogResponses = [1, 0];
    app.trayActions?.showFileProblem("knowledgeBase");
    expect(await eventually(() => app.movedAside.length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.presented).toHaveLength(presented);
  });

  test("a confirmed reset of the knowledge base file keeps it as a dated copy, and opens no wizard", async () => {
    const path = join(app.userData, "userPrompts.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    await launch("darwin");
    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);

    const trayUpdates = app.trayUpdates;
    const pushed: unknown[] = [];
    app.listeners.set("voice:state", [...(app.listeners.get("voice:state") ?? []), (_event, name, pushedState) => void (name === "settings" && pushed.push((pushedState as SettingsState).fileProblems))]);
    app.dialogResponses = [1, 0];
    app.trayActions?.showFileProblem("knowledgeBase");
    expect(await eventually(() => app.movedAside.length === 1)).toBe(true);
    expect(app.dialogs[2]?.message).toBe("Reset your knowledge base, writing style and their history to the defaults?");
    expect(basename(app.movedAside[0]?.aside ?? "")).toMatch(/^userPrompts \(before reset .+\)\.json$/);
    expect(app.trayState?.().fileProblems).toEqual([]);
    expect(app.trayUpdates).toBeGreaterThan(trayUpdates);
    expect(pushed).toContainEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.presented).toEqual([]);
    // Saved again from now on.
    expect(await send({ type: "resetKnowledgeBase" })).toEqual({ error: null });
  });

  test("a reset that can't move the file changes nothing, and says so", async () => {
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    app.moveAsideFails = true;
    await launch("darwin");
    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);

    const trayUpdates = app.trayUpdates;
    app.dialogResponses = [1, 0];
    app.trayActions?.showFileProblem("settings");
    expect(await eventually(() => app.dialogs.length === 4)).toBe(true);
    expect(app.dialogs[3]?.message).toBe("TabMail Voice couldn't reset its settings file.");
    expect(app.trayState?.().fileProblems).toEqual(["settings"]);
    expect(app.trayUpdates).toBe(trayUpdates);
    expect(app.presented).toEqual([]);
  });

  /** Two fix dialogs open at once (the launch one and the menu's; a dialog without a window isn't modal
   * on Windows and Linux), both confirmed: the first resets, and the second has nothing left to reset. */
  test("a second confirmation after the reset changes nothing and says nothing", async () => {
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    await launch("linux");
    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);

    app.dialogResponses = [1, 1, 0, 0];
    app.trayActions?.showFileProblem("settings");
    app.trayActions?.showFileProblem("settings");
    expect(await eventually(() => app.movedAside.length === 1 && app.presented.includes("welcome"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.movedAside).toHaveLength(1);
    expect(app.dialogs.map((dialog) => dialog.message)).toEqual([
      "TabMail Voice's settings file is damaged.",
      "TabMail Voice's settings file is damaged.",
      "TabMail Voice's settings file is damaged.",
      "Reset your settings to the defaults?",
      "Reset your settings to the defaults?",
    ]);
  });

  /** A fix dialog left open while another reset the file: its Reset to Defaults… finds nothing to
   * reset, and asks nothing. */
  test("a fix dialog answered after the reset asks nothing and changes nothing", async () => {
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    await launch("linux");
    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);

    let answer: (response: number) => void = () => {};
    const held = new Promise<number>((resolve) => (answer = resolve));
    app.dialogResponses = [1, held, 0];
    app.trayActions?.showFileProblem("settings");
    app.trayActions?.showFileProblem("settings");
    expect(await eventually(() => app.movedAside.length === 1)).toBe(true);
    answer(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.movedAside).toHaveLength(1);
    expect(app.dialogs).toHaveLength(4);
  });

  /** fn as the hotkey holds the Globe key at Do Nothing, the user's own action kept in the settings
   * file to be put back (ADR-DESK-031): a reset keeps it, and the default hotkey hands the key back. */
  test("a settings reset while fn is the hotkey puts the Globe key's action back", async () => {
    const path = join(app.userData, "settings.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.dialogResponse = 2;
    await launch("darwin");
    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);
    let globe = 2;
    const helper = app.helpers.get("voice-macos")!;
    helper.replies.set("globeRead", () => ({ value: globe }));
    helper.replies.set("globeUpdate", (params: { value: number }) => {
      globe = params.value;
      return {};
    });
    await send({ type: "setHotkey", hotkey: "function" });
    expect(await eventually(() => globe === 0)).toBe(true);

    app.dialogResponses = [1, 0];
    app.trayActions?.showFileProblem("settings");
    expect(await eventually(() => app.movedAside.length === 1)).toBe(true);
    expect(await eventually(() => globe === 2)).toBe(true);
    expect(app.stored.has("globeKeyActionBeforeFnHotkey")).toBe(false);
  });

  /** Only the settings file keeps the wizard closed: with the knowledge base's file unreadable alone,
   * setup not yet finished opens the wizard at launch and from the menu, and that file's own dialog is
   * the only one shown. */
  test("a knowledge base file that can't be read leaves the welcome wizard as ever", async () => {
    const path = join(app.userData, "userPrompts.json");
    app.problems.set(path, { kind: "damaged", path, code: "invalid" });
    app.stored.set("hasFinishedWelcome", false);
    app.dialogResponse = 2;
    await launch("darwin");

    expect(await eventually(() => app.dialogs.length === 1)).toBe(true);
    expect(app.presented).toEqual(["welcome"]);
    app.presented = [];
    app.trayActions?.showWelcome();
    expect(app.presented).toEqual(["welcome"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.dialogs).toHaveLength(1);
    expect(app.dialogs[0]?.message).toContain("knowledge base");
  });

  describe("updates (ADR-DESK-041, ADR-DESK-050)", () => {
    /** A packaged build, launched with its resources where Electron puts them. */
    async function launchPackaged(platform: NodeJS.Platform = "darwin", resources = "/nonexistent", linuxExecutable?: string): Promise<void> {
      app.packaged = true;
      Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
      await launch(platform, linuxExecutable);
    }
    /** Lets the update's proof finish, and the question it schedules be asked. */
    const settle = async () => {
      for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
    };
    /** `electron-updater` has downloaded `version`, and macOS has accepted it. */
    function downloaded(version: string): void {
      app.autoUpdater?.emit("update-downloaded", { version });
      app.squirrel?.emit("update-downloaded");
    }

    /** Windows: the NSIS updater, its library's signature check replaced by the app's own, the
     * installer quiet and the new version opened after it. */
    test("a packaged Windows build updates through its own installer, proven by the app", async () => {
      const runs: [string, string[]][] = [];
      const signed = { signatureValid: true, commonName: config.windowsUpdatePublisher, organization: config.windowsUpdatePublisher, productVersion: "9.9.9.0" };
      vi.doMock("../../src/main/native/windows/update.js", async (original) => {
        const real = await original<typeof import("../../src/main/native/windows/update.js")>();
        return {
          ...real,
          windowsUpdatePlatform: (options: Parameters<typeof real.windowsUpdatePlatform>[0]) =>
            real.windowsUpdatePlatform({ ...options, run: async (file, args) => { runs.push([file, args]); return { code: 0, stdout: JSON.stringify(signed) }; } }),
        };
      });
      try {
        await launchPackaged("win32");
        const updater = app.autoUpdater;

        expect(updater?.kind).toBe("nsis");
        expect(updater?.logger).toBeNull();
        expect(updater?.disableWebInstaller).toBe(true);
        expect(updater?.allowDowngrade).toBe(false);
        expect(updater?.autoInstallOnAppQuit).toBe(true);
        expect(updater?.requestHeaders).toEqual({ "x-user-staging-id": "none" });
        expect(typeof updater?.verifyUpdateCodeSignature).toBe("function");
        expect(app.trayState?.().update).toEqual({ kind: "idle" });

        // A download refused (not newer) doesn't install when the app quits.
        updater?.emit("update-downloaded", { version: "0.0.0", downloadedFile: "C:\\cache\\old.exe" });
        await settle();
        const quit = () => app.appEvents.get("before-quit")?.({ preventDefault() {} });
        quit();
        expect(updater?.autoInstallOnAppQuit).toBe(false);

        updater?.emit("update-available", { version: "9.9.9" });
        updater?.emit("update-downloaded", { version: "9.9.9", downloadedFile: "C:\\cache\\installer.exe" });
        await settle();
        // The helper proved the installer kept.
        expect(runs.map(([file, args]) => [file.endsWith("voice-windows.exe"), args])).toEqual([[true, ["--verify-update", "C:\\cache\\installer.exe"]]]);
        expect(app.trayState?.().update).toEqual({ kind: "ready", version: "9.9.9" });
        // The app's quit (this time after its cleanup began) installs the proven one.
        quit();
        expect(updater?.autoInstallOnAppQuit).toBe(true);
        expect(app.dialogs).toEqual([expect.objectContaining({ message: "TabMail Voice 9.9.9 is ready.", buttons: ["Restart Now", "Later"] })]);
        app.trayActions?.installUpdate();
        expect(updater?.installedWith).toEqual([true, true]);
      } finally {
        vi.doUnmock("../../src/main/native/windows/update.js");
      }
    });

    /** apt updates Linux, through the source the package installs (ADR-DESK-058): the app has no
     * updater there, and no update item. */
    test("a packaged Linux build has no updater of its own", async () => {
      await launchPackaged("linux");

      expect(app.autoUpdater).toBeNull();
      expect(app.trayState?.().update).toBeNull();
    });

    /** The AppImage (ADR-DESK-059): no package, so it puts itself on the desktop and updates itself. */
    describe("the Linux AppImage", () => {
      let folder: string;
      const environment = { APPIMAGE: process.env.APPIMAGE, APPDIR: process.env.APPDIR, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
      const argv = process.argv;
      const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
      const appImage = "/home/user/TabMail-Voice-latest-linux-arm64.AppImage";
      afterEach(() => {
        for (const [name, value] of Object.entries(environment)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        process.argv = argv;
        Object.defineProperty(process, "arch", arch);
        rmSync(folder, { recursive: true, force: true });
        vi.doUnmock("../../src/main/native/linux/update.js");
        vi.doUnmock("node:os");
      });
      /** Launches the AppImage at `appImage` with `args`, its resources, the home folder and the
       * user's config folder in a temporary folder, the data folder `dataHome` gives (`folder/share`
       * by default; undefined for none set), and the executable in the folder its runtime mounted
       * (`APPDIR`); with `foreign`, the package's app started from another AppImage, which inherits
       * that one's `APPIMAGE` and `APPDIR`. Returns what it asked to open once it quit. */
      async function launchAppImage(args: string[], options: { packaged?: boolean; dataHome?: (folder: string) => string | undefined; loginEntry?: string; foreign?: boolean } = {}): Promise<{ executable: string; args: string[] }[]> {
        folder = mkdtempSync(join(tmpdir(), "voice-appimage-"));
        const resources = join(folder, "resources");
        mkdirSync(join(resources, "linux", "icons"), { recursive: true });
        mkdirSync(join(resources, "linux", "gnome", "voice-caret@tabmail.ai"), { recursive: true });
        writeFileSync(join(resources, "linux", "icons", "256x256.png"), "icon");
        writeFileSync(join(resources, "linux", "gnome", "voice-caret@tabmail.ai", "metadata.json"), "{}");
        const home = join(folder, "home");
        vi.doMock("node:os", async () => ({ ...await vi.importActual<typeof import("node:os")>("node:os"), homedir: () => home }));
        process.env.APPIMAGE = appImage;
        const mount = join(folder, ".mount_TabMail");
        mkdirSync(mount);
        process.env.APPDIR = mount;
        const executable = options.foreign ? "/opt/TabMail Voice/tabmail-voice" : join(realpathSync(mount), "tabmail-voice");
        const dataHome = options.dataHome ? options.dataHome(folder) : join(folder, "share");
        if (dataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = dataHome;
        process.env.XDG_CONFIG_HOME = join(folder, "config");
        if (options.loginEntry !== undefined) {
          mkdirSync(join(folder, "config", "autostart"), { recursive: true });
          writeFileSync(join(folder, "config", "autostart", "ai.tabmail.voice.desktop"), options.loginEntry);
        }
        process.argv = [executable, ...args];
        Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
        const relaunches: { executable: string; args: string[] }[] = [];
        vi.doMock("../../src/main/native/linux/update.js", async (original) => {
          const real = await original<typeof import("../../src/main/native/linux/update.js")>();
          const relaunch = (options: { executable: string; args: string[] }) => relaunches.push({ executable: options.executable, args: options.args });
          return {
            ...real,
            relaunchAfterExit: relaunch,
            // gpgv holds every update: the signature check itself is the update module's tests'.
            appImageUpdatePlatform: (platformOptions: Parameters<typeof real.appImageUpdatePlatform>[0]) => real.appImageUpdatePlatform({ ...platformOptions, run: () => Promise.resolve({ code: 0, stdout: "" }), relaunch }),
          };
        });
        if (options.packaged === false) {
          Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
          await launch("linux", executable);
        } else {
          await launchPackaged("linux", resources, executable);
        }
        return relaunches;
      }

      test("it updates itself from its architecture's feed, and is on the desktop as the app", async () => {
        const relaunches = await launchAppImage(["--ozone-platform=x11", "--no-sandbox"]);
        const updater = app.autoUpdater;

        expect(app.exits).toEqual([]);
        expect(updater?.kind).toBe("appimage");
        expect(updater?.logger).toBeNull();
        expect(updater?.feed).toEqual({ provider: "generic", url: "https://cdn.tabmail.ai/releases/voice/linux-arm64", useMultipleRangeRequest: false });
        expect(updater?.allowDowngrade).toBe(false);
        expect(app.trayState?.().update).toEqual({ kind: "idle" });
        expect(readFileSync(join(folder, "share", "applications", "ai.tabmail.voice.desktop"), "utf8")).toContain(`Exec="${appImage}" --ozone-platform=x11 %U\n`);
        expect(readFileSync(join(folder, "share", "gnome-shell", "extensions", "voice-caret@tabmail.ai", "metadata.json"), "utf8")).toBe("{}");
        expect(relaunches).toEqual([]);
      });

      /** The XDG Base Directory rule: a data folder that isn't an absolute path is ignored. */
      test.each([
        ["unset", () => undefined],
        ["relative", () => "relative/share"],
      ])("with the data folder %s, it uses ~/.local/share", async (_case, dataHome) => {
        await launchAppImage(["--ozone-platform=x11"], { dataHome });

        expect(readFileSync(join(folder, "home", ".local", "share", "applications", "ai.tabmail.voice.desktop"), "utf8")).toContain(`Exec="${appImage}" `);
        expect(existsSync(join(folder, "share"))).toBe(false);
      });

      /** The login item is the user's: a launch never rewrites it, whether it names an earlier path of
       * the AppImage or the user turned it off. */
      test.each([
        ["names another path", `[Desktop Entry]\nType=Application\nName=TabMail Voice\nExec="/home/user/Old.AppImage" --ozone-platform=x11\nX-GNOME-Autostart-enabled=true\n`],
        ["is turned off", `[Desktop Entry]\nType=Application\nName=TabMail Voice\nExec="${appImage}" --ozone-platform=x11\nX-GNOME-Autostart-enabled=true\nHidden=true\n`],
      ])("a login item that %s is left as it is", async (_case, entry) => {
        await launchAppImage(["--ozone-platform=x11"], { loginEntry: entry });

        expect(readFileSync(join(folder, "config", "autostart", "ai.tabmail.voice.desktop"), "utf8")).toBe(entry);
        expect(existsSync(join(folder, "share", "applications", "ai.tabmail.voice.desktop"))).toBe(true);
      });

      /** Opened from Files, the AppImage's launcher passes no arguments: Electron has already chosen
       * its display backend, so the app opens itself again with the X11 one, and starts nothing. */
      test("opened without the X11 argument, it opens itself again with it", async () => {
        const relaunches = await launchAppImage(["--no-sandbox"]);

        expect(app.exits).toEqual([0]);
        expect(relaunches).toEqual([{ executable: appImage, args: ["--no-sandbox", "--ozone-platform=x11"] }]);
        expect(app.autoUpdater).toBeNull();
        expect(app.helpers.size).toBe(0);
      });

      /** Restart Now, once gpgv has held the download: the AppImage is replaced, the new one asked to
       * open once the app is gone, and the app quits. */
      test("Restart Now installs the proven update, opens it again and quits", async () => {
        const relaunches = await launchAppImage(["--ozone-platform=x11"]);
        const updater = app.autoUpdater;
        const downloadedFile = join(folder, "update.AppImage");
        writeFileSync(downloadedFile, "the new AppImage");

        updater?.emit("update-available", { version: "9.9.9" });
        updater?.emit("update-downloaded", { version: "9.9.9", downloadedFile, signature: "c2ln" });
        expect(updater?.installs).toBe(0);
        // The proof reads the download and runs gpgv: real file work, so more than a few turns.
        expect(await eventually(() => (app.trayState?.().update as { kind: string } | null)?.kind === "ready")).toBe(true);
        expect(app.trayState?.().update).toEqual({ kind: "ready", version: "9.9.9" });
        expect(relaunches).toEqual([]);
        expect(app.quits).toBe(0);

        app.trayActions?.installUpdate();

        expect(updater?.installs).toBe(1);
        expect(updater?.installedWith).toEqual([true, false]);
        expect(relaunches).toEqual([{ executable: appImage, args: ["--ozone-platform=x11"] }]);
        expect(app.quits).toBe(1);
      });

      /** The desktop entry is a convenience: a data folder it can't be written to doesn't stop the app. */
      test("a data folder that can't be written to still lets the app start", async () => {
        await launchAppImage(["--ozone-platform=x11"], {
          dataHome: (folder) => {
            writeFileSync(join(folder, "share"), "a file, not a folder");
            return join(folder, "share");
          },
        });

        expect(readFileSync(join(folder, "share"), "utf8")).toBe("a file, not a folder");
        expect(app.exits).toEqual([]);
        expect(app.autoUpdater?.kind).toBe("appimage");
        expect(app.helpers.size).toBeGreaterThan(0);
      });

      /** The package's app opened from another AppImage (a terminal or an editor packaged so) inherits
       * that one's `APPIMAGE` and `APPDIR`: it isn't that AppImage, so it neither opens it, nor puts it
       * on the desktop, nor ever replaces it with an update, and its login item names the package. */
      test.each([
        ["with the X11 argument", ["--ozone-platform=x11"]],
        ["without it", ["--no-sandbox"]],
      ])("the package's app started from another AppImage, %s, is the package's", async (_case, args) => {
        const relaunches = await launchAppImage(args, { foreign: true });

        expect(app.exits).toEqual([]);
        expect(relaunches).toEqual([]);
        expect(app.autoUpdater).toBeNull();
        expect(app.trayState?.().update).toBeNull();
        expect(existsSync(join(folder, "share"))).toBe(false);
        await send({ type: "setOpenAtLogin", value: true });
        expect(readFileSync(join(folder, "config", "autostart", "ai.tabmail.voice.desktop"), "utf8")).toContain(`Exec="/opt/TabMail Voice/tabmail-voice" `);
      });

      /** A development run started from an AppImage's shell inherits its `APPIMAGE`: it is not that
       * AppImage, so it opens nothing again, writes nothing on the desktop and has no updater. */
      test("a build that isn't packaged ignores an inherited APPIMAGE", async () => {
        const relaunches = await launchAppImage(["--no-sandbox"], { packaged: false });

        expect(app.exits).toEqual([]);
        expect(relaunches).toEqual([]);
        expect(app.autoUpdater).toBeNull();
        expect(existsSync(join(folder, "share"))).toBe(false);
      });
    });

    test("a debug build has no updater and no update item", async () => {
      await launch("darwin");

      expect(app.trayState?.().update).toBeNull();
      app.trayActions?.checkForUpdates();
      app.trayActions?.installUpdate();
    });

    // Each architecture the app can run as: the universal app runs as either.
    test.each(["arm64", "x64"])("a packaged build running as %s updates by itself from that architecture's feed, silently to the console, and shows it in the menu", async (runningAs) => {
      const arch = Object.getOwnPropertyDescriptor(process, "arch");
      Object.defineProperty(process, "arch", { value: runningAs, configurable: true });
      try {
        await launchPackaged();
      } finally {
        if (arch) Object.defineProperty(process, "arch", arch);
      }
      const updater = app.autoUpdater;

      expect(updater?.autoDownload).toBe(true);
      expect(updater?.autoInstallOnAppQuit).toBe(true);
      expect(updater?.logger).toBeNull();
      expect(updater?.requestHeaders).toEqual({ "x-user-staging-id": "none" });
      // The feed of the architecture it runs as, whatever it was built as.
      expect(updater?.feed).toEqual({ provider: "generic", url: `https://cdn.tabmail.ai/releases/voice/macos-${runningAs}`, useMultipleRangeRequest: false });
      expect(app.trayState?.().update).toEqual({ kind: "idle" });
      app.trayActions?.checkForUpdates();
      expect(updater?.checks).toBe(1);
      expect(app.trayState?.().update).toEqual({ kind: "checking" });
    });

    test("a packaged build looks for an update by itself after launching", async () => {
      vi.useFakeTimers();
      try {
        // The import can take several turns of the event loop (more after a test mocks a module), and
        // the launch's own zero-delay timer runs only once the clock is advanced after it.
        let launched = false;
        void launchPackaged().then(() => (launched = true));
        while (!launched) await vi.advanceTimersByTimeAsync(0);
        expect(app.autoUpdater?.checks).toBe(0);

        await vi.advanceTimersByTimeAsync(config.updateFirstCheckDelay);
        expect(app.autoUpdater?.checks).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    /** Updates aren't AI: a file that can't be read, the settings one included, leaves them as ever
     * (owner, 2026-10-27). */
    test.each(["settings.json", "userPrompts.json"])("a packaged build with %s unreadable looks for updates as ever", async (file) => {
      vi.useFakeTimers();
      try {
        const path = join(app.userData, file);
        app.problems.set(path, { kind: "damaged", path, code: "invalid" });
        app.dialogResponse = 2;
        let launched = false;
        void launchPackaged().then(() => (launched = true));
        while (!launched) await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(config.updateFirstCheckDelay);
        expect(app.autoUpdater?.checks).toBe(1);
        expect(app.trayState?.().update).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    /** Opt Out of AI turns AI off, not the app (owner, 2026-10-28): updates as ever, on their own and
     * when asked. */
    test("a packaged build with Opt Out of AI on updates as ever, when asked too", async () => {
      app.stored.set("optsOutOfAI", true);
      await launchPackaged();
      expect(app.trayState?.().update).toEqual({ kind: "idle" });
      expect(await send({ type: "checkForUpdates" })).toEqual({ error: null });
      expect(app.autoUpdater?.checks).toBe(1);
      expect(app.trayState?.().update).toEqual({ kind: "checking" });
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
      await send({ type: "installUpdate" });
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
      app.trayActions?.installUpdate();
      expect(updater?.installs).toBe(1);
    });

    /** A text not pasted (ADR-DESK-042), its note showing, ends a dictation as a failure does. */
    test.each(["failed", "notPasted"])("after a %s dictation, Restart Now installs at once", async (ended) => {
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


test.each(["blocks", "recovers"] as const)("shell event %s revealed placement while the caret lookup is pending", async (direction) => {
  await launch("win32");
  const helper = app.helpers.get("voice-windows");
  expect(helper).toBeDefined();
  if (!helper) return;
  helper.replies.set("frontmostApp", { window: 42 });
  helper.replies.set("caretAnchor", null);
  const captured = app.overlay as unknown as {
    locate: () => Promise<Rect | null>;
    place: (area: Rect) => Rect | null;
    refreshPlacement: () => void;
  };
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  if (direction === "recovers") {
    helper.replies.set("shellExclusionBounds", [area]);
    helper.events.get("shellGeometryChanged")?.({ event: "shellGeometryChanged" });
    await vi.waitFor(() => expect(captured.place(area)).toBeNull());
  }
  const exclusions = direction === "blocks" ? [area] : [];
  let visible = false;
  let bounds = { x: 0, y: 0, width: 1, height: 1 };
  const surface = {
    isVisible: () => visible, showInactive: () => { visible = true; }, hide: () => { visible = false; },
    setBounds: (next: Rect) => { bounds = next; }, getBounds: () => bounds, setOpacity() {}, setIgnoreMouseEvents() {}, setShape() {},
  };
  const { OverlayWindowController: RealOverlay } = await vi.importActual<typeof import("../../src/main/overlayWindow.js")>("../../src/main/overlayWindow.js");
  const real = new RealOverlay(surface, captured.locate, captured.place);
  captured.refreshPlacement = () => real.refreshPlacement();
  const eventReply = Promise.withResolvers<Rect[]>();
  const caretReply = Promise.withResolvers<Rect | null>();
  helper.replies.set("caretAnchor", caretReply.promise);
  helper.replies.set("shellExclusionBounds", eventReply.promise);
  helper.events.get("shellGeometryChanged")?.({ event: "shellGeometryChanged" });
  await vi.waitFor(() => expect(helper.requests.some(r => r.method === "shellExclusionBounds")).toBe(true));
  real.update({ kind: "arming" });
  real.update({ kind: "listening" });
  for (let i = 0; i < 8; i++) await new Promise<void>(queueMicrotask);
  eventReply.resolve(exclusions);
  await vi.waitFor(() => expect(captured.place(area)).toEqual(direction === "blocks" ? null : area));
  for (let i = 0; i < 8; i++) await new Promise<void>(queueMicrotask);
  expect(visible).toBe(direction === "recovers");
  caretReply.resolve(null);
});


test.each(["initial shell state", "failed close refresh", "helper restart"])("placement recovers for %s", async (scenario) => {
  await launch("win32");
  const helper = app.helpers.get("voice-windows")!;
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  helper.replies.set("frontmostApp", { window: 42 });
  helper.replies.set("caretAnchor", { x: 100, y: 100, width: 1, height: 20 });
  const captured = app.overlay as unknown as { locate: () => Promise<Rect | null>; place: (area: Rect) => Rect | null; refreshPlacement: () => void };
  let visible = false;
  let bounds = { x: 0, y: 0, width: 1, height: 1 };
  const surface = { isVisible: () => visible, showInactive: () => { visible = true; }, hide: () => { visible = false; }, setBounds: (next: Rect) => { bounds = next; }, getBounds: () => bounds, setOpacity() {}, setIgnoreMouseEvents() {}, setShape() {} };
  const { OverlayWindowController: RealOverlay } = await vi.importActual<typeof import("../../src/main/overlayWindow.js")>("../../src/main/overlayWindow.js");
  const real = new RealOverlay(surface, captured.locate, captured.place);
  captured.refreshPlacement = () => real.refreshPlacement();
  const emit = () => helper.events.get("shellGeometryChanged")?.({ event: "shellGeometryChanged" });
  if (scenario !== "initial shell state") {
    helper.replies.set("shellExclusionBounds", [area]);
    emit();
    await vi.waitFor(() => expect(captured.place(area)).toBeNull());
    real.update({ kind: "arming" });
    for (let i = 0; i < 16; i++) await new Promise<void>(queueMicrotask);
    real.update({ kind: "listening" });
    expect(visible).toBe(false);
    if (scenario === "failed close refresh") {
      const failed = Promise.withResolvers<Rect[]>();
      helper.replies.set("shellExclusionBounds", failed.promise);
      emit();
      failed.reject(new Error("synthetic dependency timeout"));
      await new Promise(resolve => setTimeout(resolve, 0));
    } else {
      helper.onExit?.();
      helper.onStart?.();
    }
    // The restarted watcher seeds its baseline from the now-closed shell;
    // the failed-close watcher already recorded that same baseline before emitting.
    helper.replies.set("shellExclusionBounds", []);
    real.update({ kind: "idle" });
  } else {
    // ShellWatch seeds previous with this state and sends no initial event.
    helper.replies.set("shellExclusionBounds", [area]);
  }
  real.update({ kind: "arming" });
  for (let i = 0; i < 16; i++) await new Promise<void>(queueMicrotask);
  real.update({ kind: "listening" });
  expect.soft(captured.place(area)).toEqual(scenario === "initial shell state" ? null : area);
  expect.soft(visible).toBe(scenario !== "initial shell state");
  helper.replies.set("shellExclusionBounds", []);
  emit();
  await vi.waitFor(() => expect(captured.place(area)).toEqual(area));
  await vi.waitFor(() => expect(visible).toBe(true));
  expect(app.clipboard).toEqual([]);
  expect(helper.requests.some(r => r.method === "insert")).toBe(false);
});


test.each(["darwin", "win32"] as const)("ready %s caret keeps its foreground target and placement", async (platform) => {
  await launch(platform);
  const helper=app.helpers.get(platform === "win32" ? "voice-windows" : "voice-macos")!;
  helper.replies.set("frontmostApp", platform === "win32" ? {} : {pid:42});
  const caret={x:500,y:300,width:1,height:20};
  helper.replies.set("caretAnchor",caret);
  const shellReply=Promise.withResolvers<Rect[]>();
  if (platform === "win32") {
    helper.replies.set("shellExclusionBounds",shellReply.promise);
    helper.events.get("shellGeometryChanged")?.({event:"shellGeometryChanged"});
  }
  const captured=app.overlay as unknown as {locate:()=>Promise<Rect|null>;place?:(area:Rect)=>Rect|null};
  let visible=false;let bounds={x:0,y:0,width:1,height:1};
  const surface={isVisible:()=>visible,showInactive:()=>{visible=true;},hide:()=>{visible=false;},setBounds:(next:Rect)=>{bounds=next;},getBounds:()=>bounds,setOpacity(){},setIgnoreMouseEvents(){},setShape(){}};
  const {OverlayWindowController:RealOverlay}=await vi.importActual<typeof import("../../src/main/overlayWindow.js")>("../../src/main/overlayWindow.js");
  const real=new RealOverlay(surface,captured.locate,captured.place);
  shellReply.resolve([]);
  real.update({kind:"arming"});
  for(let i=0;i<16;i++) await new Promise<void>(queueMicrotask);
  real.update({kind:"listening"});
  expect.soft(visible).toBe(true);
  expect.soft(real.pillPlace.pill.x).toBe(500.5);
  expect.soft(helper.requests.filter(r=>r.method==="caretAnchor").map(r=>r.params)).toEqual([platform === "win32" ? {} : {pid:42}]);
  expect.soft(app.clipboard).toEqual([]);
  expect.soft(helper.requests.some(r=>r.method==="insert")).toBe(false);
  shellReply.resolve([]);
});

test("overlapping shell close must finish with recovered placement", async()=>{
  await launch("win32");
  const helper=app.helpers.get("voice-windows")!;
  const area={x:0,y:0,width:1440,height:900};
  helper.replies.set("frontmostApp",{window:42});
  const caret=Promise.withResolvers<Rect|null>();
  helper.replies.set("caretAnchor",caret.promise);
  const captured=app.overlay as unknown as {locate:()=>Promise<Rect|null>;place:(area:Rect)=>Rect|null;refreshPlacement:()=>void};
  let visible=false;let bounds={x:0,y:0,width:1,height:1};const states:boolean[]=[];
  const surface={isVisible:()=>visible,showInactive:()=>{visible=true;states.push(true);},hide:()=>{visible=false;states.push(false);},setBounds:(next:Rect)=>{bounds=next;},getBounds:()=>bounds,setOpacity(){},setIgnoreMouseEvents(){},setShape(){}};
  const {OverlayWindowController:RealOverlay}=await vi.importActual<typeof import("../../src/main/overlayWindow.js")>("../../src/main/overlayWindow.js");
  const real=new RealOverlay(surface,captured.locate,captured.place);
  captured.refreshPlacement=()=>real.refreshPlacement();
  helper.replies.set("shellExclusionBounds", []);
  real.update({kind:"arming"});
  for(let i=0;i<16;i++) await new Promise<void>(queueMicrotask);
  real.update({kind:"listening"});expect(visible).toBe(true);
  const first=Promise.withResolvers<Rect[]>();
  helper.replies.set("shellExclusionBounds",first.promise);
  const emit=()=>helper.events.get("shellGeometryChanged")?.({event:"shellGeometryChanged"});
  const before=helper.requests.filter(r=>r.method==="shellExclusionBounds").length;
  emit();
  expect(helper.requests.filter(r=>r.method==="shellExclusionBounds")).toHaveLength(before+1);
  helper.replies.set("shellExclusionBounds",[]);
  emit();
  first.resolve([area]);
  for(let i=0;i<24;i++) await new Promise<void>(queueMicrotask);
  expect.soft(states).toContain(false);
  expect.soft(captured.place(area)).toEqual(area);
  expect.soft(visible).toBe(true);
  expect.soft(helper.requests.filter(r=>r.method==="shellExclusionBounds")).toHaveLength(before+2);
  expect.soft(helper.requests.some(r=>r.method==="insert")).toBe(false);
  caret.resolve(null);
});

test.each([null,{},Array(17).fill({x:0,y:0,width:1,height:1}),[null],[{x:NaN,y:0,width:10,height:10}],[{x:0,y:0,width:0,height:10}]])("malformed shell input retains exclusions then accepts a valid event %j",async(invalid)=>{
  await launch("win32");
  const helper=app.helpers.get("voice-windows")!;
  const area={x:0,y:0,width:1440,height:900};
  const captured=app.overlay as unknown as {place:(area:Rect)=>Rect|null};
  const emit=()=>helper.events.get("shellGeometryChanged")?.({event:"shellGeometryChanged"});
  helper.replies.set("shellExclusionBounds",[area]);emit();
  await vi.waitFor(()=>expect(captured.place(area)).toBeNull());
  helper.replies.set("shellExclusionBounds",invalid);emit();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(captured.place(area)).toBeNull();
  helper.replies.set("shellExclusionBounds",[]);emit();
  await vi.waitFor(()=>expect(captured.place(area)).toEqual(area));
  expect(app.clipboard).toEqual([]);
});



test("slow shell geometry must not withhold an immediately available caret", async () => {
  await launch("win32");
  const helper = app.helpers.get("voice-windows")!;
  helper.replies.set("frontmostApp", { window: 42 });
  helper.replies.set("caretAnchor", { x: 500, y: 300, width: 1, height: 20 });
  const shellReply = Promise.withResolvers<Rect[]>();
  helper.replies.set("shellExclusionBounds", shellReply.promise);
  const captured = app.overlay as unknown as { locate: () => Promise<Rect | null>; place: (area: Rect) => Rect | null; refreshPlacement: () => void };
  let visible = false;
  let bounds = { x: 0, y: 0, width: 1, height: 1 };
  const surface = { isVisible: () => visible, showInactive: () => { visible = true; }, hide: () => { visible = false; }, setBounds: (next: Rect) => { bounds = next; }, getBounds: () => bounds, setOpacity() {}, setIgnoreMouseEvents() {}, setShape() {} };
  const { OverlayWindowController: RealOverlay } = await vi.importActual<typeof import("../../src/main/overlayWindow.js")>("../../src/main/overlayWindow.js");
  const real = new RealOverlay(surface, captured.locate, captured.place);
  captured.refreshPlacement = () => real.refreshPlacement();
  real.update({ kind: "arming" });
  await new Promise(resolve => setTimeout(resolve, config.minimumHoldDuration));
  real.update({ kind: "listening" });
  expect.soft(visible).toBe(true);
  expect.soft(real.pillPlace.pill.x).toBe(500.5);
  const atReveal = { ...bounds };
  shellReply.resolve([]);
  for (let i = 0; i < 24; i++) await new Promise<void>(queueMicrotask);
  expect.soft(bounds).toEqual(atReveal);
  expect.soft(helper.requests.filter(r => r.method === "caretAnchor").map(r => r.params)).toEqual([{}]);
  expect.soft(app.clipboard).toEqual([]);
  expect.soft(helper.requests.some(r => r.method === "insert")).toBe(false);
});


test.each(["rejected", "malformed", "no foreground"])("arming refresh %s preserves usable state", async scenario => {
  await launch("win32");
  const helper = app.helpers.get("voice-windows")!;
  helper.replies.set("frontmostApp", scenario === "no foreground" ? null : { window: 42 });
  const caret = { x: 800, y: 300, width: 1, height: 20 };
  helper.replies.set("caretAnchor", scenario === "no foreground" ? null : caret);
  const captured = app.overlay as unknown as { locate: () => Promise<Rect | null>; place: (area: Rect) => Rect | null; refreshPlacement: () => void };
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  helper.replies.set("shellExclusionBounds", [{ x: 0, y: 0, width: 400, height: 900 }]);
  helper.events.get("shellGeometryChanged")!({ event: "shellGeometryChanged" });
  await vi.waitFor(() => expect(captured.place(area)).toEqual({ x: 424, y: 0, width: 1016, height: 900 }));
  const saved = captured.place(area);
  const reply = Promise.withResolvers<Rect[]>();
  helper.replies.set("shellExclusionBounds", scenario === "malformed" ? [null] : scenario === "no foreground" ? [] : reply.promise);
  const pending = captured.locate();
  for (let i = 0; i < 16; i++) await new Promise<void>(queueMicrotask);
  if (scenario === "rejected") reply.reject(new Error("synthetic failure"));
  expect(await pending).toEqual(scenario === "no foreground" ? null : caret);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(captured.place(area)).toEqual(scenario === "no foreground" ? area : saved);
  helper.replies.set("shellExclusionBounds", []);
  await captured.locate();
  await vi.waitFor(() => expect(captured.place(area)).toEqual(area));
  expect(helper.requests.filter(r => r.method === "shellExclusionBounds")).toHaveLength(3);
  expect(app.clipboard).toEqual([]);
  expect(helper.requests.some(r => r.method === "insert" || r.method === "readScreen")).toBe(false);
});

test("an old shell reply cannot revive a canceled hold or overwrite newer geometry", async () => {
  await launch("win32");
  const helper = app.helpers.get("voice-windows")!;
  helper.replies.set("frontmostApp", { window: 42 });
  helper.replies.set("caretAnchor", { x: 800, y: 300, width: 1, height: 20 });
  const captured = app.overlay as unknown as { locate: () => Promise<Rect | null>; place: (area: Rect) => Rect | null; refreshPlacement: () => void };
  let visible = false; let bounds = { x: 0, y: 0, width: 1, height: 1 };
  const surface = { isVisible: () => visible, showInactive: () => { visible = true; }, hide: () => { visible = false; }, setBounds: (next: Rect) => { bounds = next; }, getBounds: () => bounds, setOpacity() {}, setIgnoreMouseEvents() {}, setShape() {} };
  const { OverlayWindowController: RealOverlay } = await vi.importActual<typeof import("../../src/main/overlayWindow.js")>("../../src/main/overlayWindow.js");
  const real = new RealOverlay(surface, captured.locate, captured.place);
  captured.refreshPlacement = () => real.refreshPlacement();
  const old = Promise.withResolvers<Rect[]>();
  helper.replies.set("shellExclusionBounds", old.promise);
  real.update({ kind: "arming" });
  for (let i = 0; i < 16; i++) await new Promise<void>(queueMicrotask);
  real.update({ kind: "idle" });
  helper.replies.set("shellExclusionBounds", []);
  helper.events.get("shellGeometryChanged")!({ event: "shellGeometryChanged" });
  for (let i = 0; i < 16; i++) await new Promise<void>(queueMicrotask);
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  old.resolve([area]);
  for (let i = 0; i < 24; i++) await new Promise<void>(queueMicrotask);
  expect(visible).toBe(false);
  expect(captured.place(area)).toEqual(area);
  real.update({ kind: "arming" });
  for (let i = 0; i < 24; i++) await new Promise<void>(queueMicrotask);
  real.update({ kind: "listening" });
  expect(visible).toBe(true);
  expect(real.pillPlace.pill.x).toBe(800.5);
  expect(app.clipboard).toEqual([]);
  expect(helper.requests.some(r => r.method === "insert")).toBe(false);
});


test("Windows asks for the caret without a foreground IPC round trip, and reads the screen elsewhere", async () => {
  await launch("win32");
  const helper = app.helpers.get("voice-windows")!;
  const reader = app.helpers.get("voice-screen-reader")!;
  const foreground = Promise.withResolvers<null>();
  helper.replies.set("frontmostApp", foreground.promise);
  helper.replies.set("caretAnchor", { x: 500, y: 300, width: 1, height: 20 });
  reader.replies.set("readScreen", null);
  const before = helper.requests.length;
  const caret = app.overlay!.locate();
  // Context capture follows arming synchronously in DictationController.start.
  const capture = app.controller as unknown as { captureContext: (exclusions: { apps: string[]; sites: string[] }) => Promise<unknown> };
  const context = capture.captureContext({ apps: [], sites: [] });
  const dispatched = helper.requests.slice(before).map(request => request.method);
  expect.soft(dispatched).toContain("caretAnchor");
  expect.soft(dispatched).not.toContain("frontmostApp");
  expect.soft(dispatched).not.toContain("readScreen");
  expect.soft(reader.requests.map(request => request.method)).toEqual(["readScreen"]);
  await context;
  foreground.resolve(null);
  expect(await caret).toEqual({ x: 500, y: 300, width: 1, height: 20 });
});


test("Linux helper exit invalidates established permission readiness", async () => {
  vi.doUnmock("../../src/core/onboarding/permissions.js");
  // Outside GNOME: GNOME integration is not part of the permission there.
  vi.stubEnv("XDG_CURRENT_DESKTOP", "KDE");
  await launch("linux");
  const insertion = app.helpers.get("voice-linux")!;
  const shortcut = app.helpers.get("voice-hotkey")!;
  shortcut.events.get("hotkeyInstallationChanged")!({ installed: true });
  insertion.events.get("insertionPermissionChanged")!({ granted: true });
  expect((app.trayState?.() as unknown as { accessibilityTrusted: boolean }).accessibilityTrusted).toBe(true);
  insertion.onExit!();
  expect((app.trayState?.() as unknown as { accessibilityTrusted: boolean }).accessibilityTrusted).toBe(false);
  vi.unstubAllEnvs();
});

test("outside GNOME, Linux offers F8 and F9, with Shift for agent mode", async () => {
  vi.stubEnv("XDG_CURRENT_DESKTOP", "KDE");
  try {
    await launch("linux");
    const settings = app.handlers.get(channels.getState)?.({}, "settings") as { hotkey: string; availableHotkeys: string[]; keyboardPermission: { agentShortcut?: string; instructions: string } };
    expect(settings.availableHotkeys).toEqual(["F8", "F9"]);
    expect(settings.hotkey).toBe("F8");
    expect(settings.keyboardPermission.agentShortcut).toBe("Shift+F8");
    expect(settings.keyboardPermission.instructions).toBe("Approve the dictation shortcut, then allow keyboard interaction in the next system prompt.");
    expect(settings.keyboardPermission).toMatchObject({ description: "Allows the dictation shortcut and pasting." });
    expect(app.helpers.get("voice-hotkey")!.requests).toContainEqual(expect.objectContaining({ method: "configure", params: expect.objectContaining({ hotkey: "F8" }) }));
  } finally {
    vi.unstubAllEnvs();
  }
});

/** Right Alt needs the extension, which supports GNOME 50 only: elsewhere the dictation key is F8
 * (owner, 2026-10-05). */
test("on a GNOME the integration doesn't support, the dictation key is F8 and Right Alt isn't offered", async () => {
  vi.stubEnv("XDG_CURRENT_DESKTOP", "ubuntu:GNOME");
  let shell = "GNOME Shell 49.2";
  vi.doMock("../../src/main/native/linux/gnomeIntegration.js", async (original) => {
    const { GnomeIntegration } = await original<typeof import("../../src/main/native/linux/gnomeIntegration.js")>();
    return { GnomeIntegration: class extends GnomeIntegration {
      constructor(helper: ConstructorParameters<typeof GnomeIntegration>[0]) {
        super(helper, async () => shell);
      }
    } };
  });
  try {
    app.stored.set("dictationHotkey", "rightAlt");
    await launch("linux");
    const state = (name: string) => app.handlers.get(channels.getState)?.({}, name);
    const configured = () => app.helpers.get("voice-hotkey")!.requests.filter((request) => request.method === "configure");
    await vi.waitFor(() => expect(state("settings")).toMatchObject({ gnomeIntegration: "unsupported" }));
    expect(state("settings")).toMatchObject({ hotkey: "F8", availableHotkeys: ["F8", "F9"] });
    expect(configured().at(-1)).toMatchObject({ params: expect.objectContaining({ hotkey: "F8" }) });
    // The welcome guide says what holds here: no GNOME integration to turn on, Shift for agent mode.
    expect((state("welcome") as { keyboardPermission: unknown }).keyboardPermission).toMatchObject({
      agentShortcut: "Shift+F8",
      description: "Allows the dictation shortcut and pasting.",
      instructions: "Approve the dictation shortcut, then allow keyboard interaction in the next system prompt.",
    });
    await send({ type: "setHotkey", hotkey: "rightAlt" });
    expect(state("settings")).toMatchObject({ hotkey: "F8" });
    expect(app.stored.get("dictationHotkey")).toBe("rightAlt");
    // Once GNOME integration is supported, the stored Right Alt is the key again.
    shell = "GNOME Shell 50.1";
    app.appEvents.get("second-instance")?.();
    await vi.waitFor(() => expect(state("settings")).toMatchObject({ hotkey: "rightAlt", availableHotkeys: ["rightAlt", "F8", "F9"] }));
    expect(configured().at(-1)).toMatchObject({ params: expect.objectContaining({ hotkey: "rightAlt" }) });
  } finally {
    vi.unstubAllEnvs();
    vi.doUnmock("../../src/main/native/linux/gnomeIntegration.js");
  }
});

/** Exercise the real GNOME adapter through its main-process consumer; only the
 * desktop command boundary and native IPC transport are stand-ins. */
test("GNOME activation, readiness hints and recording ownership are wired to the hotkey helper", async () => {
  const commands: [string, readonly string[]][] = [];
  vi.stubEnv("XDG_CURRENT_DESKTOP", "ubuntu:GNOME");
  vi.doMock("../../src/main/native/linux/gnomeIntegration.js", async (original) => {
    const { GnomeIntegration } = await original<typeof import("../../src/main/native/linux/gnomeIntegration.js")>();
    return { GnomeIntegration: class extends GnomeIntegration {
      constructor(helper: ConstructorParameters<typeof GnomeIntegration>[0]) {
        super(helper, async (file, args) => { commands.push([file, args]); return "GNOME Shell 50.1"; });
      }
    } };
  });
  try {
    vi.doUnmock("../../src/core/onboarding/permissions.js");
    await launch("linux");
    const state = (name: string) => app.handlers.get(channels.getState)?.({}, name);
    await vi.waitFor(() => expect(state("settings")).toMatchObject({ gnomeIntegration: "available" }));
    expect(state("overlay")).toMatchObject({ gnomeRecordingKeys: false });
    // Right Alt is GNOME's default, held by the integration; Space switches modes, so no Shift shortcut.
    expect(state("settings")).toMatchObject({ hotkey: "rightAlt", availableHotkeys: ["rightAlt", "F8", "F9"] });
    const hotkey = app.helpers.get("voice-hotkey")!;
    expect(hotkey.requests).toContainEqual(expect.objectContaining({ method: "configure", params: expect.objectContaining({ hotkey: "rightAlt" }) }));
    const keyboard = () => (state("welcome") as { keyboardPermission: { agentShortcut?: string; description: string; instructions: string } }).keyboardPermission;
    expect(keyboard().agentShortcut).toBeUndefined();
    expect(keyboard().description).toBe("Turns on GNOME integration and allows the dictation key and pasting.");
    expect(keyboard().instructions).toBe("This turns on GNOME integration; then allow keyboard interaction in the next system prompt.");
    // F8 or F9 on GNOME is the portal's shortcut, which has its own approval.
    await send({ type: "setHotkey", hotkey: "F8" });
    expect(keyboard().instructions).toBe("This turns on GNOME integration; then approve the dictation shortcut, then allow keyboard interaction in the next system prompt.");
    await send({ type: "setHotkey", hotkey: "rightAlt" });
    // GNOME integration is part of the keyboard permission.
    hotkey.events.get("hotkeyInstallationChanged")!({ installed: true });
    app.helpers.get("voice-linux")!.events.get("insertionPermissionChanged")!({ granted: true });
    expect((app.trayState?.() as unknown as { accessibilityTrusted: boolean }).accessibilityTrusted).toBe(false);
    // Turned on but not yet loaded by the Shell: only a new session finishes it.
    hotkey.replies.set("gnomeIntegration", false);
    const welcomePushed: string[] = [];
    app.listeners.set("voice:state", [(_event, name, pushedState) => {
      if (name === "welcome") welcomePushed.push((pushedState as { keyboardPermission: { instructions: string } }).keyboardPermission.instructions);
    }]);
    await send({ type: "enableGnomeIntegration" });
    expect(state("settings")).toMatchObject({ gnomeIntegration: "restart" });
    // The open welcome guide is told at once, not only when it next asks.
    expect(welcomePushed.at(-1)).toBe("Log out of Ubuntu and back in to finish turning on GNOME integration, then allow keyboard control here.");
    expect(keyboard().instructions).toBe("Log out of Ubuntu and back in to finish turning on GNOME integration, then allow keyboard control here.");
    // Right Alt stays offered and in use whatever state a supported GNOME's integration is in.
    const rightAltKept = () => {
      expect(state("settings")).toMatchObject({ hotkey: "rightAlt", availableHotkeys: ["rightAlt", "F8", "F9"] });
      expect(hotkey.requests.filter(({ method }) => method === "configure").at(-1)).toMatchObject({ params: expect.objectContaining({ hotkey: "rightAlt" }) });
    };
    rightAltKept();
    hotkey.replies.set("gnomeIntegration", true);
    await send({ type: "enableGnomeIntegration" });
    expect(commands).toContainEqual(["gnome-extensions", ["enable", "voice-caret@tabmail.ai"]]);
    expect(state("settings")).toMatchObject({ gnomeIntegration: "ready" });
    expect(state("overlay")).toMatchObject({ gnomeRecordingKeys: true });
    expect((app.trayState?.() as unknown as { accessibilityTrusted: boolean }).accessibilityTrusted).toBe(true);
    rightAltKept();
    hotkey.requests.length = 0;
    app.controller!.onPhaseChange!({ kind: "arming" });
    app.controller!.onPhaseChange!({ kind: "listening" });
    app.controller!.onPhaseChange!({ kind: "idle" });
    expect(hotkey.requests.filter(({ method }) => method === "setRecording").map(({ params }) => params)).toEqual([{ active: true }, { active: true }]);
    expect(hotkey.requests.some(({ method }) => method === "dictationEnded")).toBe(true);
    expect(app.helpers.get("voice-linux")!.requests.some(({ method }) => method === "setRecording" || method === "gnomeIntegration")).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    vi.doUnmock("../../src/main/native/linux/gnomeIntegration.js");
  }
});
