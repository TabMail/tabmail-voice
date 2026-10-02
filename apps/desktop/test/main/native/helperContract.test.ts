// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
import { configureLog } from "../../../src/core/log.js";
import { hotkeyActions } from "../../../src/core/hotkey/bindings.js";
import { EventStoreError } from "../../../src/core/agent/connectors/calendar.js";
import { ContactStoreError } from "../../../src/core/agent/connectors/contacts.js";
import { FileStoreError } from "../../../src/core/agent/connectors/files.js";
import { type HelperClient, HelperError } from "../../../src/main/native/helperClient.js";
import { MacSystem } from "../../../src/main/native/macos/system.js";
import { decodeSamples, NativeMicrophone } from "../../../src/main/native/microphone.js";
import type { AudioReport } from "../../../src/shared/ipc.js";

/** The two sides of the helpers' wire: the requests the app sends and the handlers the Swift helpers
 * register (`channel.on("method")`), each with the params it reads. A method or param renamed on one
 * side only would fail every request at run time while both sides' own tests pass. */

const root = join(__dirname, "../../..");
const microphoneService = "native/macos/Sources/VoiceMicrophoneKit/MicrophoneService.swift";

/** Each method the helper source registers, with the params its handler reads. */
function registered(source: string): Map<string, Set<string>> {
  const handlers = new Map<string, Set<string>>();
  // The handlers, up to the helper functions declared after them.
  const text = readFileSync(join(root, source), "utf8").split(/\n\s*private static func/)[0] ?? "";
  const sections = text.split(/channel\.on\("/).slice(1);
  for (const section of sections) {
    const method = section.slice(0, section.indexOf('"'));
    const params = new Set([...section.matchAll(/params\["(\w+)"\]/g)].map((match) => match[1] ?? ""));
    if (/bundleIdentifier\(params\)/.test(section)) params.add("bundleIdentifier");
    // `ScreenExclusions(params:method:)` reads both lists, and refuses a request without either.
    if (/ScreenExclusions\(params: params,/.test(section)) for (const name of ["excludedAppIDs", "excludedHosts"]) params.add(name);
    handlers.set(method, params);
  }
  return handlers;
}

/** A `voice-macos` that answers every request with an empty result, recording what was asked. */
function recordingHelper(): { helper: HelperClient; requests: { method: string; params: Record<string, unknown> }[] } {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const helper = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      requests.push({ method, params });
      return { value: false, path: null, code: null, name: "", systemDefault: null, installed: [], png: null, events: [], reminders: [], contacts: [], items: [], opened: false };
    },
    on() {},
  } as unknown as HelperClient;
  return { helper, requests };
}

describe("helper wire contract", () => {
  test("every request MacSystem sends is one voice-macos handles, with the params it reads", async () => {
    const { helper, requests } = recordingHelper();
    const mac = new MacSystem(helper);
    const app = "org.example.app";
    await mac.paste("text");
    await mac.frontmostApp();
    await mac.keyboardLanguage();
    await mac.fullUserName();
    await mac.systemEmailApp();
    await mac.emailApps([app]);
    await mac.readScreen({ apps: [app], sites: ["example.com"] });
    await mac.appInfo("/Applications/Example.app");
    await mac.appIcon("/Applications/Example.app", config.agentBubbleAppIconSize);
    await mac.caretAnchor(1);
    await mac.focusedFieldValue(1, { apps: [app], sites: ["example.com"] });
    await mac.startActivator();
    await mac.globeKey.read();
    await mac.globeKey.update(0);
    await mac.thunderbird.applicationPath(app);
    await mac.thunderbird.isRunning(app);
    await mac.thunderbird.launch("/Applications/Example.app");
    await mac.thunderbird.hasWindow(app);
    await mac.thunderbird.activate(app);
    await mac.thunderbird.isFrontmost(app);
    await mac.thunderbird.focusedElement(app);
    await mac.thunderbird.openChat();
    await mac.thunderbird.pressReturn();
    const now = new Date();
    await mac.eventStore.events(now, now);
    await mac.eventStore.addEvent({ title: "Example", start: now, end: now, isAllDay: false, calendar: "", location: null, notes: null });
    await mac.eventStore.openReminders(null);
    await mac.eventStore.addReminder({ title: "Example", list: "", due: null, dueHasTime: false, notes: null });
    await mac.contactStore.search("Example", 1);
    await mac.contactStore.add({ firstName: "Example", lastName: "", organization: "", emails: [], phones: [] });
    await mac.fileStore.search({ words: ["Example"], kind: "any", changedAfter: null, changedBefore: null }, 1);
    await mac.fileStore.open("/tmp/example.pdf", false);

    const handlers = registered("native/macos/Sources/VoiceMacOSKit/MacService.swift");
    expect(new Set(requests.map((request) => request.method))).toEqual(new Set(handlers.keys()));
    for (const { method, params } of requests) {
      for (const param of handlers.get(method) ?? []) expect(params, `${method} without ${param}`).toHaveProperty(param);
      // And the other way: a param the helper never reads is dropped, however the user confirmed it.
      for (const param of Object.keys(params)) expect([...(handlers.get(method) ?? [])], `${method} ignores ${param}`).toContain(param);
    }
  });

  /** Values, not only names: the paste's text and its restore delay in the seconds the helper reads,
   * and the frontmost app's process as the helper answers it. */
  test("a paste carries its text and a restore delay in seconds, and the frontmost app's reply keeps its process", async () => {
    const calls: { method: string; params: unknown; timeout: unknown }[] = [];
    const helper = {
      request: async (method: string, params?: unknown, timeout?: unknown) => {
        calls.push({ method, params, timeout });
        return method === "frontmostApp" ? { pid: 321 } : {};
      },
    } as unknown as HelperClient;
    const mac = new MacSystem(helper);

    await mac.paste("some text");
    expect(await mac.frontmostApp()).toBe(321);

    expect(calls).toEqual([
      { method: "insert", params: { text: "some text", restoreDelay: config.clipboardRestoreDelay / 1000 }, timeout: config.helperRequestTimeout + config.clipboardRestoreDelay },
      { method: "frontmostApp", params: undefined, timeout: undefined },
    ]);
  });

  /** The account's full name comes back as the helper answers it, empty included; a reply without one
   * is a failure, not a name. The helper answers it under the key read here, as a string: a key
   * renamed on one side only would offer the short name on every launch while both suites pass. */
  test("the full user name is the helper's, and a reply without one fails", async () => {
    const source = readFileSync(join(root, "native/macos/Sources/VoiceMacOSKit/MacService.swift"), "utf8");
    const handler = source.split('channel.on("fullUserName")')[1]?.split("channel.on(")[0] ?? "";
    expect(handler).toMatch(/\["name": \.string\(/);
    expect([...handler.matchAll(/"(\w+)":/g)].map((match) => match[1])).toEqual(["name"]);

    let reply: unknown = { name: "Alex Example" };
    const mac = new MacSystem({ request: async () => reply } as unknown as HelperClient);
    expect(await mac.fullUserName()).toBe("Alex Example");
    reply = { name: "" };
    expect(await mac.fullUserName()).toBe("");
    for (reply of [{}, null, { name: 1 }]) await expect(mac.fullUserName()).rejects.toMatchObject({ name: "HelperError", method: "fullUserName" });
  });

  /** Calendar and Reminders requests carry their dates as milliseconds since 1970 and wait long
   * enough for macOS to ask the user for access; the helper's events and reminders come back with
   * their dates; a refusal the user can act on (no access, no default calendar or list) is its
   * message for the model, and any other failure stays as it was. */
  test("Calendar and Reminders cross the wire in milliseconds, and a refusal is its message", async () => {
    const calls: { method: string; params: unknown; timeout: unknown }[] = [];
    const start = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const end = new Date(start.getTime() + 3600 * 1000);
    const saved = { title: "Launch review", start: start.getTime(), end: end.getTime(), isAllDay: false, calendar: "Work", location: "Room 4", notes: null };
    const reminder = { title: "Send the deck", list: "Work", due: start.getTime(), dueHasTime: true, notes: "the short one" };
    let failure: Error | null = null;
    const helper = {
      request: async (method: string, params?: unknown, timeout?: unknown) => {
        calls.push({ method, params, timeout });
        if (failure) throw failure;
        if (method === "calendarEvents") return { events: [saved] };
        if (method === "calendarAdd") return saved;
        if (method === "reminders") return { reminders: [reminder, { ...reminder, due: null, dueHasTime: false }] };
        return reminder;
      },
    } as unknown as HelperClient;
    const store = new MacSystem(helper).eventStore;
    const event = { title: "Launch review", start, end, isAllDay: false, calendar: "", location: "Room 4", notes: null };

    expect(await store.events(start, end)).toEqual([{ ...saved, start, end }]);
    expect(await store.addEvent(event)).toEqual({ ...saved, start, end });
    expect(await store.openReminders(end)).toEqual([
      { ...reminder, due: start },
      { ...reminder, due: null, dueHasTime: false },
    ]);
    expect(await store.openReminders(null)).toHaveLength(2);
    expect(await store.addReminder({ title: "Send the deck", list: "", due: start, dueHasTime: true, notes: "the short one" })).toEqual({ ...reminder, due: start });
    await store.addReminder({ title: "Call back", list: "", due: null, dueHasTime: false, notes: null });

    const timeout = config.eventStoreRequestTimeout;
    expect(calls).toEqual([
      { method: "calendarEvents", params: { start: start.getTime(), end: end.getTime() }, timeout },
      { method: "calendarAdd", params: { title: "Launch review", start: start.getTime(), end: end.getTime(), isAllDay: false, location: "Room 4", notes: null }, timeout },
      { method: "reminders", params: { dueBefore: end.getTime() }, timeout },
      { method: "reminders", params: { dueBefore: null }, timeout },
      { method: "reminderAdd", params: { title: "Send the deck", due: start.getTime(), dueHasTime: true, notes: "the short one" }, timeout },
      { method: "reminderAdd", params: { title: "Call back", due: null, dueHasTime: false, notes: null }, timeout },
    ]);

    for (const kind of ["calendarNoAccess", "remindersNoAccess", "noDefaultCalendar", "noDefaultList"] as const) {
      failure = new HelperError("failed", "calendarEvents", kind);
      await expect(store.events(start, end)).rejects.toEqual(new EventStoreError(kind));
    }
    for (const other of [new HelperError("failed", "calendarEvents", "calendarEvents needs start and end"), new HelperError("timeout", "calendarEvents")]) {
      failure = other;
      await expect(store.events(start, end)).rejects.toBe(other);
    }
  });

  /** The refusals `voice-macos` sends by name are the ones the app turns into messages. */
  test("the helper's Calendar and Reminders refusals are the ones the app knows", () => {
    const source = readFileSync(join(root, "native/macos/Sources/VoiceMacOSKit/Connectors/EventStore.swift"), "utf8");
    const block = /enum Failure: String, Error \{([^}]*)\}/.exec(source)?.[1] ?? "";
    const cases = [...block.matchAll(/case (\w+)/g)].map((match) => match[1]);

    expect(cases).toEqual(["calendarNoAccess", "remindersNoAccess", "noDefaultCalendar", "noDefaultList"]);
    expect(cases.every((name) => EventStoreError.isKind(name))).toBe(true);
    expect(EventStoreError.isKind("toString")).toBe(false);
  });

  /** Contacts requests carry the search and the contact as the helper reads them and wait long
   * enough for macOS to ask the user for access; a refusal for want of access is its message for the
   * model, and any other failure stays as it was. */
  test("Contacts cross the wire as they are, and a refusal is its message", async () => {
    const calls: { method: string; params: unknown; timeout: unknown }[] = [];
    const sam = { firstName: "Sam", lastName: "Example", organization: "Company", emails: ["sam@example.com"], phones: ["+1 555 0100"] };
    let failure: Error | null = null;
    const helper = {
      request: async (method: string, params?: unknown, timeout?: unknown) => {
        calls.push({ method, params, timeout });
        if (failure) throw failure;
        return method === "contactsSearch" ? { contacts: [sam] } : sam;
      },
    } as unknown as HelperClient;
    const store = new MacSystem(helper).contactStore;

    expect(await store.search("sam", 11)).toEqual([sam]);
    expect(await store.add(sam)).toEqual(sam);

    const timeout = config.contactStoreRequestTimeout;
    expect(calls).toEqual([
      { method: "contactsSearch", params: { query: "sam", limit: 11 }, timeout },
      { method: "contactsAdd", params: sam, timeout },
    ]);

    failure = new HelperError("failed", "contactsSearch", "contactsNoAccess");
    await expect(store.search("sam", 11)).rejects.toEqual(new ContactStoreError("contactsNoAccess"));
    for (const other of [new HelperError("failed", "contactsSearch", "contactsSearch needs query and a positive limit"), new HelperError("timeout", "contactsSearch")]) {
      failure = other;
      await expect(store.search("sam", 11)).rejects.toBe(other);
    }
  });

  /** The refusals `voice-macos` sends by name are the ones the app turns into messages. */
  test("the helper's Contacts refusals are the ones the app knows", () => {
    const source = readFileSync(join(root, "native/macos/Sources/VoiceMacOSKit/Connectors/ContactStore.swift"), "utf8");
    const block = /enum Failure: String, Error \{([^}]*)\}/.exec(source)?.[1] ?? "";
    const cases = [...block.matchAll(/case (\w+)/g)].map((match) => match[1]);

    expect(cases).toEqual(["contactsNoAccess"]);
    expect(cases.every((name) => ContactStoreError.isKind(name))).toBe(true);
  });

  /** Files requests carry the search and the item as the helper reads them, times in milliseconds,
   * and wait for a whole-home search or an app launching; a failure the helper names is its message
   * for the model, and any other failure stays as it was. */
  test("Files cross the wire as they are, and a named failure is its message", async () => {
    const calls: { method: string; params: unknown; timeout: unknown }[] = [];
    const changed = new Date();
    const item = { path: "/Users/example/Documents/Tax return.pdf", name: "Tax return.pdf", kind: "PDF document", subject: null, authors: [], isEmail: false };
    let failure: Error | null = null;
    const helper = {
      request: async (method: string, params?: unknown, timeout?: unknown) => {
        calls.push({ method, params, timeout });
        if (failure) throw failure;
        return method === "filesSearch" ? { items: [{ ...item, changed: changed.getTime() }, { ...item, changed: null }] } : { opened: true };
      },
    } as unknown as HelperClient;
    const store = new MacSystem(helper).fileStore;
    const after = new Date(changed.getTime() - 86_400_000);

    expect(await store.search({ words: ["tax", "return"], kind: "pdf", changedAfter: after, changedBefore: changed }, 11)).toEqual([
      { ...item, changed },
      { ...item, changed: null },
    ]);
    await store.search({ words: ["tax"], kind: "any", changedAfter: null, changedBefore: null }, 11);
    expect(await store.open(item.path, true)).toBe(true);

    const timeout = config.fileStoreRequestTimeout;
    expect(calls).toEqual([
      { method: "filesSearch", params: { words: ["tax", "return"], kind: "pdf", changedAfter: after.getTime(), changedBefore: changed.getTime(), limit: 11 }, timeout },
      { method: "filesSearch", params: { words: ["tax"], kind: "any", changedAfter: null, changedBefore: null, limit: 11 }, timeout },
      { method: "fileOpen", params: { path: item.path, reveal: true }, timeout },
    ]);

    for (const kind of ["searchFailed", "openFailed"] as const) {
      failure = new HelperError("failed", "fileOpen", kind);
      await expect(store.open(item.path, false)).rejects.toEqual(new FileStoreError(kind));
    }
    for (const other of [new HelperError("failed", "fileOpen", "fileOpen needs an absolute path and reveal"), new HelperError("timeout", "fileOpen")]) {
      failure = other;
      await expect(store.open(item.path, false)).rejects.toBe(other);
    }
  });

  /** The failures `voice-macos` sends by name are the ones the app turns into messages. */
  test("the helper's Files failures are the ones the app knows", () => {
    const source = readFileSync(join(root, "native/macos/Sources/VoiceMacOSKit/Connectors/FileSearch.swift"), "utf8");
    const block = /enum Failure: String, Error \{([^}]*)\}/.exec(source)?.[1] ?? "";
    const cases = [...block.matchAll(/case (\w+)/g)].map((match) => match[1]);

    expect(cases).toEqual(["searchFailed", "openFailed"]);
    expect(cases.every((name) => FileStoreError.isKind(name))).toBe(true);
    expect(FileStoreError.isKind("toString")).toBe(false);
  });

  /** The helper's drawn icon reaches the bubble's `<img>` as a PNG data URL; no icon, none. */
  test("an app's icon comes back as a PNG data URL, or null", async () => {
    const calls: { method: string; params: unknown }[] = [];
    let png: string | null = "iVBORw0KGgo=";
    const helper = {
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return { png };
      },
    } as unknown as HelperClient;
    const mac = new MacSystem(helper);

    expect(await mac.appIcon("/Applications/Example.app", 32)).toBe("data:image/png;base64,iVBORw0KGgo=");
    png = null;
    expect(await mac.appIcon("/Applications/Example.app", 32)).toBeNull();
    expect(calls).toEqual([
      { method: "appIcon", params: { path: "/Applications/Example.app", pixels: 32 } },
      { method: "appIcon", params: { path: "/Applications/Example.app", pixels: 32 } },
    ]);
  });

  /** The microphone's requests are the ones `voice-microphone` handles, with the params it reads,
   * and the exit code the app restarts it at once for is the one it ends itself with. */
  test("every microphone request is one voice-microphone handles, and its restart exit code is the helper's", async () => {
    const { helper, requests } = recordingHelper();
    const microphone = new NativeMicrophone(helper, "voice-microphone").microphone(() => {});
    microphone({ type: "prepare" });
    microphone({ type: "start", session: 1 });
    microphone({ type: "stop", session: 1 });

    const handlers = registered(microphoneService);
    expect(new Set(requests.map((request) => request.method))).toEqual(new Set(handlers.keys()));
    for (const { method, params } of requests) {
      expect(new Set(Object.keys(params)), method).toEqual(handlers.get(method));
    }
    const exitCode = /inputChangedExitCode: Int32 = (\d+)/.exec(readFileSync(join(root, microphoneService), "utf8"))?.[1];
    expect(Number(exitCode)).toBe(config.microphoneHelperRestartExitCode);
  });

  /** The microphone's start carries the recording rate and waits the microphone's own start timeout;
   * its answer, or its failure, is that session's report; each chunk event the helper sends (named
   * as `MicrophoneService.microphoneChunkEvent`, its fields as `MicrophoneChunkEventTests` pins
   * them) becomes that session's samples, and a malformed one is dropped. A lost event is
   * `voice-windows`'s: `voice-microphone` ends itself instead. */
  test("the microphone's commands and events cross the wire as the helper sends and reads them", async () => {
    const calls: { method: string; params: unknown; timeout: unknown }[] = [];
    const events = new Map<string, (message: Record<string, unknown>) => void>();
    let refuse = false;
    const helper = {
      request: async (method: string, params?: unknown, timeout?: unknown) => {
        calls.push({ method, params, timeout });
        if (refuse) throw new Error("microphone: noInputDevice");
        return {};
      },
      on: (event: string, handler: (message: Record<string, unknown>) => void) => events.set(event, handler),
    } as unknown as HelperClient;
    const reports: AudioReport[] = [];
    const microphone = new NativeMicrophone(helper, "voice-microphone").microphone((report) => reports.push(report));

    microphone({ type: "start", session: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const samples = new Float32Array([0.25, -0.5, 1]);
    const emitted = /microphoneChunkEvent = "(\w+)"/.exec(readFileSync(join(root, microphoneService), "utf8"));
    const chunkEvent = events.get(emitted?.[1] ?? "");
    chunkEvent?.({ event: emitted?.[1], session: 3, samples: Buffer.from(samples.buffer).toString("base64") });
    chunkEvent?.({ event: emitted?.[1], session: 3, samples: Buffer.from([1, 2, 3]).toString("base64") });
    chunkEvent?.({ event: emitted?.[1], session: "3", samples: Buffer.from(samples.buffer).toString("base64") });
    const lostName = /\{"event", "(microphoneLost)"\}/.exec(readFileSync(join(root, "native/windows/src/microphone.h"), "utf8"))?.[1] ?? "";
    events.get(lostName)?.({ event: lostName, session: "3" });
    events.get(lostName)?.({ event: lostName, session: 3 });
    refuse = true;
    microphone({ type: "start", session: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    microphone({ type: "stop", session: 4 });

    expect(calls).toEqual([
      { method: "microphoneStart", params: { session: 3, sampleRate: config.recordingSampleRate }, timeout: config.microphoneStartTimeout },
      { method: "microphoneStart", params: { session: 4, sampleRate: config.recordingSampleRate }, timeout: config.microphoneStartTimeout },
      { method: "microphoneStop", params: { session: 4 }, timeout: undefined },
    ]);
    expect(reports).toEqual([
      { type: "started", session: 3 },
      { type: "chunk", session: 3, samples },
      { type: "lost", session: 3 },
      { type: "failed", session: 4, error: "Error" },
    ]);
  });

  /** A prepare cut short by its helper exiting is no error: `voice-microphone` ends itself whenever
   * the input changes, and the helper started in its place is prepared again. Any other failure of
   * a prepare is one. */
  test("a prepare whose helper exited is logged at debug, any other failure as an error", async () => {
    const errors: string[] = [];
    const file: string[] = [];
    configureLog({ isDebugBuild: true, sinks: { file: (level, text) => file.push(`${level} ${text}`), error: (text) => errors.push(text) } });
    let failure: Error = new HelperError("exited", "microphonePrepare");
    const helper = { request: async () => Promise.reject(failure), on() {} } as unknown as HelperClient;
    const microphone = new NativeMicrophone(helper, "voice-microphone").microphone(() => {});
    try {
      microphone({ type: "prepare" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errors).toEqual([]);
      expect(file).toEqual(["debug voice-microphone: microphone not prepared: HelperError.exited(microphonePrepare)"]);

      failure = new HelperError("timeout", "microphonePrepare");
      microphone({ type: "prepare" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errors).toEqual(["voice-microphone: microphone not prepared: HelperError.timeout(microphonePrepare)"]);
    } finally {
      configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
    }
  });

  test("a chunk's samples decode from base64 little-endian floats, and a torn one does not", () => {
    const samples = new Float32Array([0, 0.125, -1]);
    expect(decodeSamples(Buffer.from(samples.buffer).toString("base64"))).toEqual(samples);
    expect(decodeSamples(Buffer.from([0, 0, 0]).toString("base64"))).toBeNull();
    expect(decodeSamples(12)).toBeNull();
  });

  /** The gesture's actions, which voice-hotkey sends by their Swift names, are the ones the app
   * takes (`hotkeyActions`): one missing there is dropped at the wire as unknown. */
  test("every gesture action voice-hotkey sends is one the app takes", () => {
    const source = readFileSync(join(root, "native/macos/Sources/VoiceHotkeyKit/PushToTalkGesture.swift"), "utf8");
    const actionEnum = /enum Action[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? "";
    const cases = [...actionEnum.matchAll(/^\s*case (\w+)/gm)].map((match) => match[1]);
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases)).toEqual(new Set(hotkeyActions));
  });

  test("every request the app sends voice-hotkey is one it handles, with the params it reads", () => {
    const main = readFileSync(join(root, "src/main/index.ts"), "utf8");
    // Directly, or through `sendHotkeyState`, which sends the hotkey's state one request at a time.
    const sent = [...main.matchAll(/(?:hotkeyHelper\s*\.request|sendHotkeyState)(?:<[^>]*>)?\("(\w+)"(?:,\s*\{([^}]*)\})?/g)].map((match) => ({
      method: match[1] ?? "",
      params: new Set([...(match[2] ?? "").matchAll(/(\w+)\s*(?:[:,]|$)/g)].map((param) => param[1] ?? "")),
    }));

    const handlers = registered("native/macos/Sources/VoiceHotkeyKit/HotkeyService.swift");
    expect(new Set(sent.map((request) => request.method))).toEqual(new Set(handlers.keys()));
    for (const { method, params } of sent) {
      for (const param of handlers.get(method) ?? []) expect(params, `${method} without ${param}`).toContain(param);
    }
  });
});

/** The field's text for the correction watch (ADR-DESK-038): asked with the length cap, and read back
 * as text or nothing. */
describe("MacSystem.focusedFieldValue", () => {
  function replying(reply: unknown): { mac: MacSystem; params: Record<string, unknown>[] } {
    const params: Record<string, unknown>[] = [];
    const helper = { request: async (_method: string, sent: Record<string, unknown> = {}) => (params.push(sent), reply), on() {} } as unknown as HelperClient;
    return { mac: new MacSystem(helper), params };
  }

  test("asks for the app's field, capped, and returns its text", async () => {
    const { mac, params } = replying({ value: "Meet Xyvora." });
    expect(await mac.focusedFieldValue(42, { apps: ["org.example.vault"], sites: ["example.com"] })).toBe("Meet Xyvora.");
    expect(params).toStrictEqual([{ pid: 42, maxLength: config.correctionMaxFieldLength, excludedAppIDs: ["org.example.vault"], excludedHosts: ["example.com"] }]);
  });

  /** The apps and websites excluded from screen reading go to the helper as given, which reads none
   * of them (ADR-DESK-045, ADR-DESK-047). */
  test("the screen read carries the excluded apps and websites, and the picked app is asked by its path", async () => {
    const screen = replying(null);
    expect(await screen.mac.readScreen({ apps: ["org.example.vault", "org.example.bank"], sites: ["example.com", "example.org"] })).toBeNull();
    expect(screen.params).toStrictEqual([{ excludedAppIDs: ["org.example.vault", "org.example.bank"], excludedHosts: ["example.com", "example.org"] }]);

    const picked = replying({ bundleIdentifier: "org.example.bank", name: "Example Bank", path: "/Applications/Example Bank.app" });
    expect(await picked.mac.appInfo("/Applications/Example Bank.app")).toEqual({ bundleIdentifier: "org.example.bank", name: "Example Bank", path: "/Applications/Example Bank.app" });
    expect(picked.params).toStrictEqual([{ path: "/Applications/Example Bank.app" }]);
  });

  test.each([{ value: null }, {}, null, { value: 3 }])("no text in %j is none", async (reply) => {
    expect(await replying(reply).mac.focusedFieldValue(42, { apps: [], sites: [] })).toBeNull();
  });
});
