// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { homedir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { connectors } from "../src/core/agent/connectors.js";
import { mailtoURL } from "../src/core/agent/emailTools.js";
import type { AudioCapture } from "../src/core/audio.js";
import * as config from "../src/core/config.js";
import { channels } from "../src/shared/ipc.js";

/** The signal a tool runs with: a request never cancelled. */
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
  prewarms: 0,
  audioCommands: [] as unknown[],
  overlay: null as { opensUpward: boolean; chatOpensUpward: boolean; onPlace: (() => void) | undefined; updates: [string, boolean][]; heights: number[] } | null,
  controller: null as { chat: object | null; onChatChange: ((isOpen: boolean) => void) | undefined; onPhaseChange: ((phase: { kind: string }) => void) | undefined; onNothingListening: (() => void) | undefined; calls: string[] } | null,
  stored: new Map<string, unknown>(),
  opened: [] as string[],
  openFailure: null as Error | null,
  loopTools: [] as { name: string; connector: string; run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> }[],
  scripts: [] as { source: string; args: readonly string[] }[],
  shortcuts: [] as string[],
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
  shell: {
    openExternal: async (url: string) => {
      if (app.openFailure) throw app.openFailure;
      app.opened.push(url);
    },
  },
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
vi.mock("../src/main/osascript.js", () => ({
  osascript: {
    run: async (source: string, args: readonly string[]) => {
      app.scripts.push({ source, args });
      return "";
    },
  },
}));
vi.mock("../src/main/shortcuts.js", () => ({
  shortcutsCommand: () => ({
    names: async () => {
      app.shortcuts.push("list");
      return ["Morning"];
    },
    run: async (name: string) => {
      app.shortcuts.push(`run ${name}`);
      return "";
    },
  }),
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
      return this.replies.get(method) ?? { value: null, events: [], contacts: [], items: [] };
    }
  },
}));
vi.mock("../src/core/dictationController.js", () => ({
  DictationController: class {
    constructor(dependencies: { capture: AudioCapture; paste: (text: string, signal: AbortSignal) => Promise<void>; loopTools: typeof app.loopTools }) {
      app.capture = dependencies.capture;
      app.loopTools = dependencies.loopTools;
      app.paste = dependencies.paste;
      app.controller = this;
    }
    chat: object | null = null;
    onChatChange: ((isOpen: boolean) => void) | undefined;
    onPhaseChange: ((phase: { kind: string }) => void) | undefined;
    onNothingListening: (() => void) | undefined;
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
vi.mock("../src/main/overlayWindow.js", () => ({
  OverlayWindowController: class {
    opensUpward = false;
    chatOpensUpward = false;
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
    audio() {
      return { webContents: { isLoading: () => false, send: (_channel: string, command: unknown) => app.audioCommands.push(command) } };
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
  app.paste = null;
  app.prewarms = 0;
  app.audioCommands = [];
  app.overlay = null;
  app.controller = null;
  app.stored.clear();
  app.opened = [];
  app.openFailure = null;
  app.loopTools = [];
  app.scripts = [];
  app.shortcuts = [];
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

  /** A dictation's paste reaches `voice-macos` with the dictation's signal, so a paste waiting out a
   * helper restart is called off when the dictation is. */
  test("a dictation's paste carries its signal to voice-macos", async () => {
    await launch("darwin");
    const helper = app.helpers.get("voice-macos");
    const { signal } = new AbortController();

    await app.paste?.("Hello.", signal);

    const inserts = helper?.requests.filter((request) => request.method === "insert") ?? [];
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.signal).toBe(signal);
  });

  /** Placing the overlay pushes its view the direction it opened in, which the hands-free tip is
   * placed by: over the pill only when the overlay opened upward. */
  test("placing the overlay pushes the direction it opened in", async () => {
    await launch("darwin");
    const pushed: unknown[] = [];
    app.listeners.set("voice:state", [(_event, name, state) => name === "overlay" && pushed.push((state as { opensUpward: boolean }).opensUpward)]);
    const overlay = app.overlay;
    expect(overlay).not.toBeNull();

    if (overlay) overlay.opensUpward = true;
    overlay?.onPlace?.();
    if (overlay) overlay.opensUpward = false;
    overlay?.onPlace?.();

    expect(pushed).toEqual([true, false]);
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

  /** The overlay page is given the conversation as the controller holds it, every turn, opened the way
   * the overlay window opened it, and none once the window closes. */
  test("the overlay page is given the conversation and the way it opened", async () => {
    await launch("darwin");
    const controller = app.controller;
    const overlay = app.overlay;
    if (!controller || !overlay) throw new Error("not launched");
    const state = () => app.handlers.get(channels.getState)?.({}, "overlay") as { chat: unknown; chatOpensUpward: boolean };
    const chat = {
      turns: [
        { id: 0, request: "When is the launch", tool: "answer", reply: "Friday" },
        { id: 1, request: "And the party", tool: "answer", reply: "**Saturday**" },
      ],
      pendingRequest: "Where",
      closesAt: null,
    };

    controller.chat = chat;
    overlay.chatOpensUpward = true;
    expect(state()).toMatchObject({ chat, chatOpensUpward: true });
    overlay.chatOpensUpward = false;
    expect(state()).toMatchObject({ chat, chatOpensUpward: false });
    controller.chat = null;
    expect(state().chat).toBeNull();
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
    expect(state("settings").enabledTools).toEqual(["edit", "compose", "thunderbird"]);
    expect(await send({ type: "setAgentToolEnabled", tool: "answer", value: true })).toEqual({ error: null });
    expect(state("settings").enabledTools).toEqual(["edit", "compose", "thunderbird", "answer"]);
    expect(await send({ type: "setAgentToolEnabled", tool: "answer", value: false })).toEqual({ error: null });
    expect(await send({ type: "setAgentToolEnabled", tool: "retired-tool", value: false })).toEqual({ error: expect.any(String) });

    expect(state("settings").enabledTools).toEqual(["edit", "compose", "thunderbird"]);
    expect(state("welcome").enabledTools).toEqual(["edit", "compose", "thunderbird"]);
  });

  /** On macOS the Answer tool reaches Calendar, Reminders, Contacts and Files through `voice-macos`,
   * the email app, Notes and Messages through osascript, Shortcuts through the `shortcuts` command, and
   * the web with pages opened in the browser, and each has a switch, stored and shown in the Settings
   * and welcome windows; a name that is no app is refused. */
  test("on macOS, Calendar, Reminders, Contacts, Files, Email, Notes, Messages, Shortcuts and Web and their switches", async () => {
    await launch("darwin");
    const state = (name: string) => app.handlers.get(channels.getState)?.({}, name) as { connectors: string[]; enabledConnectors: string[] };

    expect(app.loopTools.map((tool) => tool.name)).toEqual(["calendar_read", "calendar_event_create", "reminders_read", "reminder_create", "contacts_search", "contacts_add", "files_search", "file_open", "email_compose", "notes_search", "notes_create", "messages_send", "shortcuts_list", "shortcuts_run", "web_read", "web_open"]);
    // Every app with a switch has its tools, and every tool's app a switch.
    expect(new Set(app.loopTools.map((tool) => tool.connector))).toEqual(new Set(connectors));
    await app.loopTools.find((tool) => tool.name === "calendar_read")?.run({}, signal);
    await app.loopTools.find((tool) => tool.name === "contacts_search")?.run({ query: "Sam" }, signal);
    await app.loopTools.find((tool) => tool.name === "files_search")?.run({ query: "tax" }, signal);
    expect(app.helpers.get("voice-macos")?.requests.map((request) => request.method)).toEqual(expect.arrayContaining(["calendarEvents", "contactsSearch", "filesSearch"]));
    await app.loopTools.find((tool) => tool.name === "notes_search")?.run({ query: "offsite" }, signal);
    await app.loopTools.find((tool) => tool.name === "messages_send")?.run({ to: "sam@example.com", text: "Hi" }, signal);
    expect(app.scripts.map((script) => script.args)).toEqual([["offsite"], ["sam@example.com", "Hi"]]);
    await app.loopTools.find((tool) => tool.name === "shortcuts_run")?.run({ name: "Morning" }, signal);
    expect(app.shortcuts).toEqual(["list", "run Morning"]);
    await app.loopTools.find((tool) => tool.name === "web_open")?.run({ url: "https://example.com/page" }, signal);
    expect(app.opened).toEqual(["https://example.com/page"]);

    expect(await send({ type: "setConnectorEnabled", connector: "calendar", value: false })).toEqual({ error: null });
    expect(await send({ type: "setConnectorEnabled", connector: "retired-app", value: false })).toEqual({ error: expect.any(String) });
    for (const name of ["settings", "welcome"]) {
      expect(state(name).connectors).toEqual(["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "shortcuts", "web"]);
      expect(state(name).enabledConnectors).toEqual(["reminders", "contacts", "files", "email", "notes", "messages", "shortcuts", "web"]);
    }
  });

  /** Files reads the home folder as `~`: a found item's path is given to the model with it, and a
   * `~` path the model gives back opens the item there. */
  test("Files reads the home folder as ~", async () => {
    await launch("darwin");
    const home = homedir();
    const macHelper = app.helpers.get("voice-macos");
    macHelper?.replies.set("filesSearch", { items: [{ path: `${home}/Documents/Tax return.pdf`, name: "Tax return.pdf", kind: "PDF document", changed: null, subject: null, authors: [], isEmail: false }] });
    macHelper?.replies.set("fileOpen", { opened: true });

    expect(await app.loopTools.find((tool) => tool.name === "files_search")?.run({ query: "tax" }, signal)).toContain(": ~/Documents/Tax return.pdf");
    expect(await app.loopTools.find((tool) => tool.name === "file_open")?.run({ path: "~/Documents/Tax return.pdf" }, signal)).toBe("Opened Tax return.pdf.");
    expect(macHelper?.requests.find((request) => request.method === "fileOpen")?.params).toEqual({ path: `${home}/Documents/Tax return.pdf`, reveal: false });
  });

  /** A draft opens with the app macOS opens `mailto:` links with, named in the result; with none, the
   * tool says so and opens nothing. */
  test("a draft opens in the default email app", async () => {
    await launch("darwin");
    const compose = app.loopTools.find((tool) => tool.name === "email_compose");
    const args = { to: ["sam@example.com"], subject: "Lunch", body: "Friday?" };
    const macHelper = app.helpers.get("voice-macos");

    // `launch` loads the app afresh, so the failure is its own module's class: matched by name.
    await expect(compose?.run(args, signal)).rejects.toMatchObject({ name: "NoEmailAppFailure" });
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

    expect(app.loopTools).toEqual([]);
    expect(state("settings").connectors).toEqual([]);
    expect(state("welcome").connectors).toEqual([]);
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
});
