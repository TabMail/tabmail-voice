// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AccountModel } from "../../../src/core/backend/account.js";
import { type AgentChat, chatTranscript, emptyChat } from "../../../src/core/agent/chat.js";
import { type ConnectorID, connectorIDs } from "../../../src/core/agent/connectors/index.js";
import type { ConnectorTool } from "../../../src/core/agent/connectors/contract.js";
import { RelayError } from "../../../src/core/agent/connectors/thunderbird/relay.js";
import { AgentError, type AgentToolID, agentToolIDs, screenHiddenNote } from "../../../src/core/agent/tools.js";
import { AudioRecorder } from "../../../src/core/audio/recorder.js";
import { BackendError } from "../../../src/core/backend/errors.js";
import { CompletionsClient } from "../../../src/core/backend/completions.js";
import { TranscriptionClient } from "../../../src/core/backend/transcription.js";
import * as config from "../../../src/core/config.js";
import { DictationController, type DictationDependencies, nothingHeardMessage, notPastedMessage, partlyCopiedMessage, partlyTranscribedMessage, type Phase, retryingMessage } from "../../../src/core/dictation/controller.js";
import type { ScreenExclusions } from "../../../src/core/dictation/excludedSites.js";
import { PasteHistory } from "../../../src/core/dictation/pasteHistory.js";
import type { DictationMode } from "../../../src/core/hotkey/bindings.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";
import { configureLog, type LogLevel } from "../../../src/core/log.js";
import { type MicrophoneStatus, PermissionsModel } from "../../../src/core/onboarding/permissions.js";
import type { ScreenContext, ScreenRead } from "../../../src/core/dictation/screenContext.js";
import type { DictationSettings } from "../../../src/core/settings.js";
import { TipBook, tipDetails } from "../../../src/core/onboarding/tips.js";
import { CancellationError, sleep } from "../../../src/core/util/timeout.js";
import { type HTTPTransport, liveTransport, TransportError } from "../../../src/core/backend/http.js";
import { FakeThunderbird } from "../../support/fakeThunderbird.js";
import { screen as blankScreen } from "../../support/screens.js";
import { decodeFLAC } from "../../support/flacDecoder.js";
import { CountingCapture, deferred, eventually, Fixtures, loggedContent, signedIn, StubTransport, tone } from "../../support/stubs.js";
import { concat, random, room, speech } from "../../support/speech.js";

vi.mock("electron", () => ({ screen: {} }));

const transcript = "ask jordan about the road map";
const cleaned = "Ask Jordan about the roadmap.";
const request = "make this friendlier";
const cleanedStream = Fixtures.reply(cleaned);
/** A dictation's transcription, cleaned up by the backend in the same request (backend ADR-027). */
const cleanedReply = { text: transcript, cleaned_text: cleaned };
const reply = Fixtures.reply;

const idle: Phase = { kind: "idle" };
const arming: Phase = { kind: "arming" };
const listening: Phase = { kind: "listening" };
const transcribing: Phase = { kind: "transcribing" };
const running = (tool: AgentToolID): Phase => ({ kind: "running", tool });
const failed = (message: string): Phase => ({ kind: "failed", message });
const copied: Phase = { kind: "copied", message: notPastedMessage };
const microphoneFailed = failed("Couldn't start the microphone.");

/** Without Answer: most agent tests are about the writing tools and Thunderbird, and Answer would
 * make every request a choice. The chat window's tests switch it on (`withAnswer`). */
const toolsWithoutAnswer: AgentToolID[] = agentToolIDs.filter((tool) => tool !== "answer");

function defaultSettings(): DictationSettings {
  return { hasConsented: true, hotkey: "rightOption", backendURL: "https://api.example.com", readsScreen: true, enabledTools: toolsWithoutAnswer, enabledConnectors: [...connectorIDs], emailClient: FakeThunderbird.app, hasTabMail: true, userName: "Alex Example", dictionary: [], learnsWords: true, excludedApps: [], excludedSites: [] };
}

/** A screen with `sentinel` in its app name and in the focused field, before the caret. */
function screen(sentinel: string): ScreenContext {
  return blankScreen({ appName: `Example Notes ${sentinel}`, windowTitle: "Weekly sync", renderedText: `» Agenda ${sentinel} ‸` });
}

/** A screen whose focused field has `selected` selected. */
function selectionScreen(selected: string): ScreenContext {
  return blankScreen({ appName: "Example Notes", windowTitle: "Weekly sync", textBeforeCaret: "Note: ", selectedText: selected, renderedText: `Note: ‸${selected}‸` });
}

/** Polls for `ms`: whether `condition` held at every look. */
async function throughout(ms: number, condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!condition()) return false;
    await sleep(10);
  }
  return condition();
}

/** Done: idle, failed, or copied instead of pasted. */
function settled(controller: DictationController): boolean {
  return controller.phase.kind === "idle" || controller.phase.kind === "failed" || controller.phase.kind === "copied";
}

/** The content-log steps of the controller and the agent, without the backend clients' own entries. */
function steps(entries: { label: string; text: string }[]): { label: string; text: string }[] {
  return entries.filter((entry) => !entry.label.startsWith("Transcription ") && !entry.label.startsWith("Completions ") && !entry.label.startsWith("Warm-up "));
}

/** A finished recording through the controller: transcription, cleanup with the screen context, and
 * what gets pasted. A stub paste and never the network. */
describe("DictationController", { timeout: 20_000 }, () => {
  let transcription: StubTransport;
  /** The key-down warm-up's backend: with nothing queued it fails, as an unreachable server does. */
  let warmUps: StubTransport;
  let completions: StubTransport;
  let auth: StubTransport;
  /** The app in front, as the controller sees it: a process id the test changes. */
  let front: { pid: number | null };
  /** The keyboard's language, and what the controller showed as its language when each hold was
   * revealed. */
  let keyboard: { language: string | null; atReveal: (string | null)[] };
  let prefs: { value: DictationSettings };
  /** Which tips were shown and learned, as `TipBook` keeps them. */
  let tipStore: MemoryStore;
  /** The texts each dictation marked its dictionary words used in (`useWords`). */
  let used: string[][];

  beforeEach(() => {
    transcription = new StubTransport();
    warmUps = new StubTransport();
    completions = new StubTransport();
    auth = new StubTransport();
    front = { pid: 101 };
    keyboard = { language: null, atReveal: [] };
    prefs = { value: defaultSettings() };
    tipStore = new MemoryStore();
    // Told what's new already, unless a test starts afresh: it would take the first tip's turn.
    new TipBook(tipStore).markLearned("longDictations");
    used = [];
  });

  /** A controller with both grants and the user's consent, signed in to `account`, on the stub
   * backend. Thunderbird is not installed unless a test passes one. */
  function makeController(
    options: { account?: AccountModel; capture?: CountingCapture; thunderbird?: FakeThunderbird; microphone?: MicrophoneStatus; accessibility?: boolean; transcriptionTransport?: HTTPTransport; frontmostApp?: () => Promise<number | null>; paste?: DictationDependencies["paste"]; connectorTools?: ConnectorTool[]; corrections?: DictationDependencies["corrections"] } = {},
  ): { controller: DictationController; pastes: string[]; copies: string[]; history: PasteHistory } {
    const pastes: string[] = [];
    const copies: string[] = [];
    const history = new PasteHistory();
    const thunderbird = options.thunderbird ?? Object.assign(new FakeThunderbird(), { installed: false });
    const controller = new DictationController({
      permissions: new PermissionsModel({
        readMicrophone: () => options.microphone ?? "granted",
        readAccessibility: () => options.accessibility ?? true,
        askForMicrophone: async () => {},
        askForAccessibility: () => true,
        openSettings: () => {},
      }),
      settings: () => prefs.value,
      account: options.account ?? signedIn(auth),
      tips: new TipBook(tipStore),
      // As `voice-macos` pastes (`MacSystem.paste`): nothing once canceled.
      paste:
        options.paste ??
        (async (text, signal) => {
          if (signal.aborted) throw new CancellationError();
          pastes.push(text);
        }),
      copy: (text) => copies.push(text),
      history,
      thunderbird: thunderbird.relay(),
      capture: options.capture ?? new CountingCapture(),
      frontmostApp: options.frontmostApp ?? (async () => front.pid),
      keyboardLanguage: async () => keyboard.language,
      systemEmailApp: async () => null,
      makeTranscriptionClient: (url) => new TranscriptionClient(url, "test", options.transcriptionTransport ?? transcription.transport),
      warmUp: (url, token) => new TranscriptionClient(url, "test", warmUps.transport).warmUp(token),
      makeCompletionsClient: (url) => new CompletionsClient(url, "test", completions.transport),
      connectorTools: options.connectorTools ?? [],
      corrections: options.corrections,
      useWords: (texts) => used.push([...texts]),
    });
    return { controller, pastes, copies, history };
  }

  /** Runs one recording through the controller; returns what was pasted. */
  async function dictate(account?: AccountModel): Promise<{ pasted: string[]; controller: DictationController }> {
    const { controller, pastes } = makeController({ account, capture: new CountingCapture(true) });
    await holdAndRelease(controller);
    expect(await eventually(() => controller.phase.kind !== "listening" && controller.phase.kind !== "arming" && controller.phase.kind !== "transcribing" && controller.phase.kind !== "retrying" && controller.phase.kind !== "running")).toBe(true);
    return { pasted: pastes, controller };
  }

  /** Holds the dictation key past the reveal delay (pressing Space once for agent mode), then
   * releases it. */
  async function holdAndRelease(controller: DictationController, mode: DictationMode = "dictation"): Promise<void> {
    controller.handle("start");
    if (mode === "agent") controller.handle("toggleMode");
    expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
    controller.handle("finish");
  }

  /** The cleanup variables of the `index`th transcription request. */
  function cleanupVars(index: number): Record<string, unknown> | undefined {
    return transcription.body(index).cleanup as Record<string, unknown> | undefined;
  }

  /** The variables of the `index`th completions request. */
  function completionsVars(index: number): Record<string, unknown> | undefined {
    return completions.message(index);
  }

  function hosts(stub: StubTransport): string[] {
    return stub.requests.map((request) => new URL(request.url).host);
  }

  /** The `language` of each transcription request (null: none sent). */
  function transcriptionLanguages(): (string | null)[] {
    return transcription.requests.map((_, index) => (transcription.body(index).language as string | undefined) ?? null);
  }

  /** One request: the recording with the cleanup's variables, and the backend's cleanup back with the
   * transcript (backend ADR-027). */
  test("the original window reaches the Windows insertion boundary without copy fallback", async () => {
    transcription.enqueue(200, cleanedReply);
    const inserts: { text: string; window: number }[] = [];
    const { WindowsSystem } = await import("../../../src/main/native/windows/system.js");
    const system = new WindowsSystem({ request: async (_method: string, params: { text: string; window: number }) => { inserts.push(params); } } as never);
    const { controller, copies } = makeController({ capture: new CountingCapture(true), paste: system.paste.bind(system) });
    await holdAndRelease(controller);
    expect(await eventually(() => settled(controller))).toBe(true);
    expect(inserts.map(({ text, window }) => ({ text, window }))).toEqual([{ text: cleaned, window: 101 }]);
    expect(copies).toEqual([]);
    expect(controller.phase).toEqual(idle);
  });

  test("pastes the cleaned-up transcript", async () => {
    transcription.enqueue(200, cleanedReply);

    const { pasted, controller } = await dictate();

    expect(pasted).toEqual([cleaned]);
    expect(controller.phase).toEqual(idle);
    expect(transcription.requests).toHaveLength(1);
    expect(cleanupVars(0)).toEqual({ app_name: "", web_host: "", terminal_program: "", window_title: "", screen_text: "", dictionary: "" });
    expect(completions.requests).toHaveLength(0);
    expect(transcription.authorizations).toEqual(["Bearer access-1"]);
  });

  /** The backend answers an empty cleanup when it failed or ran past its deadline; a backend from
   * before the cleanup moved into the transcription request answers none. */
  test.each([
    ["failed", { text: transcript, cleaned_text: "" }],
    ["not returned", { text: transcript }],
  ])("pastes the transcript as heard when the cleanup is %s", async (_name, body) => {
    transcription.enqueue(200, body);

    const { pasted, controller } = await dictate();

    expect(pasted).toEqual([transcript]);
    expect(controller.phase).toEqual(idle);
    expect(completions.requests).toHaveLength(0);
  });

  /** The dictionary's words go with the transcription, for the speech model, and with the cleanup, one
   * per line (ADR-DESK-038). */
  test("sends the dictionary with the transcription and the cleanup", async () => {
    prefs.value = { ...defaultSettings(), dictionary: ["Xyvora", "Kaelthorne Draszek"] };
    transcription.enqueue(200, cleanedReply);

    const { pasted } = await dictate();

    expect(pasted).toEqual([cleaned]);
    expect(transcription.body(0).vocabulary).toEqual(["Xyvora", "Kaelthorne Draszek"]);
    expect(cleanupVars(0)?.dictionary).toBe("Xyvora\nKaelthorne Draszek");
  });

  /** The words the dictation came out with, as heard and as cleaned up, mark the dictionary's words in
   * them used, so a full dictionary keeps them (ADR-DESK-038). */
  test("marks the dictionary's words used in the transcript and the cleanup", async () => {
    transcription.enqueue(200, cleanedReply);

    await dictate();

    expect(used).toEqual([[transcript, cleaned]]);
  });

  test("marks only the transcript when no cleanup came back", async () => {
    transcription.enqueue(200, { text: transcript });

    await dictate();

    expect(used).toEqual([[transcript]]);
  });

  test("an empty dictionary sends no words and an empty cleanup dictionary", async () => {
    transcription.enqueue(200, cleanedReply);

    await dictate();

    expect(transcription.body(0).vocabulary).toBeUndefined();
    expect(cleanupVars(0)?.dictionary).toBe("");
  });

  /** The names and terms on the screen read at key-down go with the recording after the dictionary's
   * words, none of them twice; the cleanup gets the dictionary alone (it reads the screen itself). */
  /** The recording goes up as FLAC, losslessly and peak-normalized (the capture's −6 dBFS tone
   * raised to −3 dBFS): the backend hears exactly what the recorder made of it. */
  test("uploads the recording as FLAC", async () => {
    transcription.enqueue(200, cleanedReply);
    const { controller, pastes } = makeController({ capture: new CountingCapture(true) });

    await holdAndRelease(controller);

    expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
    const recorder = new AudioRecorder();
    recorder.append(tone(0.1));
    const body = transcription.body(0);
    expect(body.format).toBe("flac");
    const uploaded = decodeFLAC(new Uint8Array(Buffer.from(String(body.audio), "base64"))).pcm;
    expect(uploaded).toEqual(recorder.finish().pcm);
    const view = new DataView(uploaded.buffer, uploaded.byteOffset, uploaded.byteLength);
    const peak = Math.max(...Array.from({ length: uploaded.length / 2 }, (_, index) => Math.abs(view.getInt16(index * 2, true))));
    expect(peak).toBe(Math.round(0x7fff * 10 ** (config.normalizedPeakDecibels / 20)));
  });

  test("microphone starts before optional screen context and does not wait for it", async () => {
    const capture = new CountingCapture();
    const { controller } = makeController({ capture });
    const context = deferred<ScreenRead | null>();
    let startsWhenRead = -1;
    controller.captureContext = () => { startsWhenRead = capture.starts; return context.promise; };
    controller.handle("start");
    expect(startsWhenRead).toBe(1);
    expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
    controller.handle("cancel");
    context.resolve(null);
  });

  /** The screen read is asked with the apps excluded at key-down; when the app in front is one of
   * them the read is null, and the dictation goes through with no screen context and no terms. */
  test("a dictation in an excluded app is pasted with no screen context and no screen terms", async () => {
    prefs.value = { ...defaultSettings(), dictionary: ["Xyvora"], excludedApps: ["org.example.vault"], excludedSites: ["example.com"] };
    transcription.enqueue(200, cleanedReply);
    const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
    const asked: ScreenExclusions[] = [];
    const inFront = "org.example.vault";
    controller.captureContext = async (exclusions) => {
      asked.push(exclusions);
      return exclusions.apps.includes(inFront) ? null : blankScreen({ appName: "Example Vault", windowTitle: "Brevalle Labs", renderedText: "Kaelthorne Drake" });
    };

    await holdAndRelease(controller);

    expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
    expect(asked).toEqual([{ apps: ["org.example.vault"], sites: ["example.com"] }]);
    expect(pastes).toEqual([cleaned]);
    expect(transcription.body(0).vocabulary).toEqual(["Xyvora"]);
    expect(JSON.stringify(transcription.body(0))).not.toMatch(/Example Vault|Brevalle|Kaelthorne/);
  });

  /** A screen the helper hides for privacy is, to a dictation, no screen: its cleanup gets none,
   * and nothing is said of it (the note is for agent mode's tools). */
  test("a dictation with the screen hidden for privacy is pasted with no screen context", async () => {
    prefs.value = { ...defaultSettings(), dictionary: ["Xyvora"] };
    transcription.enqueue(200, cleanedReply);
    const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
    controller.captureContext = async () => ({ hidden: true });

    await holdAndRelease(controller);

    expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
    expect(pastes).toEqual([cleaned]);
    expect(transcription.body(0).vocabulary).toEqual(["Xyvora"]);
    expect(cleanupVars(0)).toEqual({ app_name: "", web_host: "", terminal_program: "", window_title: "", screen_text: "", dictionary: "Xyvora" });
  });

  test("sends the screen's names and terms after the dictionary", async () => {
    prefs.value = { ...defaultSettings(), dictionary: ["Xyvora"] };
    transcription.enqueue(200, cleanedReply);
    const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
    controller.captureContext = async () =>
      blankScreen({ appName: "Example Mail", windowTitle: "Launch with Brevalle Labs", renderedText: "From: Kaelthorne Drake\nAsk Xyvora and Brevalle Labs about TabMail." });

    await holdAndRelease(controller);

    expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
    expect(transcription.body(0).vocabulary).toEqual(["Xyvora", "Brevalle Labs", "Kaelthorne Drake", "TabMail"]);
    expect(cleanupVars(0)?.dictionary).toBe("Xyvora");
  });

  /** The screen's terms fill what the dictionary leaves of the 200 words a dictation sends: all 200
   * with no dictionary, the rest beside a full one (owner, 2026-10-02). */
  test.each<[DictationMode, number]>([
    ["dictation", 0], ["dictation", 1], ["dictation", 150],
    ["agent", 0], ["agent", 1], ["agent", 150],
  ])("%s with %i dictionary words fills the rest of the vocabulary", async (mode, count) => {
    const dictionary = Array.from({ length: count }, (_, index) => `Xyvora${index}`);
    const names = Array.from({ length: config.vocabularyMaxTerms + 1 }, (_, index) => `Brevalle${index}`);
    prefs.value = { ...defaultSettings(), dictionary, enabledTools: ["compose"] };
    const written = "Synthetic composed result.";
    transcription.enqueue(200, mode === "dictation" ? cleanedReply : { text: request });
    if (mode === "agent") completions.enqueue(200, reply(written));
    const { controller, pastes, copies, history } = makeController({ capture: new CountingCapture(true) });
    let reads = 0;
    controller.captureContext = async () => {
      reads += 1;
      return blankScreen({ appName: "Example Mail", renderedText: `ask ${names.join(", ")}` });
    };

    await holdAndRelease(controller, mode);

    expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
    expect(controller.mode).toBe(mode);
    expect(reads).toBe(1);
    expect(transcription.requests).toHaveLength(1);
    expect(transcription.body(0).vocabulary).toEqual([...dictionary, ...names.slice(0, config.vocabularyMaxTerms - count)]);
    expect(cleanupVars(0)?.dictionary).toBe(mode === "dictation" ? dictionary.join("\n") : undefined);
    const delivered = mode === "dictation" ? cleaned : written;
    expect(pastes).toEqual([delivered]);
    expect(copies).toEqual([]);
    expect(history.entries.map((entry) => entry.text)).toEqual([delivered]);
    expect(completions.requests).toHaveLength(mode === "dictation" ? 0 : 1);
  });

  /** The recording waits at most `contextWait` for the screen read: one not done by then adds no terms. */
  test("a screen read not done yet adds no terms", async () => {
    prefs.value = { ...defaultSettings(), dictionary: ["Xyvora"] };
    transcription.enqueue(200, cleanedReply);
    const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
    const read = deferred<ScreenContext | null>();
    controller.captureContext = () => read.promise;

    await holdAndRelease(controller);

    expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
    expect(transcription.body(0).vocabulary).toEqual(["Xyvora"]);
    read.resolve(null);
  });

  /** With screen reading off, the screen is not read, so no terms are sent from it. */
  test("with screen reading off no terms are sent", async () => {
    prefs.value = { ...defaultSettings(), readsScreen: false };
    transcription.enqueue(200, cleanedReply);
    const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
    controller.captureContext = async () => blankScreen({ appName: "Example Mail", windowTitle: "Brevalle Labs", renderedText: "Ask Kaelthorne Drake" });

    await holdAndRelease(controller);

    expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
    expect(transcription.body(0).vocabulary).toBeUndefined();
  });

  /** After a dictation's paste, the field of the app in front at key-down is watched for the user's
   * corrections (`CorrectionWatch`), with the text pasted; the next key-down stops the watch first. */
  /** Where the text goes (ADR-DESK-042): into the app in front at key-down only. When the user has
   * gone to another app, nothing is pasted anywhere; the text goes on the clipboard and into the paste
   * history, and the note says so. */
  describe("pasting only into the app the user spoke over", () => {
    test("pastes into the app still in front, into the history too", async () => {
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes, copies, history } = makeController({ capture: new CountingCapture(true) });

      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length === 1)).toBe(true);

      expect(pastes).toEqual([cleaned]);
      expect(copies).toEqual([]);
      expect(history.entries.map((entry) => entry.text)).toEqual([cleaned]);
    });

    /** Another app in front, or one that can't be read then or at key-down: the paste goes only where
     * the user is known to be. */
    test.each<[string, (reads: number) => Promise<number | null>]>([
      ["another app is in front", async (reads) => (reads === 1 ? 101 : 202)],
      ["the app in front can't be read at the paste", async (reads) => (reads === 1 ? 101 : Promise.reject(new Error("helper exited")))],
      ["the app in front couldn't be read at key-down", async (reads) => (reads === 1 ? Promise.reject(new Error("helper exited")) : 101)],
      ["no app was in front at key-down", async (reads) => (reads === 1 ? null : 101)],
      ["neither foreground read identifies an app", async () => null],
      ["the helper returns a zero target", async () => 0],
      ["the helper returns a negative target", async () => -1],
      ["the helper returns a fractional target", async () => 1.5],
    ])("when %s, the text is copied, not pasted", async (_, frontmost) => {
      transcription.enqueue(200, cleanedReply);
      let reads = 0;
      const { controller, pastes, copies, history } = makeController({
        capture: new CountingCapture(true),
        frontmostApp: () => frontmost((reads += 1)),
      });

      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "copied")).toBe(true);

      expect(controller.phase).toEqual({ kind: "copied", message: "Switched apps: copied to clipboard and history" });
      expect(pastes).toEqual([]);
      expect(copies).toEqual([cleaned]);
      expect(history.entries.map((entry) => entry.text)).toEqual([cleaned]);
    });

    test("after a copied text, the next hold pastes as ever", async () => {
      transcription.enqueue(200, cleanedReply);
      transcription.gate = async () => {
        front.pid = 202;
      };
      const { controller, pastes, copies } = makeController({ capture: new CountingCapture(true) });

      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "copied")).toBe(true);
      transcription.gate = undefined;
      transcription.enqueue(200, cleanedReply);
      await holdAndRelease(controller);

      expect(await eventually(() => pastes.length === 1)).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(copies).toEqual([cleaned]);
    });

    /** A dictation canceled while the app in front is read wants its text nowhere: not pasted, not
     * copied (the user's clipboard stays theirs), not in the history. */
    test.each<["dictation" | "agent", number]>([
      ["dictation", 101],
      ["agent", 202],
    ])("a %s canceled while the app in front is read goes nowhere (app %i)", async (mode, pid) => {
      transcription.enqueue(200, mode === "agent" ? { text: request } : cleanedReply);
      if (mode === "agent") completions.enqueue(200, reply("We ship on Friday."));
      const reading = deferred<number>();
      let reads = 0;
      const { controller, pastes, copies, history } = makeController({
        capture: new CountingCapture(true),
        frontmostApp: () => ((reads += 1) === 1 ? Promise.resolve(101) : reading.promise),
      });
      if (mode === "agent") controller.captureContext = async () => selectionScreen("");

      await holdAndRelease(controller, mode);
      expect(await eventually(() => reads === 2)).toBe(true);
      controller.handle("cancel");
      reading.resolve(pid);
      expect(await eventually(() => controller.phase.kind === "idle")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(pastes).toEqual([]);
      expect(copies).toEqual([]);
      expect(history.entries).toEqual([]);
    });

    /** The note shows as long as a failure does, then the pill rests. */
    test("the copied note goes after its display time", async () => {
      vi.useFakeTimers();
      transcription.enqueue(200, cleanedReply);
      transcription.gate = async () => {
        front.pid = 202;
      };
      const { controller } = makeController({ capture: new CountingCapture(true) });
      try {
        controller.handle("start");
        await vi.advanceTimersByTimeAsync(config.minimumHoldDuration);
        controller.handle("finish");
        await vi.advanceTimersByTimeAsync(config.releaseTailDuration);
        for (let turn = 0; turn < 10 && controller.phase.kind !== "copied"; turn += 1) await vi.advanceTimersByTimeAsync(0);
        expect(controller.phase).toEqual(copied);
        await vi.advanceTimersByTimeAsync(config.overlayErrorDisplayDuration - 1);
        expect(controller.phase.kind).toBe("copied");
        await vi.advanceTimersByTimeAsync(1);
        expect(controller.phase).toEqual(idle);
      } finally {
        controller.handle("cancel");
        vi.useRealTimers();
      }
    });

    /** Agent mode's text is copied the same way: Edit's and Compose's. */
    test("agent text for another app is copied", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("We ship on Friday."));
      completions.gate = async () => {
        front.pid = 202;
      };
      const { controller, pastes, copies, history } = makeController({ capture: new CountingCapture(true) });
      controller.captureContext = async () => selectionScreen("");

      await holdAndRelease(controller, "agent");
      expect(await eventually(() => controller.phase.kind === "copied")).toBe(true);

      expect(controller.phase).toEqual(copied);
      expect(pastes).toEqual([]);
      expect(copies).toEqual(["We ship on Friday."]);
      expect(history.entries.map((entry) => entry.text)).toEqual(["We ship on Friday."]);
    });
  });

  describe("learning the user's corrections", () => {
    function watcher(): { calls: string[]; corrections: NonNullable<DictationDependencies["corrections"]> } {
      const calls: string[] = [];
      return { calls, corrections: { watch: (pid, pasted) => calls.push(`watch ${pid} ${pasted}`), stop: () => calls.push("stop") } };
    }

    async function dictateHeld(corrections: NonNullable<DictationDependencies["corrections"]>, count = 1): Promise<string[]> {
      const { controller, pastes } = makeController({ capture: new CountingCapture(true), corrections });
      for (let index = 0; index < count; index += 1) {
        transcription.enqueue(200, cleanedReply);
        await holdAndRelease(controller);
        expect(await eventually(() => pastes.length === index + 1 && settled(controller))).toBe(true);
      }
      return pastes;
    }

    test("watches the app pasted into, with the text pasted", async () => {
      const { calls, corrections } = watcher();
      expect(await dictateHeld(corrections)).toEqual([cleaned]);
      expect(calls).toEqual(["stop", `watch 101 ${cleaned}`]);
    });

    test("each key-down stops the last watch before the next paste", async () => {
      const { calls, corrections } = watcher();
      await dictateHeld(corrections, 2);
      expect(calls).toEqual(["stop", `watch 101 ${cleaned}`, "stop", `watch 101 ${cleaned}`]);
    });

    /** The apps and websites excluded from screen reading at key-down go with the watch, which never
     * reads one. */
    test("the watch is told the apps and websites excluded as the dictation started", async () => {
      prefs.value = { ...defaultSettings(), excludedApps: ["org.example.vault"], excludedSites: ["example.com"] };
      const excluded: ScreenExclusions[] = [];
      const corrections: NonNullable<DictationDependencies["corrections"]> = { watch: (_pid, _pasted, exclusions) => excluded.push(exclusions), stop: () => {} };
      const { controller, pastes } = makeController({ capture: new CountingCapture(true), corrections });
      controller.onPhaseChange = (phase) => {
        if (phase.kind === "listening") prefs.value = { ...defaultSettings(), excludedApps: ["org.example.other"], excludedSites: ["example.org"] };
      };
      transcription.enqueue(200, cleanedReply);
      await holdAndRelease(controller);
      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      expect(excluded).toEqual([{ apps: ["org.example.vault"], sites: ["example.com"] }]);
    });

    test("nothing is watched with learning switched off", async () => {
      prefs.value = { ...defaultSettings(), learnsWords: false };
      const { calls, corrections } = watcher();
      expect(await dictateHeld(corrections)).toEqual([cleaned]);
      expect(calls).toEqual(["stop"]);
    });

    /** Read at key-down with the other settings: switching learning off during the hold changes
     * nothing for this dictation. */
    test("the learning switch is the one at key-down", async () => {
      const { calls, corrections } = watcher();
      const { controller, pastes } = makeController({ capture: new CountingCapture(true), corrections });
      controller.onPhaseChange = (phase) => {
        if (phase.kind === "listening") prefs.value = { ...defaultSettings(), learnsWords: false };
      };
      transcription.enqueue(200, cleanedReply);
      await holdAndRelease(controller);
      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      expect(calls).toEqual(["stop", `watch 101 ${cleaned}`]);
    });

    /** A paste the helper finishes after the user canceled and pressed the key again belongs to the
     * dictation canceled: it is not watched, or its watch would outlive the new key-down's stop. */
    test("a paste finished after the next key-down is not watched", async () => {
      const { calls, corrections } = watcher();
      const pasting = deferred<void>();
      let pastes = 0;
      const { controller } = makeController({
        capture: new CountingCapture(true),
        corrections,
        paste: async () => {
          pastes += 1;
          await pasting.promise;
        },
      });
      transcription.enqueue(200, cleanedReply);
      await holdAndRelease(controller);
      expect(await eventually(() => pastes === 1)).toBe(true);

      controller.cancel();
      controller.handle("start");
      pasting.resolve();
      await sleep(50);

      expect(calls).toEqual(["stop", "stop"]);
      controller.cancel();
    });

    test("without an app in front at key-down, nothing is watched", async () => {
      front.pid = null;
      const { calls, corrections } = watcher();
      const { controller, pastes, copies } = makeController({ capture: new CountingCapture(true), corrections });
      transcription.enqueue(200, cleanedReply);
      await holdAndRelease(controller);
      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual([]);
      expect(copies).toEqual([cleaned]);
      expect(calls).toEqual(["stop"]);
    });

    /** Agent mode's text is the agent's, not a dictation to correct. */
    test("agent mode's paste is not watched", async () => {
      const { calls, corrections } = watcher();
      transcription.enqueue(200, { text: "make this friendlier" });
      completions.enqueue(200, Fixtures.reply("We ship on Friday."));
      const { controller, pastes } = makeController({ capture: new CountingCapture(true), corrections });
      controller.captureContext = async () => selectionScreen("We ship Friday.");
      await holdAndRelease(controller, "agent");
      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      expect(calls).toEqual(["stop"]);
    });
  });

  test("an empty transcript is neither cleaned up nor pasted", async () => {
    transcription.enqueue(200, { text: "  " });

    const { pasted, controller } = await dictate();

    expect(pasted).toEqual([]);
    expect(completions.requests).toHaveLength(0);
    expect(controller.phase).toEqual(failed(nothingHeardMessage));
    expect(used).toEqual([]);
  });

  /** The shared backend errors still explain the failure in the overlay, without a cleanup or paste. */
  test.each([
    [402, `{"error":"no_active_subscription"}`, "Dictation needs an active TabMail subscription."],
    [429, `{"error":"rate_limited"}`, new BackendError("rateLimited").message],
    [400, `{"error":"invalid_request"}`, "Dictation failed. Please try again."],
    // The backend's own timeout: it already waited for the speech model.
    [504, `{"error":"transcription_timeout"}`, "Dictation failed. Please try again."],
    [200, `{"unexpected":true}`, "TabMail returned an unexpected response."],
  ])("a failed transcription (%i %s) is neither cleaned up nor pasted, nor tried again", async (status, body, message) => {
    transcription.enqueue(status, body);

    const { pasted, controller } = await dictate();

    expect(pasted).toEqual([]);
    expect(completions.requests).toHaveLength(0);
    expect(transcription.requests).toHaveLength(1);
    expect(controller.phase).toEqual(failed(message));
  });

  /** At key-down the backend is warmed (`GET /whoami`) while the user speaks, so the transcription
   * after the release finds the connection open and the sign-in checked. */
  describe("the warm-up", () => {
    test("is sent at key-down, under the signed-in account, before the release", async () => {
      warmUps.enqueue(200, { logged_in: true });
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });

      controller.handle("start");
      expect(await eventually(() => warmUps.requests.length === 1)).toBe(true);
      expect(controller.phase.kind === "arming" || controller.phase.kind === "listening").toBe(true);
      expect(transcription.requests).toHaveLength(0);
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      const warmUp = warmUps.requests[0];
      expect(warmUp?.method).toBe("GET");
      expect(warmUp?.url).toBe(`${prefs.value.backendURL}/whoami`);
      expect(warmUp?.headers.Authorization).toBe(transcription.requests[0]?.headers.Authorization);
      expect(warmUps.requests).toHaveLength(1);
    });

    /** Best effort: a warm-up that fails, or has not answered, changes nothing for the dictation. */
    test.each([
      ["fails", () => warmUps.enqueue(500, "")],
      ["cannot connect", () => {}],
      ["never answers", () => {
        warmUps.gate = () => new Promise(() => {});
      }],
    ])("that %s leaves the dictation as it was", async (_, setUp) => {
      setUp();
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });

      await holdAndRelease(controller);

      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(controller.phase).toEqual(idle);
      expect(warmUps.requests).toHaveLength(1);
    });
  });

  /** A server error (the speech model behind the backend rate limited or failed) or a dropped
   * connection is tried again, with a note on the pill, so the user need not say it again. */
  describe("a transcription that fails on the server's side", () => {
    const dropsConnection = () => {
      transcription.gate = async () => {
        if (transcription.requests.length === 1) throw new TransportError("network");
      };
    };

    test.each([
      ["a 500", () => transcription.enqueue(500, "")],
      ["a 502", () => transcription.enqueue(502, { error: "transcription_failed" })],
      ["a 503", () => transcription.enqueue(503, { error: "transcription_unavailable" })],
      // The speech model's rate limit outlasting the backend's own retries: answered as a 502, and
      // tried again, until the backend began retrying it itself (2026-10-03).
      ["the speech model's rate limit", () => transcription.enqueue(429, { error: "transcription_rate_limited" })],
      ["a dropped connection", dropsConnection],
    ])("is tried again after %s, and the retry's text pasted", async (_, fail) => {
      fail();
      transcription.enqueue(200, cleanedReply);
      const pastes: string[] = [];
      const pastedWhile: Phase["kind"][] = [];
      const { controller } = makeController({
        capture: new CountingCapture(true),
        paste: async (text) => {
          pastedWhile.push(controller.phase.kind);
          pastes.push(text);
        },
      });
      controller.transcriptionRetryDelays = [1, 1];
      controller.transcriptionRetryNoticeDelay = 0;
      const phases: Phase[] = [];
      controller.onPhaseChange = (phase) => phases.push(phase);

      await holdAndRelease(controller);

      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      expect(pastes).toEqual([cleaned]);
      // The note goes once the retry answers: nothing is being tried again while the text goes in.
      expect(pastedWhile).toEqual(["transcribing"]);
      expect(controller.phase).toEqual(idle);
      // The same recording, sent again as it was.
      expect(transcription.requests).toHaveLength(2);
      expect(transcription.requests[1]?.body).toBe(transcription.requests[0]?.body);
      expect(phases).toContainEqual({ kind: "retrying", message: retryingMessage });
    });

    test("fails with the server's error once every retry has failed", async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) transcription.enqueue(502, { error: "transcription_failed" });
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [1, 1];

      await holdAndRelease(controller);

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(transcription.requests).toHaveLength(3);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(failed("Dictation failed. Please try again."));
    });

    /** Waits `transcriptionRetryDelays` between tries. */
    test("waits before each retry", async () => {
      transcription.enqueue(502, { error: "transcription_failed" });
      transcription.enqueue(502, { error: "transcription_failed" });
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [100, 200];
      const sentAt: number[] = [];
      transcription.gate = async () => {
        sentAt.push(performance.now());
      };

      await holdAndRelease(controller);

      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      expect(sentAt).toHaveLength(3);
      expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(100 - 5);
      expect(sentAt[2]! - sentAt[1]!).toBeGreaterThanOrEqual(200 - 5);
    });

    test("a request that timed out is not tried again", async () => {
      transcription.gate = async () => {
        throw new TransportError("timeout");
      };
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [1, 1];

      await holdAndRelease(controller);

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(transcription.requests).toHaveLength(1);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(failed(new TransportError("timeout").message));
    });

    test("canceled while it waits to try again, it sends nothing more", async () => {
      transcription.enqueue(502, { error: "transcription_failed" });
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [300];
      controller.transcriptionRetryNoticeDelay = 0;

      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "retrying")).toBe(true);
      controller.handle("cancel");
      await sleep(600);

      expect(transcription.requests).toHaveLength(1);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(idle);
    });

    /** A brief rate limit only makes the dictation take a moment longer: the pill says nothing of a
     * retry that answers before `transcriptionRetryNoticeDelay`. */
    test("a retry that answers before the notice delay never shows the note", async () => {
      transcription.enqueue(503, { error: "transcription_unavailable" });
      transcription.enqueue(503, { error: "transcription_unavailable" });
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [1, 1];
      controller.transcriptionRetryNoticeDelay = 10_000;
      const phases: Phase[] = [];
      controller.onPhaseChange = (phase) => phases.push(phase);

      await holdAndRelease(controller);

      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      expect(transcription.requests).toHaveLength(3);
      expect(pastes).toEqual([cleaned]);
      expect(phases.map((phase) => phase.kind)).not.toContain("retrying");
    });

    /** From the first server error until a retry answers, the controller says it is retrying, the note
     * or not, so the thinking circle can turn purple before the note shows (owner, 2026-10-02). */
    test("says it is retrying from the first server error until a retry answers", async () => {
      transcription.enqueue(503, { error: "transcription_unavailable" });
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [300];
      controller.transcriptionRetryNoticeDelay = 10_000;
      expect(controller.isRetrying).toBe(false);
      // What the overlay is told, as each change notifies it.
      const told: string[] = [];
      controller.observe(() => told.push(`${controller.phase.kind}:${controller.isRetrying}`));

      await holdAndRelease(controller);

      expect(await eventually(() => told.includes("transcribing:true"))).toBe(true);
      expect(controller.isRetrying).toBe(true);
      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      expect(controller.isRetrying).toBe(false);
      // Told when the retry answers, not only when the dictation ends.
      expect(told.slice(told.indexOf("transcribing:true"))).toContain("transcribing:false");
      expect(told.at(-1)?.endsWith(":false")).toBe(true);
    });

    /** A dictation that fails with no retry left stops saying it is retrying. */
    test("stops saying it is retrying when the retries run out", async () => {
      transcription.enqueue(503, { error: "transcription_unavailable" });
      transcription.enqueue(503, { error: "transcription_unavailable" });
      const { controller } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [1];
      controller.transcriptionRetryNoticeDelay = 10_000;

      await holdAndRelease(controller);

      expect(await eventually(() => controller.phase.kind === "failed")).toBe(true);
      expect(controller.isRetrying).toBe(false);
    });

    /** The circle is purple only while this dictation has hit a server error: a canceled dictation's
     * retry still in flight neither shows on the next dictation nor, answering late, clears the next
     * one's own retry (owner, 2026-10-02). */
    test("a canceled dictation's retry neither shows on nor clears the next dictation's", async () => {
      // Replies go in the order the requests pass the gate: the first dictation's retry (2) is held
      // while the second dictation's first request (3) fails and its retry (4) is held.
      transcription.enqueue(503, { error: "transcription_unavailable" });
      transcription.enqueue(503, { error: "transcription_unavailable" });
      transcription.enqueue(200, cleanedReply);
      transcription.enqueue(200, cleanedReply);
      const staleRetry = deferred<void>();
      const ownRetry = deferred<void>();
      transcription.gate = async () => {
        const sent = transcription.requests.length;
        if (sent === 2) await staleRetry.promise;
        if (sent === 4) await ownRetry.promise;
      };
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [1];
      controller.transcriptionRetryNoticeDelay = 10_000;

      await holdAndRelease(controller);
      expect(await eventually(() => transcription.requests.length === 2 && controller.isRetrying)).toBe(true);
      controller.handle("cancel");
      expect(controller.isRetrying).toBe(false);

      // What the overlay is told for the second dictation, as each change notifies it.
      const told: string[] = [];
      controller.observe(() => told.push(`${controller.phase.kind}:${controller.isRetrying}`));
      await holdAndRelease(controller);
      expect(await eventually(() => transcription.requests.length === 4)).toBe(true);
      expect(controller.isRetrying).toBe(true);
      const transcribing = told.filter((entry) => entry.startsWith("transcribing:"));
      expect(transcribing[0]).toBe("transcribing:false");
      expect(transcribing).toContain("transcribing:true");
      expect(told.every((entry) => entry.startsWith("transcribing:") || entry.endsWith(":false"))).toBe(true);
      staleRetry.resolve();
      await sleep(50);
      expect(controller.isRetrying).toBe(true);

      ownRetry.resolve();
      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      expect(controller.isRetrying).toBe(false);
    });

    /** The note comes up once the retries have gone on for `transcriptionRetryNoticeDelay` since the
     * first failure, not at the failure, and stays until a retry answers. */
    test("shows the note once the notice delay has passed since the first failure", async () => {
      transcription.enqueue(502, { error: "transcription_failed" });
      transcription.enqueue(502, { error: "transcription_failed" });
      transcription.enqueue(200, cleanedReply);
      const pastes: string[] = [];
      const pastedWhile: Phase["kind"][] = [];
      const { controller } = makeController({
        capture: new CountingCapture(true),
        paste: async (text) => {
          pastedWhile.push(controller.phase.kind);
          pastes.push(text);
        },
      });
      controller.transcriptionRetryDelays = [100, 300];
      controller.transcriptionRetryNoticeDelay = 200;
      const sentAt: number[] = [];
      transcription.gate = async () => {
        sentAt.push(performance.now());
      };
      const retryingAt: number[] = [];
      controller.onPhaseChange = (phase) => {
        if (phase.kind === "retrying") retryingAt.push(performance.now());
      };

      await holdAndRelease(controller);

      expect(await eventually(() => pastes.length === 1 && settled(controller))).toBe(true);
      expect(sentAt).toHaveLength(3);
      // Shown once, the notice delay after the first failure: during the second wait, not at either failure.
      expect(retryingAt).toHaveLength(1);
      expect(retryingAt[0]! - sentAt[0]!).toBeGreaterThanOrEqual(200 - 5);
      expect(retryingAt[0]!).toBeGreaterThan(sentAt[1]!);
      expect(retryingAt[0]!).toBeLessThan(sentAt[2]!);
      expect(pastedWhile).toEqual(["transcribing"]);
    });

    /** Answered, failed or canceled before the notice delay, the note never comes up over what follows. */
    test.each([
      ["every retry failed", "fails"],
      ["canceled while it waits", "cancel"],
    ] as const)("the note never comes up later once %s", async (_, ending) => {
      for (let attempt = 0; attempt < 3; attempt += 1) transcription.enqueue(502, { error: "transcription_failed" });
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = ending === "fails" ? [1, 1] : [300];
      controller.transcriptionRetryNoticeDelay = 150;
      const phases: Phase[] = [];
      controller.onPhaseChange = (phase) => phases.push(phase);

      await holdAndRelease(controller);
      if (ending === "cancel") {
        expect(await eventually(() => transcription.requests.length === 1)).toBe(true);
        controller.handle("cancel");
      }
      expect(await eventually(() => settled(controller))).toBe(true);
      const ended = controller.phase;
      await sleep(300);

      expect(phases.map((phase) => phase.kind)).not.toContain("retrying");
      expect(controller.phase).toEqual(ended);
      expect(ended).toEqual(ending === "fails" ? failed("Dictation failed. Please try again.") : idle);
      expect(pastes).toEqual([]);
    });

    /** Canceled while a retry's request is still out (a token refresh, or a reply already on its way,
     * does not stop for the cancel), the note's time can come before that request settles: the note
     * never comes up, over the idle pill or over the next dictation's. */
    test("the note never comes up over what follows a cancel while a retry is still out", async () => {
      transcription.enqueue(502, { error: "transcription_failed" });
      transcription.enqueue(200, cleanedReply);
      const held = deferred<void>();
      transcription.gate = async () => {
        if (transcription.requests.length === 2) await held.promise;
      };
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [1];
      controller.transcriptionRetryNoticeDelay = 100;
      const phases: Phase[] = [];
      controller.onPhaseChange = (phase) => phases.push(phase);

      await holdAndRelease(controller);
      expect(await eventually(() => transcription.requests.length === 2)).toBe(true);
      controller.handle("cancel");
      expect(controller.phase).toEqual(idle);
      // The next dictation starts before the old note's time comes, and is still held when it does.
      controller.handle("start");
      await sleep(250);
      const next = controller.phase.kind;
      held.resolve();
      controller.handle("cancel");
      await sleep(50);

      expect(phases.map((phase) => phase.kind)).not.toContain("retrying");
      expect(["arming", "listening"]).toContain(next);
      expect(controller.phase).toEqual(idle);
      expect(pastes).toEqual([]);
    });

    /** A retry that answers after the dictation was canceled, the note already up, leaves the pill
     * as the cancel left it, not transcribing. */
    test("a retry that answers after a cancel leaves the pill as the cancel left it", async () => {
      transcription.enqueue(502, { error: "transcription_failed" });
      transcription.enqueue(200, cleanedReply);
      const held = deferred<void>();
      transcription.gate = async () => {
        if (transcription.requests.length === 2) await held.promise;
      };
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [1];
      controller.transcriptionRetryNoticeDelay = 0;

      await holdAndRelease(controller);
      expect(await eventually(() => transcription.requests.length === 2 && controller.phase.kind === "retrying")).toBe(true);
      controller.handle("cancel");
      held.resolve();
      await sleep(100);

      expect(controller.phase).toEqual(idle);
      expect(pastes).toEqual([]);
    });

    /** The server's error can still arrive after the dictation was canceled: it is not tried again,
     * and the pill never says it is. */
    test("a server error answered after a cancel is not tried again", async () => {
      transcription.enqueue(502, { error: "transcription_failed" });
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.transcriptionRetryDelays = [1, 1];
      const phases: Phase[] = [];
      controller.onPhaseChange = (phase) => phases.push(phase);
      transcription.gate = async () => {
        if (transcription.requests.length === 1) controller.handle("cancel");
      };

      await holdAndRelease(controller);
      await sleep(200);

      expect(transcription.requests).toHaveLength(1);
      expect(pastes).toEqual([]);
      expect(phases.map((phase) => phase.kind)).not.toContain("retrying");
      expect(controller.phase).toEqual(idle);
    });
  });

  /** A transcript answered after a cancel is not the user's text: it pastes nothing and marks no
   * dictionary word used (ADR-DESK-038). */
  test("a transcript answered after a cancel marks no word used", async () => {
    transcription.enqueue(200, cleanedReply);
    const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
    transcription.gate = async () => {
      controller.handle("cancel");
    };

    await holdAndRelease(controller);
    expect(await eventually(() => transcription.requests.length === 1)).toBe(true);
    await sleep(50);

    expect(pastes).toEqual([]);
    expect(used).toEqual([]);
  });

  /** Canceled while the request runs, the cleanup with it (another key pressed while the hotkey is
   * held): the request is canceled right away and its result is not pasted. */
  test("a dictation canceled during its request pastes nothing", async () => {
    transcription.enqueue(200, cleanedReply);
    const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
    let canceledAfter: number | null = null;
    transcription.gate = async (asked) => {
      const started = performance.now();
      controller.handle("cancel");
      try {
        await sleep(5_000, asked.signal);
      } catch {
        canceledAfter = performance.now() - started;
      }
    };

    await holdAndRelease(controller);

    expect(await eventually(() => canceledAfter !== null)).toBe(true);
    await sleep(50);
    expect(transcription.requests).toHaveLength(1);
    expect(pastes).toEqual([]);
    expect(controller.phase).toEqual(idle);
    expect(canceledAfter ?? 60_000).toBeLessThan(1_000);
  });

  /** The user signed out and into another account while the request ran: the transcription and its
   * cleanup ran together under the account signed in at the upload, so the cleaned text is that
   * account's, and nothing goes out under the other one (ADR-DESK-008). */
  test("an account switch during the request sends nothing under the other account", async () => {
    const account = signedIn(auth);
    transcription.enqueue(200, cleanedReply);
    auth.enqueue(200, Fixtures.sessionJSON({ access: "access-b", refresh: "refresh-b", userID: "user-2" }));
    transcription.gate = async () => {
      account.signOut();
      await account.verify(Fixtures.email, "123456");
    };
    const { controller, pastes } = makeController({ account, capture: new CountingCapture(true) });

    await holdAndRelease(controller);
    expect(await eventually(() => pastes.length > 0)).toBe(true);

    expect(account.session?.userID).toBe("user-2");
    expect(transcription.authorizations).toEqual(["Bearer access-1"]);
    expect(completions.requests).toHaveLength(0);
    expect(pastes).toEqual([cleaned]);
  });

  describe("key-down to paste", () => {
    /** Until the user consents in the welcome wizard, holding the key records nothing, reads no
     * screen and sends nothing; it says why. Consent is asked at every key-down. */
    test("without consent nothing is recorded, read or sent", async () => {
      prefs.value = { ...prefs.value, hasConsented: false };
      const capture = new CountingCapture();
      const { controller, pastes } = makeController({ capture });
      let reads = 0;
      controller.captureContext = () => {
        reads += 1;
        return null;
      };
      const blocked = failed("Finish setting up TabMail Voice from its menu to dictate.");

      controller.handle("start");
      controller.handle("finish");
      await sleep(100);
      expect(controller.phase).toEqual(blocked);
      expect([capture.starts, reads, transcription.requests.length, completions.requests.length, pastes.length]).toEqual([0, 0, 0, 0, 0]);

      prefs.value = { ...prefs.value, hasConsented: true };
      controller.handle("start");
      expect(controller.phase).toEqual(arming);
      expect(capture.starts).toBe(1);
      expect(reads).toBe(1);
      controller.handle("cancel");

      // Withdrawing consent later blocks the next dictation too: an earlier agreement doesn't outlive it.
      prefs.value = { ...prefs.value, hasConsented: false };
      controller.handle("start");
      controller.handle("finish");
      await sleep(100);
      expect(controller.phase).toEqual(blocked);
      expect([capture.starts, reads, transcription.requests.length, completions.requests.length, pastes.length]).toEqual([1, 1, 0, 0, 0]);
    });

    /** Everything else a dictation needs is checked at key-down too, before anything is recorded,
     * read or sent; the overlay says what is missing. */
    test.each<[string, () => Parameters<typeof makeController>[0], string]>([
      ["signed out", () => ({ account: signedIn(auth, null) }), "Sign in to TabMail in Settings to dictate."],
      ["without the microphone", () => ({ microphone: "denied" }), "Allow microphone access in TabMail Voice's menu to dictate."],
      ["without Accessibility", () => ({ accessibility: false }), "Allow Accessibility access in TabMail Voice's menu so dictation can type for you."],
    ])("%s nothing is recorded, read or sent", async (_, options, message) => {
      const capture = new CountingCapture(true);
      const { controller, pastes } = makeController({ ...options(), capture });
      let reads = 0;
      controller.captureContext = () => {
        reads += 1;
        return null;
      };
      transcription.enqueue(200, { text: transcript });

      controller.handle("start");
      controller.handle("finish");
      await sleep(100);

      expect(controller.phase).toEqual(failed(message));
      expect([capture.starts, reads, transcription.requests.length, completions.requests.length, pastes.length]).toEqual([0, 0, 0, 0, 0]);
    });

    /** Canceled while the transcription runs: nothing is cleaned up or pasted, and the overlay just
     * goes, with no error for the user's own cancel (not even "nothing heard"), whether the reply
     * still arrives or the request fails as canceled. */
    test.each([
      ["whose reply arrives anyway", false, transcript],
      ["whose empty reply arrives anyway", false, "  "],
      ["whose request fails as canceled", true, transcript],
    ])("a dictation canceled during the transcription %s shows nothing", async (_, honorsCancel, heard) => {
      transcription.honorsCancel = honorsCancel;
      transcription.enqueue(200, { text: heard });
      completions.enqueue(200, cleanedStream);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      const phases: Phase[] = [];
      transcription.gate = async () => {
        controller.onPhaseChange = (phase) => phases.push(phase);
        controller.handle("cancel");
      };

      await holdAndRelease(controller);

      expect(await eventually(() => transcription.requests.length === 1)).toBe(true);
      await sleep(200);
      expect(phases).toEqual([idle]);
      expect(completions.requests).toHaveLength(0);
      expect(pastes).toEqual([]);
    });

    /** A hold started while the canceled dictation's request is still failing keeps its microphone:
     * the older dictation's end doesn't stop the newer one. */
    test("a hold right after a cancel during the transcription keeps listening", async () => {
      transcription.honorsCancel = true;
      transcription.enqueue(200, { text: transcript });
      const capture = new CountingCapture(true);
      const { controller } = makeController({ capture });
      transcription.gate = async () => {
        controller.handle("cancel");
        controller.handle("start");
      };

      await holdAndRelease(controller);

      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      await sleep(200);
      expect(controller.phase).toEqual(listening);
      expect(capture.events.at(-1)).toBe("start");
      controller.handle("cancel");
    });

    /** Canceled while the sign-in is refreshed, before the recording goes out: the recording is
     * never sent. The real transport, against a server on the loopback interface. */
    test("a dictation canceled during a sign-in refresh sends nothing", async () => {
      const uploads: string[] = [];
      const server = createServer((incoming, response) => {
        uploads.push(incoming.url ?? "");
        response.end(JSON.stringify({ text: transcript }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        prefs.value = { ...prefs.value, backendURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
        const account = signedIn(auth, Fixtures.session({ expiresIn: config.tokenRefreshLeewaySeconds / 2 }));
        auth.enqueue(200, Fixtures.sessionJSON({ access: "access-2", refresh: "refresh-2" }));
        const { controller, pastes } = makeController({ account, capture: new CountingCapture(true), transcriptionTransport: liveTransport });
        // The key-down warm-up starts the refresh; the upload waits for the same one, and is canceled
        // while it does.
        auth.gate = async () => {
          await eventually(() => controller.phase.kind === "transcribing");
          controller.handle("cancel");
        };

        await holdAndRelease(controller);

        expect(await eventually(() => auth.requests.length === 1 && controller.phase.kind === "idle")).toBe(true);
        await sleep(300);
        expect(uploads).toEqual([]);
        expect(pastes).toEqual([]);
        expect(controller.phase).toEqual(idle);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });

    /** The screen is read at key-down; the upload waits up to `contextWait` for it and sends it with the
     * recording, for the backend's cleanup. */
    test("cleans up with the screen read at key-down", async () => {
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      const read = deferred<ScreenContext | null>();
      const readStarted: { phase: Phase; transcriptions: number }[] = [];
      controller.captureContext = () => {
        readStarted.push({ phase: controller.phase, transcriptions: transcription.requests.length });
        return read.promise;
      };
      controller.contextWait = 30_000;

      await holdAndRelease(controller);
      // Read once, at key-down: before the overlay is revealed and before anything is sent.
      expect(readStarted).toEqual([{ phase: arming, transcriptions: 0 }]);
      // Longer than the default wait: using the default instead of the override loses this screen.
      await sleep(config.contextWait * 2);
      expect(transcription.requests).toHaveLength(0);
      expect(pastes).toEqual([]);
      read.resolve(screen("A"));

      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length > 0)).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(transcription.requests).toHaveLength(1);
      expect(cleanupVars(0)?.app_name).toBe("Example Notes A");
      expect(cleanupVars(0)?.screen_text).toContain("Agenda A");
      expect(completions.requests).toHaveLength(0);
    });

    /** The debug log file gets what was heard, what the cleanup made of it and what was pasted
     * (ADR-DESK-015), after the backend clients' own entries. */
    test("a dictation logs its transcript, cleaned text and paste", async () => {
      transcription.enqueue(200, cleanedReply);

      const entries = steps(await loggedContent(async () => {
        await dictate();
      }));

      expect(entries.map((entry) => entry.label)).toEqual(["Transcript (dictation)", "DictationCleanup: cleaned text", "DictationController: pasting"]);
      expect(entries.map((entry) => entry.text)).toEqual([transcript, cleaned, cleaned]);
    });

    /** Canceled while its screen is still being read, during the release tail or in the upload's
     * wait for the read after it: nothing is sent or pasted, and the next dictation is cleaned up
     * with its own screen. */
    test.each([
      ["during the release tail", config.releaseTailDuration / 2],
      ["during the upload's wait", config.releaseTailDuration + 200],
    ])("a dictation canceled while its screen is read is not sent (%s)", async (_, cancelAfter) => {
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      const first = deferred<ScreenContext | null>();
      controller.captureContext = () => first.promise;
      controller.contextWait = 5_000;

      await holdAndRelease(controller);
      await sleep(cancelAfter);
      controller.handle("cancel");
      first.resolve(screen("A"));
      await sleep(200);
      expect(transcription.requests).toHaveLength(0);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(idle);

      controller.captureContext = async () => screen("B");
      await holdAndRelease(controller);

      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length > 0)).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(transcription.requests).toHaveLength(1);
      expect(cleanupVars(0)?.app_name).toBe("Example Notes B");
    });

    /** The screen read is best effort: not done within the app's own `contextWait`, the recording goes
     * without it rather than waiting. */
    test("a screen read not done in time is left out", async () => {
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      const read = deferred<ScreenContext | null>();
      controller.captureContext = () => read.promise;

      await holdAndRelease(controller);
      const released = performance.now();
      expect(await eventually(() => transcription.requests.length === 1)).toBe(true);
      // Slack for a loaded runner, far below a wait that would hold the dictation for a slow app.
      expect(performance.now() - released).toBeLessThan(config.releaseTailDuration + config.contextWait + 3_000);

      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length > 0)).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(cleanupVars(0)?.app_name).toBe("");
      expect(cleanupVars(0)?.screen_text).toBe("");
      read.resolve(null);
    });

    /** A screen read done after the release, within the app's own `contextWait`, still goes with the
     * recording: to the cleanup, and its names and terms to the vocabulary. */
    test("a screen read done just after the release is sent", async () => {
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      const read = deferred<ScreenContext | null>();
      controller.captureContext = () => read.promise;

      await holdAndRelease(controller);
      // Past the release tail: during the upload's wait for the read.
      void sleep(config.releaseTailDuration + config.contextWait / 5).then(() =>
        read.resolve(blankScreen({ appName: "Example Notes A", windowTitle: "Launch with Brevalle Labs", renderedText: "» Ask Kaelthorne Drake ‸" })));

      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length > 0)).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(cleanupVars(0)?.app_name).toBe("Example Notes A");
      expect(transcription.body(0).vocabulary).toEqual(["Brevalle Labs", "Kaelthorne Drake"]);
    });
  });

  describe("agent mode (Space during the hold)", () => {
    /** One agent-mode request, spoken over `context`: the controller, what was pasted, and every phase
     * it went through. `prepare` runs on the controller before the hold. */
    async function carryOut(
      context: ScreenRead | null,
      thunderbird?: FakeThunderbird,
      prepare: (controller: DictationController) => void = () => {},
      options: { account?: AccountModel; paste?: DictationDependencies["paste"]; frontmostApp?: () => Promise<number | null>; connectorTools?: ConnectorTool[] } = {},
    ): Promise<{ controller: DictationController; pastes: string[]; phases: Phase[] }> {
      const { controller, pastes } = makeController({ capture: new CountingCapture(true), thunderbird, ...options });
      const phases: Phase[] = [];
      controller.onPhaseChange = (phase) => phases.push(phase);
      controller.captureContext = () => (context ? Promise.resolve(context) : null);
      prepare(controller);
      await holdAndRelease(controller, "agent");
      expect(await eventually(() => settled(controller))).toBe(true);
      return { controller, pastes, phases };
    }

    /** With the screen hidden for privacy, agent mode is as with no selection (Compose), and its
     * tool is told the screen is hidden, so it does not answer from an earlier screen; a screen
     * that was only not read says nothing. */
    test.each([true, false])("agent mode tells its tool the screen is hidden for privacy (hidden: %s)", async (hidden) => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("We ship on Friday."));

      const { controller, pastes } = await carryOut(hidden ? { hidden: true } : null, undefined, (controller) => {
        if (!hidden) controller.captureContext = async () => null;
      });

      expect(controller.tools).toEqual(["compose"]);
      expect(pastes).toEqual(["We ship on Friday."]);
      expect(completions.requests).toHaveLength(1);
      expect(completionsVars(0)?.screen_text).toBe(hidden ? screenHiddenNote : "");
      expect(completionsVars(0)?.app_name).toBe("");
      expect(transcription.body(0).vocabulary).toBeUndefined();
    });

    /** Without an email app there is nothing to choose: the selection's writing tool runs, with no
     * agent call. */
    test("agent mode edits the selection in place", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("Could we ship on Friday?"));

      const { controller, pastes, phases } = await carryOut(selectionScreen("Ship it Friday or else.\n"));

      // Pasted over the selection, keeping the selected line's line break; never the request itself.
      expect(pastes).toEqual(["Could we ship on Friday?\n"]);
      expect(controller.phase).toEqual(idle);
      expect(controller.mode).toBe("agent");
      expect(controller.tools).toEqual(["edit"]);
      expect(phases).toContainEqual(running("edit"));
      expect(completions.requests).toHaveLength(1);
      expect(completionsVars(0)?.content).toBe("system_prompt_desktop_edit");
      expect(completionsVars(0)?.user_request).toBe(request);
      expect(completionsVars(0)?.selected_text).toBe("Ship it Friday or else.\n");
    });

    /** Agent mode logs the request, the text its tool wrote (fitted to the selection) and the paste. */
    test("agent mode logs the request, the written text and the paste", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("Could we ship on Friday?"));

      const entries = steps(await loggedContent(async () => {
        await carryOut(selectionScreen("Ship it Friday or else.\n"));
      }));

      expect(entries.map((entry) => entry.label)).toEqual(["Transcript (agent)", "DesktopAgent: edit wrote", "DictationController: pasting"]);
      expect(entries.map((entry) => entry.text)).toEqual([request, "Could we ship on Friday?\n", "Could we ship on Friday?\n"]);
    });

    /** A mail request logs the chat message sent to Thunderbird, and no paste. */
    test("a mail request logs the chat message sent", async () => {
      transcription.enqueue(200, { text: "find sam's invoice from last week" });
      completions.enqueue(200, reply("thunderbird"));
      completions.enqueue(200, reply("Find the invoice Sam sent last week."));

      const entries = steps(await loggedContent(async () => {
        await carryOut(selectionScreen(""), new FakeThunderbird());
      }));

      expect(entries.map((entry) => entry.label)).toEqual(["Transcript (agent)", "DesktopAgent: thunderbird wrote", "ThunderbirdRelay: sent"]);
      expect(entries.map((entry) => entry.text)).toEqual(["find sam's invoice from last week", "Find the invoice Sam sent last week.", "Find the invoice Sam sent last week."]);
    });

    test("agent mode composes at the caret with nothing selected", async () => {
      transcription.enqueue(200, { text: "write that we ship on Friday" });
      completions.enqueue(200, reply("We ship on Friday."));

      let result: Awaited<ReturnType<typeof carryOut>> | undefined;
      const entries = steps(await loggedContent(async () => {
        result = await carryOut(selectionScreen(""));
      }));
      if (!result) throw new Error("no result");
      const { controller, pastes, phases } = result;

      expect(pastes).toEqual(["We ship on Friday."]);
      // The debug log file gets the request, the text Compose wrote and the paste (ADR-DESK-015).
      expect(entries.map((entry) => entry.label)).toEqual(["Transcript (agent)", "DesktopAgent: compose wrote", "DictationController: pasting"]);
      expect(entries.map((entry) => entry.text)).toEqual(["write that we ship on Friday", "We ship on Friday.", "We ship on Friday."]);
      expect(controller.tools).toEqual(["compose"]);
      expect(phases).toContainEqual(running("compose"));
      expect(completionsVars(0)?.content).toBe("system_prompt_desktop_compose");
      // The spoken request was transcribed with the dictionary too: its words count as used.
      expect(used).toEqual([["write that we ship on Friday"]]);
    });

    /** The selection alone decides between Edit and Compose, as the bubbles showed it: the other
     * writing tool is not offered (`available_tools`), and an agent that names it anyway fails the
     * request, pasting nothing. */
    test.each<[string, string, AgentToolID]>([
      ["Ship it Friday or else.", "compose", "edit"],
      ["", "edit", "compose"],
    ])("with the selection %j the agent's %s is not offered", async (selected, agentChoice, tool) => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply(agentChoice));

      const { controller, pastes } = await carryOut(selectionScreen(selected), new FakeThunderbird());

      expect(controller.tools).toEqual([tool, "thunderbird"]);
      expect(completions.body(0).available_tools).toEqual([tool, "thunderbird"]);
      expect(completions.requests).toHaveLength(1);
      expect(controller.phase).toEqual(failed(new AgentError("noTool").message));
      expect(pastes).toEqual([]);
    });

    /** A selection that holds a secret reaches the app redacted (ADR-DESK-046). Edit's rewrite of it
     * would replace the user's text, secret included, with the placeholder: nothing is written or
     * pasted, and the overlay says why. */
    test("agent mode doesn't rewrite a selection the helper redacted", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("edit"));
      completions.enqueue(200, reply("connect with postgres://app:[redacted]@db.example.com, please"));

      const { controller, pastes } = await carryOut({ ...selectionScreen("connect with postgres://app:[redacted]@db.example.com"), selectionRedacted: true }, new FakeThunderbird());

      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(failed(new AgentError("secretInSelection").message));
      expect(completions.requests).toHaveLength(1);
    });

    /** Whatever goes wrong, agent mode pastes nothing: the spoken request is not text for the document. */
    test.each<[[number, string][], string]>([
      [[[200, "rewrite"]], new AgentError("noTool").message],
      [[[200, "compose"], [200, ""]], new AgentError("noText").message],
      [[[200, "compose"], [500, ""]], new BackendError("failed", 500).message],
    ])("agent mode pastes nothing when it cannot carry out the request (%j)", async (replies, message) => {
      transcription.enqueue(200, { text: request });
      for (const [status, assistant] of replies) {
        if (status === 200) completions.enqueue(200, reply(assistant));
        else completions.enqueue(status, { error: "internal_error" });
      }
      const thunderbird = new FakeThunderbird();

      const { controller, pastes } = await carryOut(selectionScreen(""), thunderbird);

      expect(pastes).toEqual([]);
      expect(thunderbird.pasted).toEqual([]);
      expect(controller.phase).toEqual(failed(message));
      expect(completions.requests).toHaveLength(replies.length);
    });

    /** A mail or calendar request is restated as a chat message and typed into TabMail's chat in
     * Thunderbird; nothing is pasted where the user was. */
    test("agent mode sends mail requests to Thunderbird", async () => {
      transcription.enqueue(200, { text: "find sam's invoice from last week" });
      completions.enqueue(200, reply("thunderbird"));
      completions.enqueue(200, reply("Find the invoice Sam sent last week."));
      const thunderbird = new FakeThunderbird();

      const { controller, pastes, phases } = await carryOut(selectionScreen(""), thunderbird);

      expect(controller.tools).toEqual(["compose", "thunderbird"]);
      expect(controller.emailAppPath).toBe(FakeThunderbird.path);
      expect(thunderbird.pasted).toEqual(["Find the invoice Sam sent last week."]);
      expect(thunderbird.events.at(-1)).toBe("return");
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(idle);
      expect(phases).toContainEqual(running("thunderbird"));
      expect(completionsVars(1)?.content).toBe("system_prompt_desktop_thunderbird");
      expect(completionsVars(1)?.user_request).toBe("find sam's invoice from last week");
    });

    /** Without Thunderbird its bubble isn't shown and the agent isn't asked: the request is written
     * where the user is, and nothing is sent anywhere else. */
    test("without Thunderbird its tool is not offered", async () => {
      transcription.enqueue(200, { text: "find sam's invoice" });
      completions.enqueue(200, reply("Sam's invoice"));
      const thunderbird = new FakeThunderbird();
      thunderbird.installed = false;

      const { controller, pastes } = await carryOut(selectionScreen(""), thunderbird);

      expect(controller.tools).toEqual(["compose"]);
      expect(controller.emailAppPath).toBeNull();
      expect(controller.phase).toEqual(idle);
      expect(completions.requests).toHaveLength(1);
      expect(completionsVars(0)?.content).toBe("system_prompt_desktop_compose");
      expect(thunderbird.events).toEqual([]);
      expect(pastes).toEqual(["Sam's invoice"]);
    });

    test("a chat that does not open fails the request", async () => {
      transcription.enqueue(200, { text: "find sam's invoice" });
      completions.enqueue(200, reply("thunderbird"));
      completions.enqueue(200, reply("Find the invoice Sam sent."));
      const thunderbird = new FakeThunderbird();
      thunderbird.shortcutOpensChat = false;

      const { controller, pastes } = await carryOut(selectionScreen(""), thunderbird);

      expect(controller.phase).toEqual(failed(new RelayError("chatNotFocused").message));
      expect(thunderbird.pasted).toEqual([]);
      expect(pastes).toEqual([]);
    });

    /** Agent mode waits for the whole screen read, however long it takes, and offers no writing tool
     * until it is done: the selection it carries decides between Edit and Compose. */
    test("agent mode waits for the whole screen read", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("Could we ship on Friday?"));
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      const read = deferred<ScreenContext | null>();
      controller.captureContext = () => read.promise;
      controller.contextWait = 0;

      await holdAndRelease(controller, "agent");
      expect(await eventually(() => transcription.requests.length === 1)).toBe(true);
      await sleep(1_000);
      expect(controller.tools).toEqual([]);
      expect(completions.requests).toHaveLength(0);
      read.resolve(selectionScreen("Ship it Friday or else."));

      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length > 0)).toBe(true);
      expect(controller.tools).toEqual(["edit"]);
      expect(pastes).toEqual(["Could we ship on Friday?"]);
      expect(completionsVars(0)?.selected_text).toBe("Ship it Friday or else.");
    });

    /** Space switches the mode only while the key is held: back and forth, with the tools following. */
    test("Space toggles agent mode only during the hold", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true), thunderbird: new FakeThunderbird() });
      controller.captureContext = async () => selectionScreen("");

      controller.handle("toggleMode");
      expect(controller.mode).toBe("dictation");
      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      expect(controller.tools).toEqual([]);
      controller.handle("toggleMode");
      expect(controller.mode).toBe("agent");
      expect(await eventually(() => controller.tools.length === 2)).toBe(true);
      expect(controller.tools).toEqual(["compose", "thunderbird"]);
      controller.handle("toggleMode");
      expect(controller.mode).toBe("dictation");
      expect(controller.tools).toEqual([]);
      expect(controller.emailAppPath).toBeNull();
      controller.handle("cancel");
      controller.handle("toggleMode");
      expect(controller.mode).toBe("dictation");
    });

    /** Beside the tools' bubbles, one for each app switched on at key-down whose tools this computer
     * has (Notes switched off, Contacts with no tools here), only while Answer is offered: its loop
     * runs their tools. A switch changed during the hold changes none of them (the settings are
     * snapshotted at key-down). */
    test.each([true, false])("the apps switched on show beside Answer (Answer on: %s)", async (answerOn) => {
      const tool = (connector: ConnectorID): ConnectorTool => ({ name: `${connector}_example`, connector, progressLabel: "", confirmation: () => null, run: async () => "" });
      prefs.value = { ...prefs.value, enabledTools: answerOn ? [...agentToolIDs] : toolsWithoutAnswer, enabledConnectors: connectorIDs.filter((connector) => connector !== "notes") };
      const { controller } = makeController({ capture: new CountingCapture(true), thunderbird: new FakeThunderbird(), connectorTools: [tool("web"), tool("calendar"), tool("notes"), tool("calendar")] });
      controller.captureContext = async () => selectionScreen("");

      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      expect(controller.connectors).toEqual([]);
      controller.handle("toggleMode");
      expect(await eventually(() => controller.tools.length > 0)).toBe(true);
      prefs.value = { ...prefs.value, enabledTools: [...agentToolIDs], enabledConnectors: [...connectorIDs] };

      expect(controller.tools.includes("answer")).toBe(answerOn);
      expect(controller.connectors).toEqual(answerOn ? ["calendar", "web"] : []);
      controller.handle("toggleMode");
      expect(controller.connectors).toEqual([]);
      controller.handle("cancel");
    });

    /** The user moved to another app while the text was written: it is not pasted there. */
    test.each<[string, AgentToolID]>([
      ["Ship it Friday or else.", "edit"],
      ["", "compose"],
    ])("agent text is not pasted into another app (selection %j)", async (selected, tool) => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("Could we ship on Friday?"));
      completions.gate = async () => {
        front.pid = 202;
      };

      const { controller, pastes, phases } = await carryOut(selectionScreen(selected));

      expect(phases).toContainEqual(running(tool));
      expect(completions.requests).toHaveLength(1);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(copied);
    });

    /** Canceled while the paste reads the app in front, the last wait before it, with the next
     * dictation already listening: the old request's text is pasted nowhere. */
    test.each<[string, AgentToolID]>([
      ["Ship it Friday or else.", "edit"],
      ["", "compose"],
    ])("agent text canceled during the last wait is not pasted (selection %j)", async (selected, tool) => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("Could we ship on Friday?"));
      const kept = deferred<number>();
      let reads = 0;
      // The second read is this request's paste; key-downs answer at once.
      const frontmostApp = (): Promise<number> => ((reads += 1) === 2 ? kept.promise : Promise.resolve(front.pid ?? 0));
      const { controller, pastes, history } = makeController({ capture: new CountingCapture(true), frontmostApp });
      controller.captureContext = async () => selectionScreen(selected);

      await holdAndRelease(controller, "agent");
      expect(await eventually(() => controller.phase.kind === "running")).toBe(true);
      expect(controller.phase).toEqual(running(tool));
      await sleep(50);
      expect(completions.requests).toHaveLength(1);
      controller.handle("cancel");
      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      kept.resolve(101);
      await sleep(50);

      expect(pastes).toEqual([]);
      expect(history.entries).toEqual([]);
      expect(controller.phase.kind).toBe("listening");
      controller.handle("cancel");
    });

    /** A double tap while agent mode is still writing starts nothing (the phase is `running`), so the
     * second press's release finds nothing listening hands-free: the controller says so, and the
     * agent's text is still pasted. */
    test("a double tap while agent mode writes leaves nothing hands-free", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("We ship on Friday."));
      const pasting = deferred<void>();
      const reached = deferred<void>();
      const pastes: string[] = [];
      const { controller } = makeController({
        capture: new CountingCapture(true),
        paste: async (text) => {
          reached.resolve();
          await pasting.promise;
          pastes.push(text);
        },
      });
      controller.captureContext = async () => selectionScreen("");
      let nothingListening = 0;
      controller.onNothingListening = () => {
        nothingListening += 1;
      };

      await holdAndRelease(controller, "agent");
      await reached.promise;
      expect(controller.phase).toEqual(running("compose"));
      controller.handle("start");
      controller.handle("finish");
      controller.handle("startHandsFree");
      controller.handle("listenHandsFree");

      expect(nothingListening).toBe(1);
      expect(controller.phase).toEqual(running("compose"));
      pasting.resolve();
      expect(await eventually(() => pastes.length === 1 && controller.phase.kind === "idle")).toBe(true);
    });

    /** The app that counts is the one in front at key-down: a switch made while the request is still
     * being transcribed is caught too. */
    test("agent text is not pasted after a switch during the transcription", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("We ship on Friday."));
      transcription.gate = async () => {
        front.pid = 202;
      };

      const { controller, pastes, phases } = await carryOut(selectionScreen(""));

      expect(phases).toContainEqual(running("compose"));
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(copied);
    });

    /** The app that counts is the one in front at key-down, not at release: a switch made while the
     * key is still held is caught too. */
    test("agent text is not pasted after a switch during the hold", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("We ship on Friday."));
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.captureContext = async () => selectionScreen("");

      controller.handle("start");
      controller.handle("toggleMode");
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      front.pid = 202;
      controller.handle("finish");

      expect(await eventually(() => controller.phase.kind === "copied")).toBe(true);
      expect(controller.phase).toEqual(copied);
      expect(completions.requests).toHaveLength(1);
      expect(pastes).toEqual([]);
    });

    /** Each hold counts the app in front at its own key-down: after one request done in one app, the
     * next, made in another, is pasted there. */
    test("each hold takes the app in front at its key-down", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("We ship on Friday."));
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("We ship on Monday."));
      const { controller, pastes } = await carryOut(selectionScreen(""));
      expect(pastes).toEqual(["We ship on Friday."]);

      front.pid = 202;
      await holdAndRelease(controller, "agent");

      expect(await eventually(() => pastes.length === 2 || controller.phase.kind === "failed")).toBe(true);
      expect(pastes).toEqual(["We ship on Friday.", "We ship on Monday."]);
    });

    /** Settings are read once, as a hold starts: changing the server, the email app, screen reading
     * and the user's name while it runs changes nothing for it, and the change applies from the next
     * hold. */
    test("settings changed during a hold apply from the next one", async () => {
      const thunderbird = new FakeThunderbird();
      let reads = 0;
      transcription.enqueue(200, { text: "find sam's invoice" });
      completions.enqueue(200, reply("thunderbird"));
      completions.enqueue(200, reply("Find the invoice Sam sent."));

      const { controller } = await carryOut(selectionScreen(""), thunderbird, (controller) => {
        controller.onPhaseChange = (phase) => {
          if (phase.kind !== "listening") return;
          prefs.value = { hasConsented: true, hotkey: "rightOption", backendURL: "https://dev.example.com", readsScreen: false, enabledTools: toolsWithoutAnswer, enabledConnectors: [...connectorIDs], emailClient: "org.example.othermail", hasTabMail: true, userName: "Sam Example", dictionary: ["Xyvora"], learnsWords: false, excludedApps: [], excludedSites: [] };
        };
        const read = controller.captureContext;
        controller.captureContext = (exclusions) => {
          reads += 1;
          return read?.(exclusions) ?? null;
        };
      });

      expect(thunderbird.pasted).toEqual(["Find the invoice Sam sent."]);
      expect(thunderbird.apps).toEqual([FakeThunderbird.app]);
      expect(new Set([...hosts(transcription), ...hosts(completions)])).toEqual(new Set(["api.example.com"]));
      expect(reads).toBe(1);
      expect(completionsVars(1)?.user_name).toBe("Alex Example");
      expect(transcription.body(0).vocabulary).toBeUndefined();

      controller.onPhaseChange = undefined;
      transcription.enqueue(200, { text: "find sam's receipt" });
      completions.enqueue(200, reply("thunderbird"));
      completions.enqueue(200, reply("Find the receipt Sam sent."));
      await holdAndRelease(controller, "agent");

      expect(await eventually(() => thunderbird.pasted.length === 2)).toBe(true);
      expect(thunderbird.apps).toEqual([FakeThunderbird.app, "org.example.othermail"]);
      expect([...hosts(transcription), ...hosts(completions)].filter((host) => host === "dev.example.com")).toHaveLength(3);
      expect(reads).toBe(1);
      expect(completionsVars(3)?.user_name).toBe("Sam Example");
      expect(transcription.body(1).vocabulary).toEqual(["Xyvora"]);
    });

    /** The bubbles show the tools switched on at key-down, the ones the request is offered: a tool
     * switched off during the hold stays until the next. */
    test("the bubbles keep the tools switched on at key-down", async () => {
      const thunderbird = new FakeThunderbird();
      const shown: AgentToolID[][] = [];
      transcription.enqueue(200, { text: "find sam's invoice" });
      completions.enqueue(200, reply("thunderbird"));
      completions.enqueue(200, reply("Find the invoice Sam sent."));

      await carryOut(selectionScreen(""), thunderbird, (controller) => {
        controller.onPhaseChange = (phase) => {
          if (phase.kind !== "listening") return;
          shown.push(controller.tools);
          prefs.value = { ...prefs.value, enabledTools: ["edit"] };
          // Switching mode and back redraws the bubbles.
          controller.toggleMode();
          controller.toggleMode();
          shown.push(controller.tools);
        };
      });

      expect(shown).toEqual([
        ["compose", "thunderbird"],
        ["compose", "thunderbird"],
      ]);
      expect(thunderbird.pasted).toEqual(["Find the invoice Sam sent."]);
    });

    /** A hold is transcribed in the keyboard's language at its key-down, which the overlay shows from
     * the reveal on: switching the keyboard while the hold listens or while its recording uploads
     * changes neither, the next hold takes the new keyboard's, and a keyboard with none sends none. In
     * both modes. */
    test.each<DictationMode>(["dictation", "agent"])("each hold is transcribed in the keyboard language at its key-down (%s)", async (mode) => {
      keyboard.language = "ko";
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.captureContext = () => null;
      controller.onPhaseChange = (phase) => {
        if (phase.kind !== "listening") return;
        keyboard.atReveal.push(controller.language);
        keyboard.language = keyboard.language === "ko" ? "en" : "ko";
      };
      for (const [words, written] of [["first words", "First words."], ["second words", "Second words."], ["third words", "Third words."]] as const) {
        // A dictation's cleanup comes back with its transcription; agent mode's text from its tool.
        if (mode === "dictation") {
          transcription.enqueue(200, { text: words, cleaned_text: written });
        } else {
          transcription.enqueue(200, { text: words });
          completions.enqueue(200, reply(written));
        }
      }
      transcription.gate = async () => {
        keyboard.language = "ja";
      };

      await holdAndRelease(controller, mode);
      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length === 1)).toBe(true);
      expect(keyboard.atReveal).toEqual(["ko"]);
      expect(controller.language).toBe("ko");
      expect(transcriptionLanguages()).toEqual(["ko"]);

      transcription.gate = undefined;
      await holdAndRelease(controller, mode);
      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length === 2)).toBe(true);
      expect(keyboard.atReveal).toEqual(["ko", "ja"]);
      expect(transcriptionLanguages()).toEqual(["ko", "ja"]);

      // A keyboard without a language after one with: none, not the last hold's.
      keyboard.language = null;
      await holdAndRelease(controller, mode);
      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length === 3)).toBe(true);
      expect(keyboard.atReveal).toEqual(["ko", "ja", null]);
      expect(controller.language).toBeNull();
      expect(transcriptionLanguages()).toEqual(["ko", "ja", null]);
      expect(Object.keys(transcription.body(2)).sort()).toEqual(mode === "dictation" ? ["audio", "cleanup", "format"] : ["audio", "format"]);
      expect(pastes).toEqual(["First words.", "Second words.", "Third words."]);
    });

    /** An ordinary dictation's request uses its key-down server; the next hold uses the new one. */
    test("an ordinary dictation keeps its server until the next hold", async () => {
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      transcription.enqueue(200, cleanedReply);
      transcription.gate = async () => {
        prefs.value = { ...prefs.value, backendURL: "https://dev.example.com" };
      };

      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length === 1)).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(hosts(transcription)).toEqual(["api.example.com"]);

      transcription.gate = undefined;
      transcription.enqueue(200, { text: "next dictated words", cleaned_text: "Next dictated words." });
      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length === 2)).toBe(true);
      expect(pastes).toEqual([cleaned, "Next dictated words."]);
      expect(hosts(transcription)).toEqual(["api.example.com", "dev.example.com"]);
      // The cleanup is in the transcription request: no request of its own, to either server.
      expect(completions.requests).toHaveLength(0);
    });

    /** Space offers the email app Settings named at key-down, not the one it names by the time Space is
     * pressed: the bubble shown is the app the request would go to. */
    test.each<[string | null, string | null]>([
      [FakeThunderbird.app, null],
      [null, FakeThunderbird.app],
    ])("Space offers the email app of the hold's key-down (%s, then %s)", async (atKeyDown, changedTo) => {
      prefs.value = { ...prefs.value, emailClient: atKeyDown };
      const { controller } = makeController({ capture: new CountingCapture(true), thunderbird: new FakeThunderbird() });
      controller.captureContext = async () => selectionScreen("");

      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      prefs.value = { ...prefs.value, emailClient: changedTo };
      controller.handle("toggleMode");

      const offered: AgentToolID[] = atKeyDown === null ? ["compose"] : ["compose", "thunderbird"];
      expect(await eventually(() => JSON.stringify(controller.tools) === JSON.stringify(offered))).toBe(true);
      expect(controller.emailAppPath).toBe(atKeyDown === null ? null : FakeThunderbird.path);
      controller.handle("cancel");
      expect(await eventually(() => controller.phase.kind === "idle")).toBe(true);
    });

    /** Thunderbird comes to the front to take the chat message: that is no reason to drop it. */
    test("a mail request is sent whatever app is in front", async () => {
      transcription.enqueue(200, { text: "find sam's invoice" });
      completions.enqueue(200, reply("thunderbird"));
      completions.enqueue(200, reply("Find the invoice Sam sent."));
      completions.gate = async () => {
        front.pid = 202;
      };
      const thunderbird = new FakeThunderbird();

      const { controller, pastes } = await carryOut(selectionScreen(""), thunderbird);

      expect(thunderbird.pasted).toEqual(["Find the invoice Sam sent."]);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(idle);
    });

    /** While a request runs, the hotkey neither starts another dictation nor switches its mode: the
     * request carries on and its text is pasted. */
    test("a running request ignores the hotkey", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("We ship on Friday."));
      const seen: { phase: Phase; mode: DictationMode }[] = [];

      const { controller, pastes } = await carryOut(selectionScreen(""), undefined, (controller) => {
        completions.gate = async () => {
          controller.handle("start");
          controller.handle("toggleMode");
          seen.push({ phase: controller.phase, mode: controller.mode });
        };
      });

      expect(seen).toEqual([{ phase: running("compose"), mode: "agent" }]);
      expect(pastes).toEqual(["We ship on Friday."]);
      expect(controller.phase).toEqual(idle);
    });

    /** Canceled while the tool writes: nothing is pasted, then or when the text arrives. */
    test("a request canceled while running pastes nothing", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("We ship on Friday."));
      const seen: Phase[] = [];

      const { controller, pastes } = await carryOut(selectionScreen(""), undefined, (controller) => {
        completions.gate = async () => {
          seen.push(controller.phase);
          controller.handle("cancel");
        };
      });
      // The reply still arrives after the cancel.
      await sleep(300);

      expect(seen).toEqual([running("compose")]);
      expect(completions.requests).toHaveLength(1);
      // The request itself is canceled, not just its reply ignored: it stops at once, and one not
      // yet sent (behind a sign-in refresh) never goes.
      expect(completions.requests[0]?.signal?.aborted).toBe(true);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(idle);
    });

    /** Space switches nothing once the hold is over: not while transcribing, nor after a failure. */
    test("Space switches nothing after the hold", async () => {
      transcription.enqueue(200, cleanedReply);
      transcription.enqueue(200, { text: "  " });
      const { controller, pastes } = makeController({ capture: new CountingCapture(true), thunderbird: new FakeThunderbird() });
      controller.captureContext = async () => selectionScreen("");
      const seen: { phase: Phase; mode: DictationMode }[] = [];
      transcription.gate = async () => {
        controller.handle("toggleMode");
        seen.push({ phase: controller.phase, mode: controller.mode });
      };

      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length > 0)).toBe(true);
      expect(seen).toEqual([{ phase: transcribing, mode: "dictation" }]);
      expect(pastes).toEqual([cleaned]);
      // Still a dictation: cleaned up in the transcription request, no agent request.
      expect(cleanupVars(0)).toBeDefined();
      expect(completions.requests).toHaveLength(0);

      transcription.gate = undefined;
      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "failed")).toBe(true);
      expect(controller.phase).toEqual(failed(nothingHeardMessage));
      controller.handle("toggleMode");
      expect(controller.mode).toBe("dictation");
      expect(controller.tools).toEqual([]);
      expect(controller.emailAppPath).toBeNull();
    });

    /** A canceled hold's screen read that finishes during the next hold does not change the tools that
     * hold offers: its selection is of a screen the user has left. */
    test("a superseded screen read leaves the tools alone", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      const first = deferred<ScreenContext | null>();
      controller.captureContext = () => first.promise;
      controller.handle("start");
      controller.handle("toggleMode");
      expect(controller.tools).toEqual([]);
      controller.handle("cancel");

      controller.captureContext = async () => selectionScreen("");
      controller.handle("start");
      controller.handle("toggleMode");
      expect(await eventually(() => controller.tools.length === 1 && controller.tools[0] === "compose")).toBe(true);
      first.resolve(selectionScreen("Ship it Friday or else."));
      await sleep(200);

      expect(controller.tools).toEqual(["compose"]);
      controller.handle("cancel");
    });

    /** A dictation after agent mode is a dictation again: cleaned up and pasted. */
    test("a hold after agent mode dictates again", async () => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("We ship on Friday."));
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = await carryOut(null);

      await holdAndRelease(controller);
      expect(await eventually(() => pastes.length === 2)).toBe(true);

      expect(controller.mode).toBe("dictation");
      expect(controller.tools).toEqual([]);
      expect(pastes).toEqual(["We ship on Friday.", cleaned]);
      // Agent mode's transcription asks for no cleanup; the dictation after it does.
      expect(cleanupVars(0)).toBeUndefined();
      expect(cleanupVars(1)).toBeDefined();
      expect(completions.requests).toHaveLength(1);
    });
    describe("the chat window", () => {
      const question = "what does this error mean";
      const answer = "It means the function is not defined yet.";
      /** Chats left open by a test, closed after it so no timeout outlives it. */
      const opened: DictationController[] = [];

      afterEach(() => {
        for (const controller of opened.splice(0)) controller.closeChat();
      });

      /** Every agent tool on, as they are by default. */
      function allToolsOn(): void {
        prefs.value = { ...prefs.value, enabledTools: [...agentToolIDs] };
      }

      function setTools(tools: AgentToolID[]): void {
        prefs.value = { ...prefs.value, enabledTools: tools };
      }

      /** Queues a request the agent gives `tool`, which writes `text`. */
      function queue(spoken: string, tool: AgentToolID, text: string): void {
        transcription.enqueue(200, { text: spoken });
        completions.enqueue(200, reply(tool));
        completions.enqueue(200, reply(text));
      }

      /** Asks `question` with nothing selected, which the agent answers: the chat window opens. With no
       * email app, the agent is offered Compose and Answer. */
      async function openChat(
        prepare: (controller: DictationController) => void = () => {},
        thunderbird?: FakeThunderbird,
        options: Parameters<typeof carryOut>[3] = {},
      ): Promise<{ controller: DictationController; pastes: string[]; chatChanges: boolean[] }> {
        allToolsOn();
        queue(question, "answer", answer);
        const chatChanges: boolean[] = [];
        const { controller, pastes } = await carryOut(
          selectionScreen(""),
          thunderbird,
          (controller) => {
            controller.onChatChange = (isOpen) => chatChanges.push(isOpen);
            prepare(controller);
          },
          options,
        );
        opened.push(controller);
        return { controller, pastes, chatChanges };
      }

      /** A follow-up: a hold of the hotkey with the chat window open, and no Space. */
      async function followUp(controller: DictationController): Promise<void> {
        controller.handle("start");
        expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
        controller.handle("finish");
        expect(await eventually(() => settled(controller))).toBe(true);
      }

      /** An answer is shown in the chat window, not pasted, and the window closes on its own unless
       * touched. */
      test("an answer opens the chat window", async () => {
        const { controller, pastes, chatChanges } = await openChat();

        expect(pastes).toEqual([]);
        expect(controller.phase).toEqual(idle);
        expect(controller.chat?.turns).toEqual([{ id: 0, request: question, tool: "answer", reply: answer }]);
        expect(controller.chat?.closesAt).not.toBeNull();
        expect(chatChanges).toEqual([true]);
        expect(completions.requests).toHaveLength(2);
        expect(completions.body(0).available_tools).toEqual(["compose", "answer"]);
        expect(completionsVars(0)?.conversation).toBe("");
        expect(completionsVars(1)?.content).toBe("system_prompt_desktop_answer");
        expect(completionsVars(1)?.user_request).toBe(question);
        // The user's name goes with the tool's request, not with the choice of tool.
        expect(completionsVars(0)?.user_name).toBeUndefined();
        expect(completionsVars(1)?.user_name).toBe("Alex Example");
      });

      /** The answer goes with the name set at key-down: a name changed while the hold runs applies
       * from the next request, here the follow-up. */
      test("an answer carries the name set at key-down", async () => {
        const { controller } = await openChat((controller) => {
          controller.onPhaseChange = (phase) => {
            if (phase.kind === "listening") prefs.value = { ...prefs.value, userName: "Sam Example" };
          };
        });
        expect(completionsVars(1)?.content).toBe("system_prompt_desktop_answer");
        expect(completionsVars(1)?.user_name).toBe("Alex Example");

        controller.onPhaseChange = undefined;
        queue("and how do I fix it", "answer", "Define it before the call.");
        await followUp(controller);
        expect(completionsVars(3)?.content).toBe("system_prompt_desktop_answer");
        expect(completionsVars(3)?.user_name).toBe("Sam Example");
      });

      /** With the chat window open, the hotkey asks a follow-up: always in agent mode (Space switches
       * nothing), carrying the conversation so far, and it keeps the window open for good. */
      test("a follow-up carries the conversation in agent mode", async () => {
        const { controller } = await openChat();
        queue("and how do I fix it", "answer", "Define it before the call.");

        controller.handle("start");
        expect(controller.mode).toBe("agent");
        expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
        controller.handle("toggleMode");
        expect(controller.mode).toBe("agent");
        expect(controller.chat?.closesAt).toBeNull();
        controller.handle("finish");
        expect(await eventually(() => controller.phase.kind === "idle" && controller.chat?.turns.length === 2)).toBe(true);

        const conversation = `User: ${question}\nTabMail: ${answer}`;
        expect(completionsVars(2)?.conversation).toBe(conversation);
        expect(completionsVars(2)?.user_request).toBe("and how do I fix it");
        expect(completionsVars(3)?.conversation).toBe(conversation);
        expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual([answer, "Define it before the call."]);
        expect(controller.chat?.closesAt).toBeNull();
      });

      /** A follow-up another tool carries out is listed in the chat with what it did, so a later
       * follow-up can refer to it. */
      test("a follow-up's other tool is listed in the chat", async () => {
        const { controller, pastes } = await openChat();
        queue("write the fix here", "compose", "Define it first.");

        await followUp(controller);

        expect(pastes).toEqual(["Define it first."]);
        expect(controller.chat?.turns.map((turn) => turn.tool)).toEqual(["answer", "compose"]);
        expect(chatTranscript(controller.chat ?? emptyChat)).toMatch(/User: write the fix here\nTabMail \[Pasted at the cursor\]: Define it first\.$/);
      });

      /** A follow-up can hand the email app a request, which gets exactly the words the chat lists and
       * pastes nothing in the app in front. */
      test("a follow-up offers the email app", async () => {
        const thunderbird = new FakeThunderbird();
        const { controller, pastes } = await openChat(() => {}, thunderbird);
        expect(controller.chat).not.toBeNull();
        queue("find the invoice from last week", "thunderbird", "Find the invoice from last week.");

        await followUp(controller);

        expect(controller.tools).toContain("thunderbird");
        expect(completions.requests).toHaveLength(4);
        expect(completions.body(2).available_tools).toContain("thunderbird");
        expect(controller.chat?.turns.map((turn) => turn.tool)).toEqual(["answer", "thunderbird"]);
        expect(controller.chat?.turns.at(-1)?.reply).toBe("Find the invoice from last week.");
        expect(thunderbird.pasted).toEqual(["Find the invoice from last week."]);
        expect(pastes).toEqual([]);
      });

      /** While a follow-up is under way its words show in the chat as a pending request; once it is
       * answered they are a turn, and no longer pending. */
      test("a follow-up shows as pending until answered", async () => {
        const { controller } = await openChat();
        queue("and how do I fix it", "answer", "Define it before the call.");
        const pending: (string | null | undefined)[] = [];
        completions.gate = async () => {
          pending.push(controller.chat?.pendingRequest);
        };

        await followUp(controller);

        expect(pending[0]).toBe("and how do I fix it");
        expect(controller.chat?.pendingRequest).toBeNull();
        expect(controller.chat?.turns.map((turn) => turn.request)).toEqual([question, "and how do I fix it"]);
      });

      /** A follow-up no tool can carry out fails in the pill: the chat stays open, with its turns as
       * they were and nothing left pending. */
      test("a failed follow-up leaves the chat as it was", async () => {
        const { controller, pastes } = await openChat();
        transcription.enqueue(200, { text: "make it shorter" });
        completions.enqueue(200, reply("rewrite"));

        await followUp(controller);

        expect(controller.phase).toEqual(failed(new AgentError("noTool").message));
        expect(controller.chat?.turns.map((turn) => turn.request)).toEqual([question]);
        expect(controller.chat?.pendingRequest).toBeNull();
        expect(pastes).toEqual([]);
      });

      /** Closing the chat window while a follow-up's failure shows ends that too: the pill would show
       * it where the conversation started. */
      test("closing the chat window ends a failure showing", async () => {
        const { controller } = await openChat();
        transcription.enqueue(200, { text: "make it shorter" });
        completions.enqueue(200, reply("rewrite"));
        await followUp(controller);
        expect(controller.phase.kind).toBe("failed");

        controller.handle("closeChat");

        expect(controller.chat).toBeNull();
        expect(controller.phase).toEqual(idle);
      });

      /** The timeout closing the chat window while a refused hold's failure shows ends that too. */
      test("the timeout ends a failure showing as it closes the chat window", async () => {
        const { controller } = await openChat((controller) => {
          controller.chatTimeout = 300;
        });
        prefs.value = { ...prefs.value, hasConsented: false };
        controller.handle("start");
        expect(controller.phase.kind).toBe("failed");

        expect(await eventually(() => controller.chat === null)).toBe(true);
        expect(controller.phase).toEqual(idle);
      });

      /** A touch that arrives after the chat window closed (a pointer event behind the close) opens
       * nothing. */
      test("a touch after the chat window closed opens nothing", async () => {
        const { controller, chatChanges } = await openChat();
        controller.handle("closeChat");

        controller.keepChatOpen();

        expect(controller.chat).toBeNull();
        expect(chatChanges).toEqual([true, false]);
        controller.handle("start");
        expect(controller.mode).toBe("dictation");
        controller.handle("cancel");
      });

      /** A follow-up shows no tip: Space switches nothing in it, and it is no hold to teach a double tap
       * for. */
      test("a follow-up shows no tip", async () => {
        const { controller } = await openChat((controller) => {
          controller.tipDisplayDuration = () => 60_000;
        });
        controller.doubleTapTipHoldDuration = 100;
        expect(new TipBook(tipStore).isEligible("doubleTap")).toBe(true);

        controller.handle("start");
        expect(await eventually(() => controller.phase.kind === "listening" && controller.isHearing)).toBe(true);
        expect(await throughout(500, () => controller.tip === null)).toBe(true);
        controller.handle("cancel");
      });

      /** Untouched, the chat window closes when its timeout runs out, and the next hold dictates again. */
      test("the chat window closes when its timeout runs out", async () => {
        const { controller, chatChanges } = await openChat((controller) => {
          controller.chatTimeout = 100;
        });

        expect(await eventually(() => controller.chat === null)).toBe(true);
        expect(chatChanges).toEqual([true, false]);
        controller.handle("start");
        expect(controller.mode).toBe("dictation");
        controller.handle("cancel");
      });

      /** Touched (a hover, click or scroll), the chat window no longer times out. */
      test("touching the chat window keeps it open", async () => {
        const { controller } = await openChat((controller) => {
          controller.chatTimeout = 100;
        });

        controller.keepChatOpen();

        expect(controller.chat?.closesAt).toBeNull();
        expect(await throughout(400, () => controller.chat !== null)).toBe(true);
      });

      /** A closed chat's timeout never closes the next one: a chat reopened and touched stays open past
       * the first one's deadline. */
      test("an earlier chat's timeout never closes a later one", async () => {
        const timeout = 1_500;
        const { controller } = await openChat((controller) => {
          controller.chatTimeout = timeout;
        });
        const firstDeadline = Date.now() + timeout;
        controller.handle("closeChat");
        expect(controller.chat).toBeNull();
        queue(question, "answer", answer);

        await holdAndRelease(controller, "agent");
        expect(await eventually(() => controller.chat !== null)).toBe(true);
        controller.keepChatOpen();

        // The later chat is open before the first one's deadline, and stays open past it.
        expect(Date.now()).toBeLessThan(firstDeadline);
        expect(await throughout(firstDeadline - Date.now() + 500, () => controller.chat !== null)).toBe(true);
      });

      /** Escape or the close button: the conversation is gone, and a follow-up under way is dropped
       * without its reply being shown, pasted or asked about further. */
      test("closing the chat window drops the follow-up under way", async () => {
        const { controller, pastes, chatChanges } = await openChat();
        queue("and how do I fix it", "answer", "Define it before the call.");
        completions.gate = async () => {
          controller.handle("closeChat");
        };

        await followUp(controller);
        // The reply still arrives after the close.
        await sleep(300);

        expect(controller.chat).toBeNull();
        expect(chatChanges).toEqual([true, false]);
        expect(controller.phase).toEqual(idle);
        expect(completions.requests).toHaveLength(3);
        expect(pastes).toEqual([]);
      });

      /** Closing the chat window while the follow-up is still heard stops the recording, and sends
       * nothing. */
      test("closing the chat window while listening sends nothing", async () => {
        const { controller } = await openChat();

        controller.handle("start");
        expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
        controller.handle("closeChat");

        expect(controller.chat).toBeNull();
        expect(controller.phase).toEqual(idle);
        await sleep(100);
        expect(transcription.requests).toHaveLength(1);
      });

      /** Closed while the follow-up's answer is written: the answer never opens the window again. */
      test("a closed chat is not reopened by its last answer", async () => {
        const { controller } = await openChat();
        queue("follow up", "answer", "late answer");
        let closedAtAnswer = false;
        completions.gate = async () => {
          if (completions.requests.length !== 4) return;
          closedAtAnswer = true;
          controller.closeChat();
        };

        await followUp(controller);
        await sleep(200);

        expect(closedAtAnswer).toBe(true);
        expect(controller.chat).toBeNull();
        expect(controller.phase).toEqual(idle);
      });

      /** Closed while the follow-up's answer waits on the app in front: the answer opens no chat. */
      test("an answer that outlives its closed chat opens none", async () => {
        const answering = deferred<void>();
        const { controller } = await openChat(() => {});
        queue("and how do I fix it", "answer", "Define it before the call.");
        // The follow-up's answer is held back until the chat has closed.
        completions.gate = () => (completions.requests.length === 4 ? answering.promise : Promise.resolve());
        controller.handle("start");
        expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
        controller.handle("finish");
        expect(await eventually(() => completions.requests.length === 4 && controller.phase.kind === "running")).toBe(true);
        await sleep(100);

        controller.closeChat();
        answering.resolve();
        await sleep(200);

        expect(controller.chat).toBeNull();
        expect(controller.phase).toEqual(idle);
      });

      /** A follow-up offers its tools from the moment it listens, as a hold switched to agent mode
       * does: the bubbles need not wait for the transcript. */
      test("a follow-up's tools are known while it listens", async () => {
        const { controller } = await openChat(() => {}, new FakeThunderbird());

        controller.handle("start");
        expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);

        expect(await eventually(() => controller.tools.length === 3)).toBe(true);
        expect(controller.tools).toEqual(["compose", "thunderbird", "answer"]);
        controller.handle("cancel");
      });

      /** A follow-up pasting when its window closed, and a new conversation opened, stays out of it. */
      test("a late delivery cannot join a newer conversation", async () => {
        const delivery = deferred<void>();
        let pasteReached = false;
        const { controller } = await openChat(() => {}, undefined, {
          paste: async () => {
            pasteReached = true;
            await delivery.promise;
          },
        });
        queue("old follow up", "compose", "old pasted words");
        controller.handle("start");
        expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
        controller.handle("finish");
        expect(await eventually(() => pasteReached)).toBe(true);
        expect(controller.phase).toEqual(running("compose"));
        controller.closeChat();
        queue("new conversation", "answer", "new reply");
        await holdAndRelease(controller, "agent");
        expect(await eventually(() => settled(controller))).toBe(true);
        expect(controller.chat?.turns.map((turn) => turn.request)).toEqual(["new conversation"]);

        delivery.resolve();
        await sleep(200);

        expect(controller.chat?.turns.map((turn) => turn.request)).toEqual(["new conversation"]);
        expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual(["new reply"]);
        expect(controller.phase).toEqual(idle);
      });

      /** Signing out ends the conversation: another account that signs in next starts afresh, and none
       * of the first account's words go with its requests. */
      test("signing out ends the conversation before the next account", async () => {
        const account = signedIn(auth);
        const { controller } = await openChat(() => {}, undefined, { account });

        account.signOut();

        expect(controller.chat).toBeNull();
        auth.enqueue(200, Fixtures.sessionJSON({ access: "access-b", refresh: "refresh-b", userID: "user-2" }));
        await account.verify(Fixtures.email, "123456");
        queue("second account question", "answer", "second account reply");
        await holdAndRelease(controller, "agent");
        expect(await eventually(() => settled(controller) && completions.requests.length === 4)).toBe(true);
        expect(completions.authorizations[2]).toBe("Bearer access-b");
        expect(completionsVars(2)?.conversation).toBe("");
        expect(completionsVars(3)?.conversation).toBe("");
        expect(controller.chat?.turns.map((turn) => turn.request)).toEqual(["second account question"]);
      });

      /** Signed out while the answer is written: it never opens a chat window. */
      test("signing out during an answer opens no chat", async () => {
        const account = signedIn(auth);
        completions.gate = async () => {
          if (completions.requests.length === 2) account.signOut();
        };

        const { controller } = await openChat(() => {}, undefined, { account });
        await sleep(100);

        expect(completions.requests).toHaveLength(2);
        expect(account.session).toBeNull();
        expect(controller.chat).toBeNull();
        expect(controller.phase).toEqual(idle);
      });

      /** A refreshed token for the same account keeps the conversation. */
      test("a refreshed token keeps the conversation", async () => {
        const account = signedIn(auth);
        const { controller } = await openChat(() => {}, undefined, { account });
        auth.enqueue(200, Fixtures.sessionJSON({ access: "access-2", refresh: "refresh-2" }));

        expect(await account.validToken(true)).toBe("access-2");

        expect(controller.chat?.turns.map((turn) => turn.request)).toEqual([question]);
      });

      /** With every agent tool turned off in Settings, agent mode says so, and asks the backend
       * nothing. */
      test("with no tool enabled agent mode says so", async () => {
        setTools([]);
        transcription.enqueue(200, { text: request });

        const { controller, pastes } = await carryOut(selectionScreen(""));

        expect(controller.phase).toEqual(failed(new AgentError("noToolEnabled").message));
        expect(controller.tools).toEqual([]);
        expect(completions.requests).toHaveLength(0);
        expect(pastes).toEqual([]);
      });

      /** A question asked on a screen that is read, then one after moving to a screen hidden for
       * privacy: the second is told the screen is hidden, with nothing of the first screen but what
       * the conversation holds. */
      test("an answer asked on a hidden screen after a shown one is told the screen is hidden", async () => {
        setTools(["answer"]);
        transcription.enqueue(200, { text: "first question" });
        completions.enqueue(200, reply("first answer"));
        const { controller } = makeController({ capture: new CountingCapture(true) });
        opened.push(controller);
        let read: ScreenRead = screen("A");
        controller.captureContext = async () => read;

        await holdAndRelease(controller, "agent");
        expect(await eventually(() => settled(controller) && controller.chat?.turns.length === 1)).toBe(true);
        read = { hidden: true };
        transcription.enqueue(200, { text: "next question" });
        completions.enqueue(200, reply("next answer"));
        await holdAndRelease(controller, "agent");
        expect(await eventually(() => settled(controller) && controller.chat?.turns.length === 2)).toBe(true);

        expect(completionsVars(0)?.screen_text).toBe("» Agenda A ‸");
        expect(completionsVars(1)?.screen_text).toBe(screenHiddenNote);
        expect(completionsVars(1)?.app_name).toBe("");
        expect(completionsVars(1)?.window_title).toBe("");
        expect(String(completionsVars(1)?.conversation)).toContain("first answer");
      });

      /** Tools switched off while the user speaks still apply to that request; the next request reads
       * the change. */
      test("a tool switched off after key-down applies from the next request", async () => {
        setTools(["answer"]);
        transcription.enqueue(200, { text: "first question" });
        completions.enqueue(200, reply("first answer"));
        const { controller } = makeController({ capture: new CountingCapture(true) });
        opened.push(controller);
        controller.captureContext = async () => selectionScreen("");

        controller.handle("start");
        controller.handle("toggleMode");
        expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
        setTools([]);
        controller.handle("finish");
        expect(await eventually(() => settled(controller))).toBe(true);

        expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual(["first answer"]);
        transcription.enqueue(200, { text: "next question" });
        await holdAndRelease(controller, "agent");
        expect(await eventually(() => controller.phase.kind === "failed")).toBe(true);
        expect(controller.phase).toEqual(failed(new AgentError("noToolEnabled").message));
        expect(completions.requests).toHaveLength(1);
      });

      /** A tool switched on after key-down waits for the next request. */
      test("a tool switched on after key-down waits for the next request", async () => {
        setTools([]);
        transcription.enqueue(200, { text: "first request" });
        let changed = false;
        transcription.gate = async () => {
          changed = true;
          setTools(["answer"]);
        };

        const { controller } = await carryOut(selectionScreen(""));
        opened.push(controller);

        expect(changed).toBe(true);
        expect(controller.phase).toEqual(failed(new AgentError("noToolEnabled").message));
        expect(completions.requests).toHaveLength(0);
        transcription.gate = undefined;
        transcription.enqueue(200, { text: "next request" });
        completions.enqueue(200, reply("next answer"));
        await holdAndRelease(controller, "agent");
        expect(await eventually(() => controller.chat !== null)).toBe(true);
        expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual(["next answer"]);
      });

      /** The only tool switched on does its own job unasked: Answer replies in the chat window, the
       * email app's tool sends to it; neither pastes in the app in front. */
      test.each<AgentToolID>(["answer", "thunderbird"])("the only tool on (%s) does its own job", async (tool) => {
        setTools([tool]);
        transcription.enqueue(200, { text: "the request" });
        completions.enqueue(200, reply("the reply"));
        const thunderbird = new FakeThunderbird();

        const { controller, pastes } = await carryOut(selectionScreen(""), thunderbird);
        opened.push(controller);

        expect(completions.requests).toHaveLength(1);
        expect(controller.phase).toEqual(idle);
        expect(completionsVars(0)?.content).toBe(tool === "answer" ? "system_prompt_desktop_answer" : "system_prompt_desktop_thunderbird");
        expect(pastes).toEqual([]);
        if (tool === "answer") {
          expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual(["the reply"]);
          expect(thunderbird.events).toEqual([]);
        } else {
          expect(controller.chat).toBeNull();
          expect(thunderbird.pasted).toEqual(["the reply"]);
        }
      });

      /** The tools the answer's model calls that run on this computer (ADR-DESK-023). */
      describe("the answer's tools", () => {
        const toolRequest = "add the launch review to my calendar";
        const confirmationQuestion = "Add “Launch review” to your calendar on Friday at 10:00?";

        /** A tool that runs on this computer, for the answer's loop: records the arguments of each run,
         * asks `question` first when set, and returns `result` (or throws `failure`). */
        class FakeLoopTool implements ConnectorTool {
          readonly runs: Record<string, unknown>[] = [];
          /** How many times it was asked for its question, and the arguments it was asked about. */
          asked = 0;
          readonly askedAbout: Record<string, unknown>[] = [];
          question: string | null = null;
          result = "Added.";
          /** What its run throws: an `Error`, or (as JavaScript allows) any other value. */
          failure: Error | string | null = null;
          /** Runs as the tool does, to look at the app while it runs. */
          during: () => Promise<void> = async () => {};

          constructor(
            readonly name = "example_create",
            readonly progressLabel = "Adding it to your calendar",
            readonly connector: ConnectorID = "calendar",
          ) {}

          confirmation(args: Record<string, unknown>): string | null {
            this.asked += 1;
            this.askedAbout.push(args);
            return this.question;
          }

          /** The signal each run was given. */
          readonly signals: AbortSignal[] = [];

          async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
            this.runs.push(args);
            this.signals.push(signal);
            await this.during();
            if (this.failure) throw this.failure;
            return this.result;
          }
        }

        /** A final event calling each of `calls` (name, arguments) in turn, and the loop's state. */
        function calling(...calls: [name: string, args: string][]): string {
          return Fixtures.toolCalls(calls.map(([name, args], index) => ({ id: `call_${index}`, name, arguments: args })));
        }

        /** What the model was told each call of the last round did: the tool messages the `index`th
         * request sent. */
        function told(index: number): string[] {
          const state = completions.body(index).conversation_state as { harmony_messages: { role: string; content: string }[] } | undefined;
          return (state?.harmony_messages ?? []).filter((message) => message.role === "tool").map((message) => message.content);
        }

        /** Agent mode asked `toolRequest` with only Answer on (so nothing to choose), the backend
         * answering each of `rounds` in turn, `tools` running on this computer. Returns once the
         * controller exists; `done` settles with the request. */
        async function ask(
          tools: ConnectorTool[],
          rounds: string[],
          prepare: (controller: DictationController) => void = () => {},
          options: Parameters<typeof carryOut>[3] = {},
        ): Promise<{ controller: DictationController; done: ReturnType<typeof carryOut>; chatChanges: boolean[] }> {
          setTools(["answer"]);
          transcription.enqueue(200, { text: toolRequest });
          for (const round of rounds) completions.enqueue(200, round);
          let made: DictationController | undefined;
          const chatChanges: boolean[] = [];
          const done = carryOut(
            selectionScreen(""),
            undefined,
            (controller) => {
              made = controller;
              controller.onChatChange = (isOpen) => chatChanges.push(isOpen);
              // Answered as soon as asked, unless a test waits out the question's minimum display.
              controller.confirmationMinimumDisplay = 0;
              prepare(controller);
            },
            { ...options, connectorTools: tools },
          );
          expect(await eventually(() => made !== undefined)).toBe(true);
          if (made === undefined) throw new Error("no controller");
          opened.push(made);
          return { controller: made, done, chatChanges };
        }

        /** A tool the answer's model calls runs, with the chat window open on the request and saying
         * what the tool is doing; its result goes back to the model, and the answer joins the chat,
         * which then times out unless touched. The Answer prompt is offered the date tools and this
         * computer's tools. */
        test("an answer's tool runs with the chat window showing it", async () => {
          const tool = new FakeLoopTool();
          const whileRunning: (AgentChat | null)[] = [];
          let controllerRef: DictationController | undefined;
          tool.during = async () => {
            whileRunning.push(controllerRef?.chat ?? null);
          };

          const { controller, done, chatChanges } = await ask([tool], [calling(["example_create", '{"title":"Launch review","day":"friday","hour":10.5,"note":null}']), reply(answer)], (controller) => {
            controllerRef = controller;
            controller.chatTimeout = 300;
          });
          const { pastes } = await done;

          expect(tool.runs).toEqual([{ title: "Launch review", day: "friday", hour: 10.5, note: null }]);
          expect(whileRunning).toEqual([{ ...emptyChat, pendingRequest: toolRequest, activity: "Adding it to your calendar" }]);
          expect(completions.body(0).available_tools).toEqual(["date_to_day", "time_delta", "confirmation_answer", "example_create"]);
          expect(completions.body(0).disable_tools).toBe(false);
          expect(told(1)).toEqual(["Added."]);
          expect(controller.chat?.turns).toEqual([{ id: 0, request: toolRequest, tool: "answer", reply: answer }]);
          expect(controller.chat?.activity).toBeNull();
          expect(controller.chat?.pendingRequest).toBeNull();
          expect(controller.chat?.closesAt).not.toBeNull();
          expect(pastes).toEqual([]);
          expect(chatChanges).toEqual([true]);
          expect(await eventually(() => controller.chat === null)).toBe(true);
        });

        /** The bubbles' history: the tool the agent chose, then the app whose tool runs, lead it, the
         * latest first; the app's bubble runs while its tool does, and while the backend's search runs
         * in the answer's round (the web's), for as long as it does. None runs once the request ends. */
        test("the tools that ran lead the bubbles, each app running while its tool does", async () => {
          const tool = new FakeLoopTool();
          let controllerRef: DictationController | undefined;
          const whileRunning: [string[], string[]][] = [];
          tool.during = async () => {
            whileRunning.push([controllerRef?.runningConnectors ?? [], controllerRef?.recentBubbles ?? []]);
          };
          // Heard as the round streams in: the web's search starting and ending, the date tool
          // (no app's) on its own.
          const search = (event: string) => `event: ${event}\ndata: {"tool_name":"search_web","display_label":"Searching the web: launch"}\n\n`;
          const round = search("tool_started") + 'event: tool_completed\ndata: {"tool_name":"date_to_day"}\n\n' + search("tool_completed") + reply(answer);
          const seen: [string[], string | null][] = [];
          const { controller, done } = await ask([tool], [calling(["example_create", "{}"]), round], (controller) => {
            controllerRef = controller;
            controller.observe(() => seen.push([controller.runningConnectors, controller.chat?.activity ?? null]));
          });
          await done;

          expect(whileRunning).toEqual([[["calendar"], ["calendar", "answer"]]]);
          // The web's bubble ran with the search, the chat saying what it did, and stopped with it.
          const searching = seen.findIndex(([running]) => running.includes("web"));
          expect(seen[searching]).toEqual([["web"], null]);
          expect(seen.slice(searching).find(([, activity]) => activity !== null)).toEqual([["web"], "Searching the web: launch"]);
          expect(seen.slice(searching).some(([running]) => running.length === 0)).toBe(true);
          expect(controller.recentBubbles).toEqual(["web", "calendar", "answer"]);
          expect(controller.runningConnectors).toEqual([]);
        });

        /** A search the backend ends mid-request stops its bubble and takes its label down then, not
         * when the request ends: the tool the model calls next runs alone, under its own label. (The
         * tool runs first too, to open the chat the label shows in.) */
        test("a finished search stops running before the next tool runs", async () => {
          const tool = new FakeLoopTool();
          let controllerRef: DictationController | undefined;
          const whileRunning: [string[], string | null][] = [];
          tool.during = async () => {
            whileRunning.push([controllerRef?.runningConnectors ?? [], controllerRef?.chat?.activity ?? null]);
          };
          const search = (event: string) => `event: ${event}\ndata: {"tool_name":"search_web","display_label":"Searching the web: launch"}\n\n`;
          const seen: [string[], string | null][] = [];
          const { controller, done } = await ask([tool], [calling(["example_create", "{}"]), search("tool_started") + search("tool_completed") + calling(["example_create", "{}"]), reply(answer)], (controller) => {
            controllerRef = controller;
            controller.observe(() => seen.push([controller.runningConnectors, controller.chat?.activity ?? null]));
          });
          await done;

          expect(whileRunning).toEqual([
            [["calendar"], "Adding it to your calendar"],
            [["calendar"], "Adding it to your calendar"],
          ]);
          // Between the search's end and the tool's second run: nothing running, and no label.
          const searched = seen.findIndex(([, activity]) => activity === "Searching the web: launch");
          const adding = seen.findIndex(([running], index) => index > searched && running.includes("calendar"));
          expect(searched).toBeGreaterThanOrEqual(0);
          expect(seen.slice(searched, adding)).toContainEqual([[], null]);
          expect(controller.recentBubbles).toEqual(["calendar", "web", "answer"]);
        });

        /** A request canceled while its tool runs leaves no app running, and one that ends meanwhile
         * doesn't touch the next request's. */
        test("a request canceled while its tool runs leaves no app running", async () => {
          const tool = new FakeLoopTool();
          const release = deferred<void>();
          tool.during = () => release.promise;
          const { controller, done } = await ask([tool], [calling(["example_create", "{}"]), reply(answer)]);
          expect(await eventually(() => controller.runningConnectors.includes("calendar"))).toBe(true);

          controller.cancel();
          expect(controller.runningConnectors).toEqual([]);
          release.resolve();
          await done;
          expect(controller.runningConnectors).toEqual([]);
          expect(controller.recentBubbles).toEqual(["calendar", "answer"]);
        });

        /** Only the tools of apps switched on at key-down are offered, and one of a switched-off app the
         * model calls anyway does not run: the model is told there is no such tool. A switch changed
         * during the request applies from the next. */
        test("a switched-off app's tools are neither offered nor run", async () => {
          const calendar = new FakeLoopTool("example_read", "Checking your calendar", "calendar");
          const reminders = new FakeLoopTool("example_add", "Adding the reminder", "reminders");

          const { done } = await ask([calendar, reminders], [calling(["example_add", "{}"], ["example_read", "{}"]), reply(answer)], (controller) => {
            prefs.value = { ...prefs.value, enabledConnectors: ["calendar"] };
            controller.onPhaseChange = (phase) => {
              if (phase.kind === "listening") prefs.value = { ...prefs.value, enabledConnectors: ["reminders"] };
            };
          });
          await done;

          expect(completions.body(0).available_tools).toEqual(["date_to_day", "time_delta", "confirmation_answer", "example_read"]);
          expect(completions.body(0).web_search_enabled).toBe(false);
          expect(reminders.runs).toEqual([]);
          expect(calendar.runs).toEqual([{}]);
          expect(told(1)).toEqual(["Error: there is no tool named example_add.", "Added."]);
        });

        /** Web on at key-down (the default) brings the backend's search with the web's tools, and the
         * request says so; switched off, neither, and the backend refuses the web. */
        test.each([true, false])("the web's search comes with its tools while Web is on (%s)", async (webOn) => {
          const calendar = new FakeLoopTool("example_read", "Checking your calendar", "calendar");
          const web = new FakeLoopTool("web_read", "Reading the page", "web");

          const { done } = await ask([calendar, web], [reply(answer)], () => {
            if (!webOn) prefs.value = { ...prefs.value, enabledConnectors: ["calendar"] };
          });
          await done;

          expect(completions.body(0).available_tools).toEqual(webOn ? ["date_to_day", "time_delta", "search_web", "confirmation_answer", "example_read", "web_read"] : ["date_to_day", "time_delta", "confirmation_answer", "example_read"]);
          expect(completions.body(0).web_search_enabled).toBe(webOn);
        });

        /** Touched while a tool runs, the chat window no longer times out once the answer arrives. */
        test("touching the chat window while a tool runs keeps it open", async () => {
          const tool = new FakeLoopTool();
          let controllerRef: DictationController | undefined;
          tool.during = async () => controllerRef?.keepChatOpen();

          const { controller, done } = await ask([tool], [calling(["example_create", "{}"]), reply(answer)], (controller) => {
            controllerRef = controller;
            controller.chatTimeout = 100;
          });
          await done;

          expect(controller.chat?.turns).toHaveLength(1);
          expect(controller.chat?.closesAt).toBeNull();
          expect(await throughout(400, () => controller.chat !== null)).toBe(true);
        });

        /** A tool that sends or creates asks first in the chat window, and runs only once confirmed; the
         * hotkey starts no new request meanwhile (a tap of it says nothing, and the question asks on). */
        test("a tool that creates runs once confirmed", async () => {
          const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
          const { controller, done } = await ask([tool], [calling(["example_create", '{"title":"Launch review"}']), reply(answer)]);
          expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
          expect(controller.chat?.pendingRequest).toBe(toolRequest);
          expect(controller.chat?.activity).toBeNull();
          controller.handle("start");
          controller.handle("finish");
          expect(controller.phase).toEqual(running("answer"));
          await sleep(50);
          expect(tool.runs).toEqual([]);
          expect(transcription.requests).toHaveLength(1);
          expect(completions.requests).toHaveLength(1);
          expect(controller.chat?.confirmation).toBe(confirmationQuestion);
          // The question is about the call the model made, the one that runs.
          expect(tool.askedAbout).toEqual([{ title: "Launch review" }]);

          controller.answerConfirmation(true);
          await done;

          expect(tool.runs).toEqual([{ title: "Launch review" }]);
          expect(told(1)).toEqual(["Added."]);
          expect(controller.chat?.confirmation).toBeNull();
          expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual([answer]);
        });

        /** Declined, the tool doesn't run; the model is told, and answers. */
        test("a declined tool does not run", async () => {
          const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
          const { controller, done } = await ask([tool], [calling(["example_create", '{"title":"Launch review"}']), reply("Nothing was added.")]);
          expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
          expect(tool.askedAbout).toEqual([{ title: "Launch review" }]);

          controller.answerConfirmation(false);
          await done;

          expect(tool.runs).toEqual([]);
          expect(told(1)).toEqual([config.connectorToolDeclined]);
          expect(controller.chat?.confirmation).toBeNull();
          expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual(["Nothing was added."]);
        });

        /** A question left unanswered for the time to answer is declined as unanswered: the tool doesn't
         * run and the model is told why. A touch in the window doesn't stop its clock. */
        test("a question left unanswered is declined when its time runs out", async () => {
          const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
          const { controller, done } = await ask([tool], [calling(["example_create", "{}"]), reply("Nothing was added.")], (controller) => {
            controller.confirmationTimeout = 300;
          });
          expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
          const left = (controller.chat?.confirmationExpiresAt ?? 0) - Date.now();
          expect(left).toBeGreaterThan(0);
          expect(left).toBeLessThanOrEqual(300);

          controller.keepChatOpen();
          // Declined when its time runs out, not later.
          await sleep(450);
          expect(controller.chat?.confirmation).toBeNull();
          await done;

          expect(tool.runs).toEqual([]);
          expect(told(1)).toEqual([config.connectorToolUnanswered]);
          expect(controller.chat?.confirmation).toBeNull();
          expect(controller.chat?.confirmationExpiresAt).toBeNull();
          expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual(["Nothing was added."]);
        });

        /** Each question gets the whole time to answer: the clock of one answered in time never
         * declines the next, asked while the first's time would still have been running. */
        test("a question answered in time leaves the next its whole time", async () => {
          const first = Object.assign(new FakeLoopTool("example_create", "Adding it"), { question: "Add A?" });
          const second = Object.assign(new FakeLoopTool("example_send", "Sending it"), { question: "Send B?" });
          first.during = () => sleep(600);
          const { controller, done } = await ask([first, second], [calling(["example_create", "{}"], ["example_send", "{}"]), reply(answer)], (controller) => {
            controller.confirmationTimeout = 1000;
          });
          expect(await eventually(() => controller.chat?.confirmation === "Add A?")).toBe(true);
          controller.answerConfirmation(true);
          expect(controller.chat?.confirmationExpiresAt).toBeNull();
          expect(await eventually(() => controller.chat?.confirmation === "Send B?")).toBe(true);

          // Past where the first question's time ran out, and within the second's.
          await sleep(700);
          expect(controller.chat?.confirmation).toBe("Send B?");
          controller.answerConfirmation(true);
          await done;

          expect(first.runs).toEqual([{}]);
          expect(second.runs).toEqual([{}]);
          expect(told(1)).toEqual(["Added.", "Added."]);
        });

        /** A question dropped with its request (the window closed, or the request canceled) takes its
         * clock with it: the next request's question gets its whole time. */
        test.each(["closed", "canceled"])("a question whose request is %s leaves the next its whole time", async (how) => {
          const timeout = 1_500;
          const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
          const { controller, done } = await ask([tool], [calling(["example_create", "{}"])], (controller) => {
            controller.confirmationTimeout = timeout;
          });
          expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
          const firstDeadline = Date.now() + timeout;
          if (how === "closed") controller.closeChat();
          if (how === "canceled") controller.handle("cancel");
          await done;
          expect(tool.runs).toEqual([]);

          transcription.enqueue(200, { text: toolRequest });
          completions.enqueue(200, calling(["example_create", '{"title":"Launch review"}']));
          completions.enqueue(200, reply(answer));
          await holdAndRelease(controller, "agent");
          expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
          // The next question is up well before the first one's time would have run out, and still up past it.
          expect(firstDeadline - Date.now()).toBeGreaterThan(200);
          await sleep(firstDeadline - Date.now() + 150);
          expect(controller.chat?.confirmation).toBe(confirmationQuestion);
          controller.answerConfirmation(true);

          expect(await eventually(() => tool.runs.length === 1)).toBe(true);
          expect(tool.runs).toEqual([{ title: "Launch review" }]);
        });

        /** An answer that comes before its question has shown for the minimum time is ignored: the
         * second click of a double-click on one question's Confirm never confirms the next, which
         * the user has not seen. A later answer decides it. */
        test("a double-click confirms one question, never the next", async () => {
          const first = Object.assign(new FakeLoopTool("example_create", "Adding it"), { question: "Add A?" });
          const second = Object.assign(new FakeLoopTool("example_send", "Sending it"), { question: "Send B?" });
          const { controller, done } = await ask([first, second], [calling(["example_create", "{}"], ["example_send", "{}"]), reply(answer)], (controller) => {
            controller.confirmationMinimumDisplay = 300;
          });
          expect(await eventually(() => controller.chat?.confirmation === "Add A?")).toBe(true);
          // Too soon after the question appeared: meant for none shown yet.
          controller.answerConfirmation(true);
          await sleep(50);
          expect(first.runs).toEqual([]);

          await sleep(300);
          controller.answerConfirmation(true);
          expect(await eventually(() => controller.chat?.confirmation === "Send B?")).toBe(true);
          controller.answerConfirmation(true);
          await sleep(50);
          expect(second.runs).toEqual([]);
          expect(controller.chat?.confirmation).toBe("Send B?");

          await sleep(300);
          controller.answerConfirmation(false);
          await done;

          expect(first.runs).toEqual([{}]);
          expect(second.runs).toEqual([]);
          expect(told(1)).toEqual(["Added.", config.connectorToolDeclined]);
        });

        /** Closing the chat window declines its question at once, however recently it appeared: only
         * the user's own answers wait out its minimum display. */
        test("closing the chat window as soon as it asks declines the question", async () => {
          const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
          const { controller, done } = await ask([tool], [calling(["example_create", "{}"])], (controller) => {
            controller.confirmationMinimumDisplay = 60_000;
          });
          expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

          controller.closeChat();
          await done;

          expect(tool.runs).toEqual([]);
          expect(controller.chat).toBeNull();
          expect(controller.phase).toEqual(idle);
        });

        /** A request canceled while a round waits on the backend stops that round's request itself,
         * not just its reply, and asks nothing more. */
        test("closing the chat window while a round waits stops its request", async () => {
          const tool = new FakeLoopTool();
          const { controller, done } = await ask([tool], [calling(["example_create", "{}"]), reply(answer)], (controller) => {
            completions.gate = async () => {
              if (completions.requests.length === 2) controller.closeChat();
            };
          });
          await done;
          // The reply still arrives after the close.
          await sleep(300);

          expect(tool.runs).toEqual([{}]);
          expect(completions.requests).toHaveLength(2);
          expect(completions.requests[1]?.signal?.aborted).toBe(true);
          expect(controller.chat).toBeNull();
          expect(controller.phase).toEqual(idle);
        });

        describe("a question answered aloud", () => {
          const sameCall = ["example_create", '{"title":"Launch review","day":"friday"}'] as [string, string];
          /** The model answering, for the user, the question answered aloud under `id` (the first a
           * controller hears is "q1"). */
          const answering = (id: string, confirmed: boolean) => [config.confirmationTool, JSON.stringify({ question_id: id, confirmed })] as [string, string];
          const confirming = answering("q1", true);
          const declining = answering("q1", false);

          /** Holds the hotkey while the question shows, past a tap, and releases it: `words` is what
           * the backend hears. */
          async function sayAloud(controller: DictationController, words: string): Promise<void> {
            transcription.enqueue(200, { text: words });
            controller.handle("start");
            expect(controller.phase).toEqual({ kind: "listening" });
            await sleep(config.minimumHoldDuration + 50);
            controller.handle("finish");
          }

          /** The hotkey answers the question: the model reads the question and the user's words, and
           * confirms for the user with its tool; the call that asked then runs as it was shown, with no
           * second question. */
          test("the model reads the answer and confirms for the user, and the call that asked runs", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            // Every question the chat window asks from here on.
            const asking = controller as unknown as { confirm: (question: string) => Promise<unknown> };
            const confirm = asking.confirm.bind(controller);
            const questions: string[] = [];
            asking.confirm = (question) => (questions.push(question), confirm(question));

            await sayAloud(controller, "Yes, go ahead.");
            await done;

            expect(told(1)).toEqual([config.connectorToolAnsweredAloud(confirmationQuestion, "Yes, go ahead.", "q1")]);
            expect(told(1)[0]).toContain("Yes, go ahead.");
            expect(told(1)[0]).toContain("Launch review");
            expect(told(1)[0]).toContain(config.confirmationTool);
            expect(tool.runs).toEqual([{ title: "Launch review", day: "friday" }]);
            expect(told(2).at(-1)).toBe("Added.");
            expect(questions).toEqual([]);
            expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual([answer]);
            expect(controller.phase).toEqual(idle);
            // The answer was transcribed as the request was, with no cleanup, and started no request of its own.
            expect(transcription.requests).toHaveLength(2);
            expect(cleanupVars(1)).toBeUndefined();
            expect(completions.requests).toHaveLength(3);
          });

          /** The model declining for the user runs nothing, and reads that the user declined. */
          test("the model declines for the user, and nothing runs", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(declining), reply("Nothing was added.")]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            await sayAloud(controller, "No, leave it.");
            await done;

            expect(tool.runs).toEqual([]);
            expect(told(2).at(-1)).toBe(config.connectorToolDeclined);
            expect(controller.chat?.confirmation).toBeNull();
          });

          /** The model cannot confirm what the user said nothing to: with no spoken answer waiting
           * (nothing asked yet, or the question clicked, or left unanswered) its tool does nothing. */
          test.each(["nothing asked", "declined by a click", "left unanswered"] as const)("the model's confirmation does nothing with no spoken answer waiting (%s)", async (how) => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const rounds = how === "nothing asked" ? [calling(confirming), reply("Nothing was added.")] : [calling(sameCall), calling(confirming), reply("Nothing was added.")];
            const { controller, done } = await ask([tool], rounds, (controller) => {
              if (how === "left unanswered") controller.confirmationTimeout = 100;
            });
            if (how === "declined by a click") {
              expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
              controller.answerConfirmation(false);
            }
            await done;

            expect(tool.runs).toEqual([]);
            expect(told(rounds.length - 1).at(-1)).toBe(config.confirmationToolNothingWaiting);
          });

          /** One spoken answer is one answer: the model's tool a second time does nothing. */
          test("the model's confirmation a second time does nothing", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            await sayAloud(controller, "Yes.");
            await done;

            expect(tool.runs).toHaveLength(1);
            expect(told(3).at(-1)).toBe(config.confirmationToolNothingWaiting);
          });

          /** A confirmation that says neither true nor false runs nothing, and uses up the answer. */
          test.each(['{"question_id":"q1"}', '{"question_id":"q1","confirmed":"yes"}', "not json"])("the model's confirmation without true or false runs nothing (%s)", async (args) => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling([config.confirmationTool, args]), calling(confirming), reply("Nothing was added.")]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            await sayAloud(controller, "Yes.");
            await done;

            expect(tool.runs).toEqual([]);
            expect(told(2).at(-1)).toBe(config.confirmationToolNoAnswer);
            expect(told(3).at(-1)).toBe(config.confirmationToolNothingWaiting);
          });

          /** A confirmation that names no question, or another one, answers nothing: it runs nothing,
           * and the answer waits on for the confirmation that names it. */
          test.each(['{"confirmed":true}', '{"question_id":"q2","confirmed":true}', '{"question_id":1,"confirmed":true}'])("the model's confirmation without this question's id runs nothing (%s)", async (args) => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling([config.confirmationTool, args]), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            await sayAloud(controller, "Yes.");
            await done;

            expect(told(2)).toEqual([config.confirmationToolNothingWaiting]);
            expect(told(3)).toEqual(["Added."]);
            expect(tool.runs).toEqual([{ title: "Launch review", day: "friday" }]);
          });

          /** Without the model confirming, an answer aloud runs nothing: the app never reads "yes" itself. */
          test("the tool does not run unless the model confirms", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply("Nothing was added.")]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            await sayAloud(controller, "No, leave it.");
            await done;

            expect(tool.runs).toEqual([]);
            expect(told(1)).toEqual([config.connectorToolAnsweredAloud(confirmationQuestion, "No, leave it.", "q1")]);
            expect(controller.chat?.confirmation).toBeNull();
            expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual(["Nothing was added."]);
          });

          /** Any call but the model's confirmation (the same tool with other arguments, another tool,
           * or the same call again) is asked about, and drops the answered one: the answer covered
           * only what the question showed. */
          test.each([
            ["other arguments", ["example_create", '{"title":"Launch review","day":"monday"}'] as [string, string]],
            ["another tool", ["example_send", '{"title":"Launch review","day":"friday"}'] as [string, string]],
            ["the same arguments", sameCall],
          ])("a call with %s is asked about", async (_, changed) => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const other = Object.assign(new FakeLoopTool("example_send"), { question: "Send it?" });
            const { controller, done } = await ask([tool, other], [calling(sameCall), calling(changed), calling(confirming), reply("Nothing was added.")]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            await sayAloud(controller, "Make it Monday.");
            expect(await eventually(() => completions.requests.length === 2 && controller.chat?.confirmation != null)).toBe(true);
            expect(tool.runs).toEqual([]);
            expect(other.runs).toEqual([]);
            expect(controller.chat?.confirmationExpiresAt).not.toBeNull();

            controller.answerConfirmation(false);
            await done;
            expect(tool.runs).toEqual([]);
            expect(other.runs).toEqual([]);
            expect(told(2).at(-1)).toBe(config.connectorToolDeclined);
            expect(told(3).at(-1)).toBe(config.confirmationToolNothingWaiting);
          });

          /** An answer aloud to one request is no answer in the next request. */
          test("the next request's confirmation does nothing", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply("Nothing was added.")]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            await sayAloud(controller, "Yes.");
            await done;
            expect(await eventually(() => controller.phase.kind === "idle")).toBe(true);

            // Past the next request's first round too, where a confirmation is refused as written
            // before any answer.
            transcription.enqueue(200, { text: "go ahead" });
            completions.enqueue(200, calling(confirming));
            completions.enqueue(200, calling(confirming));
            completions.enqueue(200, reply("Nothing was added."));
            await holdAndRelease(controller, "agent");
            expect(await eventually(() => completions.requests.length === 5 && controller.phase.kind === "idle")).toBe(true);
            expect(tool.runs).toEqual([]);
            expect(told(3)).toEqual([config.confirmationToolNothingWaiting]);
            expect(told(4).at(-1)).toBe(config.confirmationToolNothingWaiting);
          });

          /** Two questions answered aloud, in one round or one after the other, each with its own id:
           * the model's confirmation runs only the question it names, and only while that one is still
           * waiting (another call drops it). What the user declined aloud never runs, whatever the model
           * confirms. */
          test.each([
            ["one round", "confirms the first, declines the second", [answering("q1", true), answering("q2", false)], []],
            ["one round", "declines the first, confirms the second", [answering("q1", false), answering("q2", true)], [{ to: "x" }]],
            ["two rounds", "confirms the first, declines the second", [answering("q1", true), answering("q2", false)], []],
            ["two rounds", "confirms only the first", [answering("q1", true)], []],
          ] as const)("two questions answered aloud in %s: the model %s", async (rounds, _, confirmations, sent) => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const other = Object.assign(new FakeLoopTool("example_send"), { question: "Send it?" });
            const send = ["example_send", '{"to":"x"}'] as [string, string];
            const asking = rounds === "one round" ? [calling(sameCall, send)] : [calling(sameCall), calling(send)];
            const { controller, done } = await ask([tool, other], [...asking, calling(...confirmations), reply("Done.")]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            const [first, second] = confirmations.map(([, args]) => (JSON.parse(args) as { confirmed: boolean }).confirmed);
            await sayAloud(controller, first === true ? "Yes, add it." : "No, don't add it.");
            expect(await eventually(() => controller.chat?.confirmation === "Send it?")).toBe(true);
            await sayAloud(controller, second === true ? "Yes, send it." : "No, don't send that.");
            await done;

            expect(tool.runs).toEqual([]);
            expect(other.runs).toEqual(sent);
            const last = told(asking.length + 1);
            expect(last[0]).toBe(config.confirmationToolNothingWaiting);
            if (second !== undefined) expect(last[1]).toBe(second ? "Added." : config.connectorToolDeclined);
          });

          /** A spoken change asks again, with its own id; the spoken "yes" to it runs the changed call
           * once, and a confirmation of the first question, which the change replaced, runs nothing. */
          test("a spoken change then a spoken yes runs the changed call", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const monday = ["example_create", '{"title":"Launch review","day":"monday"}'] as [string, string];
            const { controller, done } = await ask([tool], [calling(sameCall), calling(monday), calling(answering("q1", true), answering("q2", true)), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            await sayAloud(controller, "Make it Monday.");
            expect(await eventually(() => completions.requests.length === 2 && controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            await sayAloud(controller, "Yes.");
            await done;

            expect(tool.runs).toEqual([{ title: "Launch review", day: "monday" }]);
            expect(told(2)).toEqual([config.connectorToolAnsweredAloud(confirmationQuestion, "Yes.", "q2")]);
            expect(told(3)).toEqual([config.confirmationToolNothingWaiting, "Added."]);
          });

          /** The question_id the model reads in a spoken answer's result, wherever the result names it. */
          function readID(result: string): string {
            const ids = [...result.matchAll(/question_id ("[^"]*")/g)].map(([, id]) => JSON.parse(id ?? "null") as string);
            expect(ids.length).toBeGreaterThan(0);
            expect(new Set(ids).size).toBe(1);
            return ids[0] ?? "";
          }

          /** The model confirms with the id it read, as a real one does, not one the test knows: each
           * question answered aloud gives its own id, and after a spoken change the confirmation naming
           * the first question runs nothing, while the one naming the second runs the changed call once. */
          test("each question answered aloud gives the model its own id", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const monday = ["example_create", '{"title":"Launch review","day":"monday"}'] as [string, string];
            const ids: string[] = [];
            const { controller, done } = await ask([tool], [calling(sameCall)], () => {
              completions.gate = async () => {
                const count = completions.requests.length;
                if (count === 2) {
                  ids.push(readID(told(1)[0] ?? ""));
                  completions.enqueue(200, calling(monday));
                } else if (count === 3) {
                  ids.push(readID(told(2)[0] ?? ""));
                  completions.enqueue(200, calling(answering(ids[0] ?? "", true), answering(ids[1] ?? "", true)));
                } else if (count === 4) {
                  completions.enqueue(200, reply(answer));
                }
              };
            });
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            await sayAloud(controller, "Make it Monday.");
            expect(await eventually(() => completions.requests.length === 2 && controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            expect(tool.runs).toEqual([]);
            await sayAloud(controller, "Yes, add it.");
            await done;

            expect(ids).toHaveLength(2);
            expect(ids[0]).not.toBe(ids[1]);
            expect(told(3)).toEqual([config.confirmationToolNothingWaiting, "Added."]);
            expect(tool.runs).toEqual([{ title: "Launch review", day: "monday" }]);
          });

          /** The answer is transcribed with the request's settings as they were when it started (the
           * backend, the keyboard's language, the dictionary), not as they were changed while the question
           * showed, and with no cleanup. */
          test("the answer is transcribed with the request's language and dictionary", async () => {
            keyboard.language = "ko";
            prefs.value = { ...prefs.value, backendURL: "https://first.example.com", dictionary: ["Xyvora"] };
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            prefs.value = { ...prefs.value, backendURL: "https://second.example.com", dictionary: ["Changed"] };
            keyboard.language = "fr";

            await sayAloud(controller, "Yes, add Xyvora.");
            await done;

            expect(transcription.requests).toHaveLength(2);
            expect(hosts(transcription)).toEqual(["first.example.com", "first.example.com"]);
            expect(transcription.body(1).language).toBe("ko");
            expect(transcription.body(1).vocabulary).toEqual(["Xyvora"]);
            expect(transcription.body(1).cleanup).toBeUndefined();
            expect(tool.runs).toEqual([{ title: "Launch review", day: "friday" }]);
          });

          /** The words answered aloud are user content: only the debug log's content entries carry them,
           * never an error, which reaches stderr in every build, nor the debug log's other entries. */
          test.each([false, true])("the answer aloud is logged only as content (debug build: %s)", async (isDebugBuild) => {
            const words = "Yes, private spoken answer.";
            const file: [LogLevel, string][] = [];
            const errors: string[] = [];
            configureLog({ isDebugBuild, sinks: { file: (level, text) => file.push([level, text]), error: (text) => errors.push(text) } });
            try {
              const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
              const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), reply(answer)]);
              expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

              await sayAloud(controller, words);
              await done;

              expect(tool.runs).toEqual([{ title: "Launch review", day: "friday" }]);
              expect(errors.join("\n")).not.toContain(words);
              expect(file.filter(([level]) => level !== "CONTENT").map(([, text]) => text).join("\n")).not.toContain(words);
              const content = file.filter(([level]) => level === "CONTENT").map(([, text]) => text).join("\n");
              if (isDebugBuild) expect(content).toContain(words);
              else expect(file).toEqual([]);
            } finally {
              configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
            }
          });

          /** A question answered aloud after another of its round was clicked waits, and the model's
           * confirmation runs it. */
          test("a question answered aloud after one clicked in its round waits for the model", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const other = Object.assign(new FakeLoopTool("example_send"), { question: "Send it?" });
            const { controller, done } = await ask([tool, other], [calling(sameCall, ["example_send", '{"to":"x"}']), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            controller.answerConfirmation(true);
            expect(await eventually(() => controller.chat?.confirmation === "Send it?")).toBe(true);
            await sayAloud(controller, "Yes, send it.");
            await done;

            expect(tool.runs).toHaveLength(1);
            expect(other.runs).toEqual([{ to: "x" }]);
            expect(told(1)).toEqual(["Added.", config.connectorToolAnsweredAloud("Send it?", "Yes, send it.", "q1")]);
          });

          /** The question's clock stops while its answer is spoken and transcribed: it is not declined
           * mid-sentence. */
          test("the question does not run out of time while it is answered", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), reply(answer)], (controller) => {
              controller.confirmationTimeout = 300;
            });
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            transcription.enqueue(200, { text: "Yes." });
            controller.handle("start");
            expect(controller.chat?.confirmationExpiresAt).toBeNull();
            await sleep(600);
            expect(controller.chat?.confirmation).toBe(confirmationQuestion);
            expect(controller.phase).toEqual({ kind: "listening" });
            controller.handle("finish");
            await done;

            expect(tool.runs).toHaveLength(1);
            expect(told(1)).toEqual([config.connectorToolAnsweredAloud(confirmationQuestion, "Yes.", "q1")]);
          });

          /** An answer that comes to nothing (a tap, another key, no words heard, a transcription
           * that fails) leaves the question asking, its time to answer whole again, and the request
           * under way: a click still answers it. */
          test.each(["a tap", "canceled", "nothing heard", "not transcribed"] as const)("an answer that comes to nothing leaves the question asking (%s)", async (how) => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply(answer)], (controller) => {
              controller.confirmationTimeout = 5_000;
              controller.transcriptionRetryDelays = [];
            });
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            const capture = (controller as unknown as { deps: { capture: CountingCapture } }).deps.capture;
            const stops = capture.stops;

            controller.handle("start");
            expect(controller.phase).toEqual({ kind: "listening" });
            expect(controller.chat?.confirmationExpiresAt).toBeNull();
            if (how === "a tap") controller.handle("finish");
            else if (how === "canceled") controller.handle("cancel");
            else {
              if (how === "nothing heard") transcription.enqueue(200, { text: "  " });
              else transcription.enqueue(400, { error: "bad_request" });
              await sleep(config.minimumHoldDuration + 50);
              controller.handle("finish");
            }
            expect(await eventually(() => controller.phase.kind === "running")).toBe(true);

            expect(controller.phase).toEqual(running("answer"));
            expect(capture.stops).toBeGreaterThan(stops);
            expect(controller.chat?.confirmation).toBe(confirmationQuestion);
            const left = (controller.chat?.confirmationExpiresAt ?? 0) - Date.now();
            expect(left).toBeGreaterThan(4_000);
            expect(completions.requests).toHaveLength(1);
            expect(transcription.requests).toHaveLength(how === "a tap" || how === "canceled" ? 1 : 2);
            expect(tool.runs).toEqual([]);

            controller.answerConfirmation(true);
            await done;
            expect(tool.runs).toHaveLength(1);
            expect(told(1)).toEqual(["Added."]);
          });

          /** A click while the answer is spoken answers the question: the recording stops and what
           * was being said goes nowhere. */
          test("a click while the answer is spoken answers the question", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            const capture = (controller as unknown as { deps: { capture: CountingCapture } }).deps.capture;

            controller.handle("start");
            await sleep(config.minimumHoldDuration + 50);
            const stops = capture.stops;
            controller.answerConfirmation(true);
            expect(capture.stops).toBe(stops + 1);
            controller.handle("finish");
            await done;

            expect(tool.runs).toHaveLength(1);
            expect(told(1)).toEqual(["Added."]);
            expect(transcription.requests).toHaveLength(1);
            expect(controller.phase).toEqual(idle);
          });

          /** A double tap answers hands-free: the first tap says nothing, the second press listens
           * until the hotkey is tapped again. */
          test("a double tap answers hands-free", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            transcription.enqueue(200, { text: "Yes." });
            controller.handle("start");
            controller.handle("finish");
            controller.handle("startHandsFree");
            controller.handle("listenHandsFree");
            expect(controller.phase).toEqual({ kind: "listening" });
            controller.handle("finish");
            await done;

            expect(tool.runs).toHaveLength(1);
            expect(transcription.requests).toHaveLength(2);
          });

          /** A confirmation the model writes in the round that asks was written before the user
           * answered: it answers nothing, whatever the user then says, and the answer waits for the
           * model's next round, which reads it. */
          test.each([
            ["declines", declining, []],
            ["confirms", confirming, [{ title: "Launch review", day: "friday" }]],
          ] as const)("a confirmation written in the round that asked answers nothing (the next round %s)", async (_, next, runs) => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall, confirming), calling(next), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            await sayAloud(controller, "No, leave it. Do not add that.");
            await done;

            expect(told(1)).toEqual([config.connectorToolAnsweredAloud(confirmationQuestion, "No, leave it. Do not add that.", "q1"), config.confirmationToolNothingWaiting]);
            expect(tool.runs).toEqual(runs);
          });

          /** An answer dropped while it is transcribed (another key, a click on the question) sends
           * nothing more: its upload is canceled, and one waiting to be tried again is not sent. */
          test.each(["canceled", "clicked"] as const)("a dropped answer's transcription is canceled (%s)", async (how) => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply("Nothing was added.")]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            let release: () => void = () => {};
            transcription.gate = (request) => (request.signal ? new Promise((resolve) => (release = resolve)) : Promise.resolve());
            transcription.honorsCancel = true;

            await sayAloud(controller, "Yes.");
            expect(await eventually(() => transcription.requests.length === 2)).toBe(true);
            if (how === "canceled") controller.handle("cancel");
            else controller.answerConfirmation(false);
            const upload = transcription.requests[1];
            expect(upload?.signal?.aborted).toBe(true);
            transcription.gate = undefined;
            release();
            if (how === "canceled") controller.answerConfirmation(false);
            await done;
            expect(transcription.requests).toHaveLength(2);
            expect(tool.runs).toEqual([]);
          });

          /** Each answer spoken aloud starts blue: a voice heard in one the user dropped does not
           * give the next one's waveform its recording colour (owner, 2026-10-02). */
          test("each answer spoken aloud starts with no voice heard", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply("Nothing was added.")]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            const capture = (controller as unknown as { deps: { capture: CountingCapture } }).deps.capture;

            controller.handle("start");
            expect(controller.phase).toEqual({ kind: "listening" });
            expect(controller.hasVoice).toBe(false);
            for (let reading = 0; reading < 10; reading += 1) capture.hearWindow(0.01);
            capture.hearWindow(0.1);
            expect(controller.hasVoice).toBe(true);
            controller.handle("cancel");

            controller.handle("start");
            expect(controller.phase).toEqual({ kind: "listening" });
            expect(controller.hasVoice).toBe(false);
            controller.handle("cancel");
            controller.answerConfirmation(false);
            await done;
          });

          /** The circle is purple only while this answer is being tried again: dropped, its retry still
           * in flight, it is not (owner, 2026-10-02: purple only for a server error of its own). */
          test("a dropped answer's retry still in flight stops saying it is retrying", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply("Nothing was added.")], (controller) => {
              controller.transcriptionRetryDelays = [1];
              controller.transcriptionRetryNoticeDelay = 10_000;
            });
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            transcription.enqueue(502, { error: "transcription_failed" });
            transcription.enqueue(200, { text: "Yes." });
            const retry = deferred<void>();
            transcription.gate = async () => {
              if (transcription.requests.length === 3) await retry.promise;
            };
            controller.handle("start");
            await sleep(config.minimumHoldDuration + 50);
            controller.handle("finish");
            expect(await eventually(() => transcription.requests.length === 3 && controller.isRetrying)).toBe(true);

            controller.handle("cancel");
            expect(controller.isRetrying).toBe(false);
            retry.resolve();
            controller.answerConfirmation(false);
            await done;
            expect(controller.isRetrying).toBe(false);
          });

          test("a dropped answer is not tried again", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply("Nothing was added.")], (controller) => {
              controller.transcriptionRetryDelays = [300];
              controller.transcriptionRetryNoticeDelay = 0;
            });
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            transcription.enqueue(502, { error: "transcription_failed" });
            transcription.enqueue(200, { text: "Yes." });
            controller.handle("start");
            await sleep(config.minimumHoldDuration + 50);
            controller.handle("finish");
            expect(await eventually(() => controller.phase.kind === "retrying")).toBe(true);
            controller.handle("cancel");
            await sleep(500);

            expect(transcription.requests).toHaveLength(2);
            expect(controller.chat?.confirmation).toBe(confirmationQuestion);
            controller.answerConfirmation(false);
            await done;
            expect(tool.runs).toEqual([]);
          });

          /** An answer dropped with a click while its retry's request is still out (a token refresh, or a
           * reply already on its way, does not stop for it): the retry note's time comes before that
           * request settles, and the note never comes up over the chat window's question. */
          test("a dropped answer's retry note never comes up", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply("Nothing was added.")], (controller) => {
              controller.transcriptionRetryDelays = [1];
              controller.transcriptionRetryNoticeDelay = 100;
            });
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            transcription.enqueue(502, { error: "transcription_failed" });
            transcription.enqueue(200, { text: "Yes." });
            const held = deferred<void>();
            transcription.gate = async () => {
              if (transcription.requests.length === 3) await held.promise;
            };
            const phases: Phase[] = [];
            controller.onPhaseChange = (phase) => phases.push(phase);

            controller.handle("start");
            await sleep(config.minimumHoldDuration + 50);
            controller.handle("finish");
            expect(await eventually(() => transcription.requests.length === 3)).toBe(true);
            controller.answerConfirmation(false);
            await sleep(250);
            transcription.gate = undefined;
            held.resolve();
            await done;

            expect(phases.map((phase) => phase.kind)).not.toContain("retrying");
            expect(tool.runs).toEqual([]);
          });

          /** Words that arrive after their answer was dropped answer nothing: not the question they
           * were spoken to, which the user answered with a click, nor the next one. */
          test("an answer that arrives after it was dropped answers nothing", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(sameCall), reply("Nothing was added.")]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            let release: () => void = () => {};
            transcription.gate = (request) => (request.signal ? new Promise((resolve) => (release = resolve)) : Promise.resolve());

            await sayAloud(controller, "Yes, do it.");
            expect(await eventually(() => transcription.requests.length === 2)).toBe(true);
            controller.answerConfirmation(false);
            // The model asks again; the dropped words arrive while it does.
            expect(await eventually(() => completions.requests.length === 2 && controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            transcription.gate = undefined;
            release();
            await sleep(100);

            expect(controller.chat?.confirmation).toBe(confirmationQuestion);
            expect(told(1)).toEqual([config.connectorToolDeclined]);
            controller.answerConfirmation(false);
            await done;
            expect(tool.runs).toEqual([]);
            expect(told(2)).toEqual([config.connectorToolDeclined]);
          });

          /** The paste history (a triple tap) while the answer is spoken drops the answer, not the
           * request: the question asks on. */
          test("the paste history while the answer is spoken leaves the question asking", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            controller.handle("start");
            controller.handle("showHistory");

            expect(controller.phase).toEqual(running("answer"));
            expect(controller.chat?.confirmation).toBe(confirmationQuestion);
            expect(controller.chat?.confirmationExpiresAt).not.toBeNull();
            controller.answerConfirmation(true);
            await done;
            expect(tool.runs).toHaveLength(1);
          });

          /** A second press while the answer is spoken starts nothing more: one recording, one answer. */
          test("a second press while the answer is spoken starts nothing more", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            const capture = (controller as unknown as { deps: { capture: CountingCapture } }).deps.capture;
            const starts = capture.starts;

            controller.handle("start");
            controller.handle("start");
            expect(capture.starts).toBe(starts + 1);
            await sayAloud(controller, "Yes.");
            await done;
            expect(tool.runs).toHaveLength(1);
            expect(controller.phase).toEqual(idle);
          });

          /** The microphone failing to start, or recording nothing, leaves the question asking with
           * its whole time again; one that stops by itself sends what it heard. */
          test.each(["failed to start", "recorded nothing"] as const)("an answer whose microphone %s leaves the question asking", async (how) => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply(answer)], (controller) => {
              controller.confirmationTimeout = 5_000;
            });
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            const capture = (controller as unknown as { deps: { capture: CountingCapture } }).deps.capture;

            if (how === "failed to start") {
              controller.handle("start");
              capture.fail();
            } else {
              Object.assign(capture, { hears: false });
              controller.handle("start");
              await sleep(config.minimumHoldDuration + 50);
              controller.handle("finish");
              expect(await eventually(() => controller.phase.kind === "running")).toBe(true);
            }

            expect(controller.phase).toEqual(running("answer"));
            expect(controller.chat?.confirmation).toBe(confirmationQuestion);
            expect((controller.chat?.confirmationExpiresAt ?? 0) - Date.now()).toBeGreaterThan(4_000);
            expect(transcription.requests).toHaveLength(1);
            controller.answerConfirmation(true);
            await done;
            expect(tool.runs).toHaveLength(1);
          });

          test("an answer whose microphone stops by itself sends what it heard", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            const capture = (controller as unknown as { deps: { capture: CountingCapture } }).deps.capture;

            transcription.enqueue(200, { text: "Yes." });
            controller.handle("start");
            await sleep(config.minimumHoldDuration + 50);
            capture.lose();
            await done;
            expect(transcription.requests).toHaveLength(2);
            expect(tool.runs).toHaveLength(1);
          });

          /** The microphone is released before the answer is sent, not once the upload is done. */
          test("the microphone is released while the answer is transcribed", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            const capture = (controller as unknown as { deps: { capture: CountingCapture } }).deps.capture;
            let release: () => void = () => {};
            transcription.gate = (request) => (request.signal ? new Promise((resolve) => (release = resolve)) : Promise.resolve());

            await sayAloud(controller, "Yes.");
            expect(await eventually(() => transcription.requests.length === 2)).toBe(true);
            expect(capture.events.at(-1)).toBe("stop");

            transcription.gate = undefined;
            release();
            await done;
            expect(tool.runs).toHaveLength(1);
          });

          /** One that stops while the key is still held is sent once: the release that follows sends
           * nothing more. */
          test("an answer whose microphone stops while the key is held is sent once", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            const capture = (controller as unknown as { deps: { capture: CountingCapture } }).deps.capture;
            let release: () => void = () => {};
            transcription.gate = (request) => (request.signal ? new Promise((resolve) => (release = resolve)) : Promise.resolve());

            transcription.enqueue(200, { text: "Yes." });
            controller.handle("start");
            await sleep(config.minimumHoldDuration + 50);
            capture.lose();
            expect(await eventually(() => transcription.requests.length === 2)).toBe(true);
            controller.handle("finish");
            await sleep(config.releaseTailDuration + 100);

            expect(transcription.requests).toHaveLength(2);
            transcription.gate = undefined;
            release();
            await done;
            expect(transcription.requests).toHaveLength(2);
            expect(tool.runs).toHaveLength(1);
          });

          /** A hands-free answer, which no key release ends, stops at `maxUnchunkedDuration`, as one request: the
           * microphone is released and what it heard is sent. */
          test("a hands-free answer stops at the length cap and is sent", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), calling(confirming), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            const capture = (controller as unknown as { deps: { capture: CountingCapture } }).deps.capture;
            const stops = capture.stops;

            transcription.enqueue(200, { text: "Yes." });
            // The cap's two minutes run at once. (Fake timers can't stand in: the request's own wait,
            // `eventually` in `carryOut`, polls throughout, so two fake minutes either run out its
            // deadline or step through every poll.)
            const delays: (number | undefined)[] = [];
            const realSetTimeout = globalThis.setTimeout;
            const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((action: () => void, delay?: number) => {
              delays.push(delay);
              return realSetTimeout(action, delay === config.maxUnchunkedDuration ? 0 : delay);
            }) as unknown as typeof setTimeout);
            try {
              controller.handle("startHandsFree");
              controller.handle("listenHandsFree");
              // More than the cap reaches the microphone before the cap's timer fires.
              capture.feed(tone(config.maxUnchunkedDuration / 1000 + 5));
            } finally {
              timers.mockRestore();
            }
            expect(delays).toContain(config.maxUnchunkedDuration);
            expect(controller.phase).toEqual({ kind: "listening" });

            expect(await eventually(() => controller.phase.kind !== "listening")).toBe(true);
            await done;
            expect(capture.stops).toBeGreaterThan(stops);
            expect(transcription.requests).toHaveLength(2);
            // One request within what the speech model transcribes at once: the answer is not chunked.
            const uploaded = decodeFLAC(new Uint8Array(Buffer.from(String(transcription.body(1).audio), "base64")));
            expect(uploaded.totalSamples).toBeLessThanOrEqual((config.maxUnchunkedDuration / 1000) * config.recordingSampleRate);
            expect(uploaded.totalSamples).toBeGreaterThan(((config.maxUnchunkedDuration / 1000) - 1) * config.recordingSampleRate);
            expect(tool.runs).toHaveLength(1);
          });

          /** The chat window stays open while the answer is spoken, however long the user takes. */
          test("the chat window stays open while the answer is spoken", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall), reply(answer)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
            const touched = controller.chat?.touched;

            controller.handle("start");
            expect(touched).toBe(false);
            expect(controller.chat?.touched).toBe(true);
            controller.handle("cancel");
            controller.answerConfirmation(false);
            await done;
          });

          /** Closing the chat window while the answer is spoken drops the request, as while it asks. */
          test("closing the chat window while the answer is spoken drops the request", async () => {
            const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
            const { controller, done } = await ask([tool], [calling(sameCall)]);
            expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

            transcription.enqueue(200, { text: "Yes." });
            controller.handle("start");
            await sleep(config.minimumHoldDuration + 50);
            controller.closeChat();
            controller.handle("finish");
            await done;
            await sleep(config.releaseTailDuration + 100);

            expect(tool.runs).toEqual([]);
            expect(controller.chat).toBeNull();
            expect(controller.phase).toEqual(idle);
            expect(transcription.requests).toHaveLength(1);
            expect(completions.requests).toHaveLength(1);
          });
        });

        /** Closing the chat window while it asks drops the request: the tool doesn't run, the round's
         * later calls don't either, and the model is asked nothing more. Nothing is left waiting: a
         * late confirmation runs nothing, and the next request goes as usual. */
        test("closing the chat window while it asks drops the request", async () => {
          const tool = Object.assign(new FakeLoopTool(), { question: confirmationQuestion });
          const { controller, done, chatChanges } = await ask([tool], [calling(["example_create", "{}"], ["example_create", "{}"])]);
          expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);

          controller.closeChat();
          await done;
          controller.answerConfirmation(true);
          await sleep(100);

          expect(tool.runs).toEqual([]);
          expect(tool.asked).toBe(1);
          expect(completions.requests).toHaveLength(1);
          expect(controller.chat).toBeNull();
          expect(controller.phase).toEqual(idle);
          expect(chatChanges).toEqual([true, false]);

          completions.requests.length = 0;
          completions.gate = undefined;
          transcription.enqueue(200, { text: "what day is it" });
          completions.enqueue(200, reply("Friday."));
          await holdAndRelease(controller, "agent");
          expect(await eventually(() => controller.chat?.turns.length === 1)).toBe(true);
          expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual(["Friday."]);
        });

        /** Canceled, or ended with the account, while a tool runs or asks, a first request's chat
         * window, still empty, closes with it: the next hold dictates. */
        test.each([
          ["canceled", "asks"],
          ["canceled", "runs"],
          ["signed out", "asks"],
          ["signed out", "runs"],
        ])("%s while a tool %s, the empty chat window closes", async (how, when) => {
          const account = signedIn(auth);
          const tool = new FakeLoopTool();
          if (when === "asks") tool.question = confirmationQuestion;
          const started = deferred<void>();
          const finish = deferred<void>();
          tool.during = async () => {
            started.resolve();
            await finish.promise;
          };
          const { controller, done, chatChanges } = await ask([tool], [calling(["example_create", "{}"]), reply("Never shown.")], () => {}, { account });
          if (when === "asks") expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
          else await started.promise;
          expect(controller.chat?.turns).toEqual([]);

          if (how === "canceled") controller.handle("cancel");
          else account.signOut();
          finish.resolve();
          await done;
          await sleep(100);

          expect(controller.chat).toBeNull();
          expect(chatChanges).toEqual([true, false]);
          expect(controller.phase).toEqual(idle);
          expect(tool.runs).toHaveLength(when === "asks" ? 0 : 1);
          expect(completions.requests).toHaveLength(1);
          if (how === "signed out") return;
          controller.handle("start");
          expect(controller.mode).toBe("dictation");
          controller.handle("cancel");
        });

        /** Canceled while its tool runs or asks, a follow-up leaves the chat window as it was: no
         * question, no tool running, no request pending; a tool that asked never runs. */
        test.each(["asks", "runs"])("a follow-up canceled while its tool %s leaves the chat as it was", async (when) => {
          const tool = new FakeLoopTool();
          if (when === "asks") tool.question = confirmationQuestion;
          const started = deferred<void>();
          const finish = deferred<void>();
          tool.during = async () => {
            started.resolve();
            await finish.promise;
          };
          const { controller } = await openChat(() => {}, undefined, { connectorTools: [tool] });
          transcription.enqueue(200, { text: toolRequest });
          completions.enqueue(200, reply("answer"));
          completions.enqueue(200, calling(["example_create", "{}"]));
          controller.handle("start");
          expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
          controller.handle("finish");
          if (when === "asks") expect(await eventually(() => controller.chat?.confirmation === confirmationQuestion)).toBe(true);
          else await started.promise;
          expect(controller.chat?.pendingRequest).toBe(toolRequest);

          controller.handle("cancel");
          controller.answerConfirmation(true);
          finish.resolve();
          await sleep(100);

          expect(controller.chat).toEqual({ ...emptyChat, turns: [{ id: 0, request: question, tool: "answer", reply: answer }], touched: true });
          expect(controller.phase).toEqual(idle);
          expect(tool.runs).toHaveLength(when === "asks" ? 0 : 1);
          expect(completions.requests).toHaveLength(4);
        });

        /** A tool runs with its request's signal, which aborts when the request is canceled or its
         * chat window closed, so a tool that started something (a script) ends it; a request that
         * finishes leaves it running on. */
        test.each(["canceled", "closed", "finished"])("a tool's signal when its request is %s", async (how) => {
          const tool = new FakeLoopTool();
          const started = deferred<void>();
          const finish = deferred<void>();
          tool.during = async () => {
            started.resolve();
            await finish.promise;
          };
          const { controller, done } = await ask([tool], [calling(["example_create", "{}"]), reply(answer)]);
          await started.promise;
          expect(tool.signals).toHaveLength(1);
          expect(tool.signals[0]?.aborted).toBe(false);

          if (how === "canceled") controller.handle("cancel");
          if (how === "closed") controller.closeChat();
          finish.resolve();
          await done;

          expect(tool.signals[0]?.aborted).toBe(how !== "finished");
        });

        /** A tool still running for a canceled request leaves the next request's tool shown: its end
         * clears nothing of a newer request's. */
        test("a canceled request's tool leaves the next one's shown", async () => {
          const first = new FakeLoopTool("example_create", "Adding it to your calendar");
          const second = new FakeLoopTool("example_read", "Checking your calendar");
          const firstStarted = deferred<void>();
          const firstDone = deferred<void>();
          first.during = async () => {
            firstStarted.resolve();
            await firstDone.promise;
          };
          const secondDone = deferred<void>();
          second.during = () => secondDone.promise;
          const { controller, done } = await ask([first, second], [calling(["example_create", "{}"])]);
          await firstStarted.promise;
          controller.handle("cancel");
          await done;
          transcription.enqueue(200, { text: "what is on today" });
          completions.enqueue(200, calling(["example_read", "{}"]));
          completions.enqueue(200, reply("Nothing today."));

          await holdAndRelease(controller, "agent");
          expect(await eventually(() => controller.chat?.activity === "Checking your calendar")).toBe(true);
          firstDone.resolve();
          await sleep(100);

          expect(controller.chat?.activity).toBe("Checking your calendar");
          secondDone.resolve();
          expect(await eventually(() => controller.chat?.turns.length === 1)).toBe(true);
          expect(controller.chat?.activity).toBeNull();
        });

        /** A tool this app doesn't have, or arguments that aren't a JSON object, run nothing: the model
         * is told why, and answers. */
        test.each([
          ["example_missing", "{}", "Error: there is no tool named example_missing."],
          ["example_create", "[1, 2]", "Error: the arguments were not a JSON object."],
          ["example_create", "null", "Error: the arguments were not a JSON object."],
          ["example_create", "not json", "Error: the arguments were not a JSON object."],
        ])("a call of %s with %s runs nothing", async (name, args, error) => {
          const tool = new FakeLoopTool();
          const { controller, done } = await ask([tool], [calling([name, args]), reply(answer)]);
          await done;

          expect(tool.runs).toEqual([]);
          expect(tool.asked).toBe(0);
          expect(told(1)).toEqual([error]);
          expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual([answer]);
        });

        /** A tool that fails tells the model why, which answers. */
        test.each([new Error("Calendar access was denied."), "Calendar access was denied."])("a failing tool is reported to the model (%o)", async (failure) => {
          const tool = Object.assign(new FakeLoopTool(), { failure });
          const { controller, done } = await ask([tool], [calling(["example_create", "{}"]), reply("I couldn't reach your calendar.")]);
          await done;

          expect(tool.runs).toHaveLength(1);
          expect(told(1)).toEqual(["Error: Calendar access was denied."]);
          expect(controller.chat?.activity).toBeNull();
          expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual(["I couldn't reach your calendar."]);
        });

        /** The answer and a tool's failure are user content: only the debug log's content entries carry
         * them, never an error, which reaches stderr in every build, nor the debug log's other entries. */
        test.each([false, true])("the answer and a tool's failure are logged only as content (debug build: %s)", async (isDebugBuild) => {
          const file: [LogLevel, string][] = [];
          const errors: string[] = [];
          configureLog({ isDebugBuild, sinks: { file: (level, text) => file.push([level, text]), error: (text) => errors.push(text) } });
          try {
            const tool = Object.assign(new FakeLoopTool(), { failure: new Error("private tool failure") });
            const { controller, done } = await ask([tool], [calling(["example_create", "{}"]), reply("private answer")]);
            await done;

            expect(told(1)).toEqual(["Error: private tool failure"]);
            expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual(["private answer"]);
            expect(errors.join("\n")).toContain("example_create failed");
            expect(errors.join("\n")).not.toContain("private");
            expect(file.filter(([level]) => level !== "CONTENT").map(([, text]) => text).join("\n")).not.toContain("private");
            const content = file.filter(([level]) => level === "CONTENT").map(([, text]) => text).join("\n");
            if (isDebugBuild) expect(content).toContain("private answer");
            else expect(file).toEqual([]);
          } finally {
            configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
          }
        });

        /** The answer failing after a tool opened the chat window: the empty window goes, and the pill
         * says what failed. */
        test("a failed answer after a tool closes the empty chat window", async () => {
          const tool = new FakeLoopTool();
          const { controller, done, chatChanges } = await ask([tool], [calling(["example_create", "{}"])]);
          completions.enqueue(500, { error: "internal_error" });
          await done;

          expect(tool.runs).toHaveLength(1);
          expect(controller.chat).toBeNull();
          expect(chatChanges).toEqual([true, false]);
          expect(controller.phase).toEqual(failed(new BackendError("failed", 500).message));
        });

        /** A follow-up's tool runs in the open chat window, under the conversation so far, and the
         * window stays open. */
        test("a follow-up's tool runs in the open chat window", async () => {
          const tool = new FakeLoopTool();
          let controllerRef: DictationController | undefined;
          const whileRunning: (AgentChat | null)[] = [];
          tool.during = async () => {
            whileRunning.push(controllerRef?.chat ?? null);
          };
          const { controller, chatChanges } = await openChat(
            (controller) => {
              controllerRef = controller;
            },
            undefined,
            { connectorTools: [tool] },
          );
          transcription.enqueue(200, { text: toolRequest });
          completions.enqueue(200, reply("answer"));
          completions.enqueue(200, calling(["example_create", "{}"]));
          completions.enqueue(200, reply("Added it."));

          await followUp(controller);

          expect(whileRunning).toEqual([
            { ...emptyChat, turns: [{ id: 0, request: question, tool: "answer", reply: answer }], pendingRequest: toolRequest, touched: true, activity: "Adding it to your calendar" },
          ]);
          expect(controller.chat?.turns.map((turn) => turn.reply)).toEqual([answer, "Added it."]);
          expect(controller.chat?.closesAt).toBeNull();
          expect(chatChanges).toEqual([true]);
          expect(completions.body(3).available_tools).toEqual(["date_to_day", "time_delta", "confirmation_answer", "example_create"]);
        });

        /** A chat window touched and then closed leaves the next one untouched: it times out. */
        test("the next chat window times out after a touched one closes", async () => {
          const { controller } = await openChat((controller) => {
            controller.chatTimeout = 100;
          });
          controller.keepChatOpen();
          controller.closeChat();
          queue(question, "answer", answer);

          await holdAndRelease(controller, "agent");
          expect(await eventually(() => controller.chat !== null)).toBe(true);

          expect(controller.chat?.closesAt).not.toBeNull();
          expect(await eventually(() => controller.chat === null)).toBe(true);
        });
      });
    });
  });

  describe("tips and hands-free dictation", () => {
    /** The Space and history tip shows as the pill listens; Space puts it away for that hold, and the
     * tip shows again at the next, until the user has opened the history with a triple tap; then never
     * again. */
    test("the Space and history tip shows until the history is opened", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      controller.tipDisplayDuration = () => 60_000;

      controller.handle("start");
      expect(await eventually(() => controller.tip === "agentAndHistory")).toBe(true);
      expect(controller.phase).toEqual(listening);
      controller.handle("toggleMode");
      expect(controller.tip).toBeNull();
      controller.handle("cancel");
      expect(new TipBook(tipStore).isEligible("agentAndHistory")).toBe(true);

      controller.handle("start");
      expect(await eventually(() => controller.tip === "agentAndHistory")).toBe(true);
      controller.handle("cancel");
      controller.handle("start");
      controller.handle("finish");
      controller.handle("startHandsFree");
      controller.handle("listenHandsFree");
      controller.handle("showHistory");

      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening" && controller.isHearing)).toBe(true);
      expect(await throughout(300, () => controller.tip === null)).toBe(true);
      controller.handle("cancel");
      expect(new TipBook(tipStore).isEligible("agentAndHistory")).toBe(false);
    });

    /** What's new about long dictations (ADR-DESK-049) is a tip, first in line, shown once (owner,
     * 2026-10-03: "an ordinary tooltip that shows with high priority only once"). */
    test("the what's-new tip shows first at the next hold, once, then the hold's tips", async () => {
      tipStore = new MemoryStore();
      const { controller } = makeController({ capture: new CountingCapture(true) });
      const whatsNewDuration = 300;
      controller.tipDisplayDuration = (tip) => (tip === "longDictations" ? whatsNewDuration : 60_000);

      controller.handle("start");
      expect(await eventually(() => controller.tip !== null)).toBe(true);
      expect(controller.tip).toBe("longDictations");
      expect(await eventually(() => controller.tip === "agentAndHistory")).toBe(true);
      controller.handle("cancel");
      expect(new TipBook(tipStore).isEligible("longDictations")).toBe(false);

      controller.handle("start");
      expect(await eventually(() => controller.tip !== null)).toBe(true);
      expect(controller.tip).toBe("agentAndHistory");
      controller.handle("cancel");
    });

    /** Hands-free, it goes before the hands-free tip; up already as the second press ends as a tap,
     * it stays its time rather than flashing by, as it never shows again. */
    test.each([false, true])("hands-free, the what's-new tip shows before the hands-free tip (up as the tap ended: %s)", async (upAsTheTapEnded) => {
      tipStore = new MemoryStore();
      const { controller } = makeController({ capture: new CountingCapture(true) });
      const whatsNewDuration = 300;
      controller.tipDisplayDuration = (tip) => (tip === "longDictations" ? whatsNewDuration : tipDetails[tip].displayDuration);

      controller.handle("startHandsFree");
      if (upAsTheTapEnded) expect(await eventually(() => controller.tip === "longDictations")).toBe(true);
      controller.handle("listenHandsFree");
      expect(await eventually(() => controller.tip !== null)).toBe(true);
      expect(controller.tip).toBe("longDictations");
      expect(await eventually(() => controller.tip === "handsFree")).toBe(true);
      controller.handle("cancel");
    });

    /** The waveform takes its recording colour once a voice stands `waveformVoiceAboveNoiseDecibels` above the room's
     * noise as it stood before it, and stays so for the dictation; each dictation starts blue
     * (owner, 2026-10-02). A reading just under that is not a voice. */
    test("a voice above the room's noise gives the waveform its recording colour", async () => {
      const capture = new CountingCapture();
      const { controller } = makeController({ capture });
      const noise = 0.01;
      const louder = (decibels: number) => noise * 10 ** (decibels / 20);
      const listenTo = async (amplitude: number) => {
        const starts = capture.starts;
        controller.handle("start");
        expect(await eventually(() => capture.starts === starts + 1)).toBe(true);
        for (let reading = 0; reading < 10; reading += 1) capture.hearWindow(noise);
        expect(controller.isHearing).toBe(true);
        expect(controller.hasVoice).toBe(false);
        capture.hearWindow(amplitude);
      };

      await listenTo(louder(config.waveformVoiceAboveNoiseDecibels - 0.2));
      expect(controller.hasVoice).toBe(false);
      controller.handle("cancel");

      await listenTo(louder(config.waveformVoiceAboveNoiseDecibels + 0.2));
      expect(controller.hasVoice).toBe(true);
      capture.hearWindow(noise);
      expect(controller.hasVoice).toBe(true);
      controller.handle("cancel");

      await listenTo(noise);
      expect(controller.hasVoice).toBe(false);
      controller.handle("cancel");
    });

    /** With no name set, switching to agent mode shows the tip inviting one, until it switches back;
     * with a name, it never shows. It is never used up: every switch shows it again. */
    test("the name tip shows in agent mode while no name is set", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      controller.tipDisplayDuration = () => 60_000;
      new TipBook(tipStore).markLearned("agentAndHistory");

      prefs.value = { ...prefs.value, userName: "" };
      for (let hold = 0; hold < (config.agentAndHistoryTip.maxDisplays ?? 0) + 2; hold += 1) {
        controller.handle("start");
        expect(await eventually(() => controller.phase.kind === "listening" && controller.isHearing)).toBe(true);
        expect(controller.tip).toBeNull();
        controller.handle("toggleMode");
        expect(await eventually(() => controller.tip === "setName")).toBe(true);
        controller.handle("toggleMode");
        expect(controller.tip).toBeNull();
        controller.handle("cancel");
      }

      prefs.value = { ...prefs.value, userName: "Alex Example" };
      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening" && controller.isHearing)).toBe(true);
      controller.handle("toggleMode");
      expect(await throughout(300, () => controller.tip === null)).toBe(true);
      controller.handle("cancel");
    });

    /** Switched to agent mode before the pill listens, the name tip waits for it, as the other tips do;
     * switched back first, it never shows. */
    test("the name tip waits for the pill to listen, and goes with a switch back", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      controller.tipDisplayDuration = () => 60_000;
      new TipBook(tipStore).markLearned("agentAndHistory");
      prefs.value = { ...prefs.value, userName: "" };

      controller.handle("start");
      controller.handle("toggleMode");
      expect(controller.tip).toBeNull();
      expect(await eventually(() => controller.tip === "setName")).toBe(true);
      controller.handle("cancel");

      controller.handle("start");
      controller.handle("toggleMode");
      controller.handle("toggleMode");
      expect(await eventually(() => controller.phase.kind === "listening" && controller.isHearing)).toBe(true);
      expect(await throughout(300, () => controller.tip === null)).toBe(true);
      controller.handle("cancel");
    });

    /** The name tip goes by the name set at key-down: set or cleared while the hold runs, it changes
     * the tip from the next hold. */
    test("the name tip goes by the name set at key-down", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      controller.tipDisplayDuration = () => 60_000;
      new TipBook(tipStore).markLearned("agentAndHistory");

      async function switchDuringHold(nameMidHold: string): Promise<void> {
        controller.handle("start");
        expect(await eventually(() => controller.phase.kind === "listening" && controller.isHearing)).toBe(true);
        prefs.value = { ...prefs.value, userName: nameMidHold };
        controller.handle("toggleMode");
      }

      prefs.value = { ...prefs.value, userName: "" };
      await switchDuringHold("Alex Example");
      expect(await eventually(() => controller.tip === "setName")).toBe(true);
      controller.handle("cancel");

      await switchDuringHold("");
      expect(await throughout(300, () => controller.tip === null)).toBe(true);
      controller.handle("cancel");

      await switchDuringHold("");
      expect(await eventually(() => controller.tip === "setName")).toBe(true);
      controller.handle("cancel");
    });

    /** Hands-free, the name tip takes the hands-free tip's place for its display duration, and the
     * hands-free tip returns after it, or as soon as the dictation switches back. */
    test("hands-free, the name tip shows in turn with the hands-free tip", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      const nameTipDuration = 300;
      controller.tipDisplayDuration = (tip) => (tip === "setName" ? nameTipDuration : tipDetails[tip].displayDuration);
      prefs.value = { ...prefs.value, userName: "" };

      controller.handle("startHandsFree");
      controller.handle("listenHandsFree");
      expect(await eventually(() => controller.tip === "handsFree")).toBe(true);
      controller.handle("toggleMode");
      expect(controller.tip).toBe("setName");
      expect(await eventually(() => controller.tip === "handsFree")).toBe(true);
      expect(await throughout(nameTipDuration * 2, () => controller.tip === "handsFree")).toBe(true);

      controller.handle("toggleMode");
      expect(controller.tip).toBe("handsFree");
      controller.handle("toggleMode");
      expect(controller.tip).toBe("setName");
      controller.handle("toggleMode");
      expect(controller.tip).toBe("handsFree");
      controller.handle("cancel");
      expect(controller.tip).toBeNull();
    });

    /** A tip with a display duration keeps its turn: the name tip follows it, and it shows once. */
    test("the name tip waits for a timed tip showing", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      new TipBook(tipStore).markLearned("agentAndHistory");
      controller.doubleTapTipHoldDuration = 100;
      const doubleTapTipDuration = 400;
      controller.tipDisplayDuration = (tip) => (tip === "doubleTap" ? doubleTapTipDuration : 60_000);
      prefs.value = { ...prefs.value, userName: "" };

      controller.handle("start");
      expect(await eventually(() => controller.tip === "doubleTap")).toBe(true);
      controller.handle("toggleMode");
      expect(await throughout(doubleTapTipDuration / 2, () => controller.tip === "doubleTap")).toBe(true);
      expect(await eventually(() => controller.tip === "setName")).toBe(true);
      expect(await throughout(doubleTapTipDuration * 2, () => controller.tip === "setName")).toBe(true);
      expect(tipStore.get("tip.doubleTap.displays")).toBe(1);
      controller.handle("cancel");
    });

    /** A tip shows for its display duration, and goes away with the hold. */
    test("a tip shows for its display duration and goes with the hold", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      controller.tipDisplayDuration = () => 150;

      controller.handle("start");
      expect(await eventually(() => controller.tip === "agentAndHistory")).toBe(true);
      expect(await eventually(() => controller.tip === null)).toBe(true);
      expect(controller.phase).toEqual(listening);
      controller.handle("cancel");

      controller.tipDisplayDuration = () => 60_000;
      controller.handle("start");
      expect(await eventually(() => controller.tip === "agentAndHistory")).toBe(true);
      controller.handle("cancel");
      expect(controller.tip).toBeNull();
    });

    /** No tip over the warm-up swirl: it waits for the microphone's first audio. */
    test("no tip shows before the microphone is heard", async () => {
      const { controller } = makeController();

      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      expect(await throughout(300, () => controller.tip === null)).toBe(true);
      controller.handle("cancel");
    });

    /** A hold past `doubleTapTipHoldDuration` shows the double-tap tip; a shorter one never does. */
    test("a long hold shows the double-tap tip", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      controller.doubleTapTipHoldDuration = 800;
      controller.tipDisplayDuration = (tip) => (tip === "agentAndHistory" ? 50 : 60_000);

      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      controller.handle("cancel");
      expect(await throughout(1_000, () => controller.tip !== "doubleTap")).toBe(true);

      controller.handle("start");
      expect(await eventually(() => controller.tip === "doubleTap")).toBe(true);
      expect(controller.phase).toEqual(listening);
      controller.handle("cancel");
      expect(controller.tip).toBeNull();
    });

    /** A double tap listens at once, with no hold to wait for, until the hotkey is tapped again: then
     * it is transcribed, cleaned up and pasted like a hold. The double-tap tip is learned. */
    test("a hands-free dictation listens at once until finished", async () => {
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      controller.doubleTapTipHoldDuration = 100;
      controller.tipDisplayDuration = () => 50;

      controller.handle("startHandsFree");
      controller.handle("listenHandsFree");
      expect(controller.phase).toEqual(listening);
      expect(new TipBook(tipStore).isEligible("doubleTap")).toBe(false);
      expect(await throughout(400, () => controller.phase.kind === "listening" && controller.tip !== "doubleTap")).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => pastes.length === 1 && pastes[0] === cleaned && controller.phase.kind === "idle")).toBe(true);
    });

    /** A double tap carries on the first tap's recording: the microphone started at the first press is
     * not restarted, and the pill shows at once (owner, 2026-09-26: the double tap started slower than
     * a hold, as it restarted the microphone). */
    test("a double tap carries on the first tap's recording", async () => {
      const capture = new CountingCapture();
      const { controller } = makeController({ capture });

      controller.handle("start");
      controller.handle("finish");
      expect(controller.phase).toEqual(arming);
      controller.handle("startHandsFree");

      expect(controller.phase).toEqual(listening);
      expect(capture.starts).toBe(1);
      expect(new TipBook(tipStore).isEligible("doubleTap")).toBe(false);
      expect(await throughout(config.doubleTapWindow * 2, () => controller.phase.kind === "listening" && capture.stops === 0)).toBe(true);
      controller.handle("cancel");
    });

    /** A double tap after its first tap's microphone failed starts the microphone again, rather than
     * carrying on a recording that never started. */
    test("a double tap after a failed tap starts the microphone again", async () => {
      const capture = new CountingCapture();
      const { controller } = makeController({ capture });

      controller.handle("start");
      controller.handle("finish");
      capture.fail();
      // The second press, well inside the window the tap waits for it.
      await sleep(config.doubleTapWindow / 4);
      controller.handle("startHandsFree");

      expect(capture.events).toEqual(["start", "stop", "start"]);
      expect(controller.phase).toEqual(listening);
      controller.handle("cancel");
    });

    /** A double tap whose microphone fails after the second press shows the failure: by then the user
     * asked to dictate. */
    test("a double tap whose microphone fails shows it", async () => {
      const capture = new CountingCapture();
      const { controller } = makeController({ capture });

      controller.handle("start");
      controller.handle("finish");
      controller.handle("startHandsFree");
      expect(controller.phase).toEqual(listening);
      capture.fail();

      expect(await eventually(() => controller.phase.kind === "failed")).toBe(true);
      expect(controller.phase).toEqual(microphoneFailed);
    });

    /** A press while a double-tapped dictation is being transcribed leaves it alone: no new recording
     * starts, no tip shows, and its text is still pasted. So does another double tap. */
    test("a press while a double tap is transcribed leaves it alone", async () => {
      transcription.enqueue(200, cleanedReply);
      const capture = new CountingCapture(true);
      const { controller, pastes } = makeController({ capture });

      controller.handle("start");
      controller.handle("finish");
      controller.handle("startHandsFree");
      controller.handle("finish");
      expect(controller.phase).toEqual(transcribing);
      controller.handle("start");
      controller.handle("finish");
      controller.handle("startHandsFree");
      controller.handle("listenHandsFree");

      expect(controller.phase).toEqual(transcribing);
      expect(controller.tip).toBeNull();
      expect(capture.starts).toBe(1);
      expect(await eventually(() => pastes.length === 1 && pastes[0] === cleaned && controller.phase.kind === "idle")).toBe(true);
    });

    /** A lone tap whose microphone fails to start while the tap waits for a second press stays unseen,
     * as any lone tap does; a deliberate dictation's failure still shows. */
    test("a lone tap whose microphone fails stays unseen", async () => {
      const capture = new CountingCapture();
      const { controller, pastes } = makeController({ capture });
      const phases: Phase[] = [];
      controller.onPhaseChange = (phase) => phases.push(phase);

      controller.handle("start");
      controller.handle("finish");
      capture.fail();
      expect(await throughout(config.doubleTapWindow * 2, () => phases.every((phase) => phase.kind === "arming" || phase.kind === "idle"))).toBe(true);
      expect(controller.phase).toEqual(idle);
      expect(capture.events.at(-1)).toBe("stop");
      expect(transcription.requests).toHaveLength(0);
      expect(pastes).toEqual([]);

      controller.handle("startHandsFree");
      capture.fail();
      expect(await eventually(() => controller.phase.kind === "failed")).toBe(true);
      expect(controller.phase).toEqual(microphoneFailed);
    });

    /** A double-tapped dictation, tapped again, is transcribed, cleaned up and pasted like a hold. */
    test("a double-tapped dictation is pasted when tapped again", async () => {
      transcription.enqueue(200, cleanedReply);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });

      controller.handle("start");
      controller.handle("finish");
      controller.handle("startHandsFree");
      expect(controller.phase).toEqual(listening);
      controller.handle("finish");

      expect(await eventually(() => pastes.length === 1 && pastes[0] === cleaned && controller.phase.kind === "idle")).toBe(true);
    });

    /** A triple tap (ADR-DESK-043): the hands-free dictation the second tap started goes unseen, nothing
     * is sent, and the paste history is asked for. */
    test("a triple tap drops the hands-free dictation and shows the history", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      // Asked for while the hold still shows, so the history opens by its pill.
      const shownWhile: Phase["kind"][] = [];
      controller.onShowHistory = () => {
        shownWhile.push(controller.phase.kind);
      };

      controller.handle("start");
      controller.handle("finish");
      controller.handle("startHandsFree");
      controller.handle("listenHandsFree");
      controller.handle("showHistory");

      expect(shownWhile).toEqual(["listening"]);
      expect(controller.phase).toEqual(idle);
      await sleep(100);
      expect(transcription.requests).toHaveLength(0);
      // The next press dictates as ever.
      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      controller.handle("cancel");
    });

    /** The hands-free tip shows in a double-tapped dictation even when the microphone was already
     * heard during the first tap, before anything was shown, and stays until it stops listening. (It
     * took the Space tip's place in a double tap: owner, 2026-09-27.) */
    test("a double tap heard during the tap shows the hands-free tip", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });

      controller.handle("start");
      expect(await eventually(() => controller.isHearing)).toBe(true);
      expect(controller.phase).toEqual(arming);
      controller.handle("finish");
      controller.handle("startHandsFree");
      controller.handle("listenHandsFree");

      expect(await eventually(() => controller.tip === "handsFree")).toBe(true);
      expect(await throughout(300, () => controller.tip === "handsFree")).toBe(true);
      controller.handle("finish");
      expect(controller.tip).toBeNull();
    });

    /** Hands-free, the tip says how to end it (tap the hotkey, or Escape), the whole time it listens
     * and every time (owner, 2026-09-27): with no display duration, however often it has shown, a
     * mode switch or not, and in place of the Space tip. It goes when the dictation stops listening. */
    test("the hands-free tip shows the whole time, every time", async () => {
      expect(tipDetails.handsFree.displayDuration).toBeNull();
      const longestTimedTip = Math.max(...Object.values(tipDetails).map((details) => details.displayDuration ?? 0));
      const book = new TipBook(tipStore);
      for (let index = 0; index < (config.agentAndHistoryTip.maxDisplays ?? 0) + 5; index += 1) book.recordDisplay("handsFree");
      const { controller } = makeController({ capture: new CountingCapture(true) });

      for (let round = 0; round < 3; round += 1) {
        controller.handle("startHandsFree");
        controller.handle("listenHandsFree");
        expect(await eventually(() => controller.tip === "handsFree")).toBe(true);
        controller.handle("toggleMode");
        // Once, past the longest a timed tip shows.
        const window = round === 0 ? longestTimedTip + 500 : 400;
        expect(await throughout(window, () => controller.tip === "handsFree")).toBe(true);
        controller.handle("cancel");
        expect(controller.tip).toBeNull();
      }
    });

    /** The hands-free tip waits for the second tap's release (owner, 2026-09-27: "only once truly
     * hands-free"): a second press released as a tap shows it, and never the Space tip first, with
     * every tip fresh; one still held once a tap is over is a hold, with the hold's Space tip and no
     * hands-free tip. After a first tap, or as a fresh start; the microphone first heard once the
     * second press is down, so a tip already due would show at once. */
    test.each([true, false])("the hands-free tip shows only once the second press is a tap (after a tap: %s)", async (afterATap) => {
      const capture = new CountingCapture();
      const { controller } = makeController({ capture });
      expect(new TipBook(tipStore).isEligible("agentAndHistory")).toBe(true);
      const secondPress = () => {
        if (afterATap) {
          controller.handle("start");
          controller.handle("finish");
        }
        controller.handle("startHandsFree");
        capture.hear();
      };

      secondPress();
      controller.handle("listenHandsFree");
      expect(await throughout(config.minimumHoldDuration * 3, () => controller.tip !== "agentAndHistory")).toBe(true);
      expect(controller.tip).toBe("handsFree");
      controller.handle("cancel");

      secondPress();
      expect(await throughout(config.minimumHoldDuration / 2, () => controller.tip === null)).toBe(true);
      expect(await eventually(() => controller.tip === "agentAndHistory")).toBe(true);
      expect(await throughout(config.minimumHoldDuration * 3, () => controller.tip !== "handsFree")).toBe(true);
      controller.handle("finish");
      expect(controller.phase).toEqual(transcribing);
      // Nothing is sent after this test.
      controller.handle("cancel");
    });

    /** A second press canceled while down (a typing chord) leaves nothing for the next one: a newer
     * second press shows no tip until it has been down as long as a hold, even when the canceled one
     * would have become a hold before that; released as a tap, it gets the hands-free tip. */
    test("a canceled second press leaves no tip for the next one", async () => {
      const capture = new CountingCapture(true);
      const { controller, pastes } = makeController({ capture });
      const hold = config.minimumHoldDuration;

      controller.handle("startHandsFree");
      expect(await eventually(() => controller.isHearing)).toBe(true);
      await sleep(hold / 2);
      controller.handle("cancel");
      expect(controller.phase).toEqual(idle);
      const pressed = performance.now();
      controller.handle("startHandsFree");
      expect(controller.phase).toEqual(listening);
      // Past when the canceled press would have become a hold, short of when this one does.
      expect(await throughout((hold * 3) / 4, () => controller.tip === null || performance.now() - pressed >= hold)).toBe(true);

      controller.handle("listenHandsFree");
      expect(await eventually(() => controller.tip === "handsFree")).toBe(true);
      controller.handle("cancel");
      expect(controller.tip).toBeNull();
      expect(capture.starts).toBe(2);
      expect(capture.stops).toBe(2);
      expect(transcription.requests).toHaveLength(0);
      expect(completions.requests).toHaveLength(0);
      expect(pastes).toEqual([]);
    });

    /** A second press ended before it has been down as long as a hold (canceled, here) leaves no timer
     * of its own behind to act in whatever comes next. */
    test("a second press ended early leaves no timer behind", async () => {
      vi.useFakeTimers();
      const { controller } = makeController({ capture: new CountingCapture(true) });
      try {
        controller.handle("startHandsFree");
        await vi.advanceTimersByTimeAsync(config.minimumHoldDuration / 2);
        controller.handle("cancel");
        expect(controller.phase).toEqual(idle);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        controller.handle("cancel");
        vi.useRealTimers();
      }
    });

    /** A hands-free tip due before the microphone is first heard shows once it is, even when that is
     * after the time a held second press would have become a hold. */
    test("a hands-free tip due before the microphone is heard shows once it is", async () => {
      const capture = new CountingCapture();
      const { controller } = makeController({ capture });

      controller.handle("startHandsFree");
      controller.handle("listenHandsFree");
      expect(await throughout(config.minimumHoldDuration * 3, () => controller.tip === null)).toBe(true);
      capture.hear();

      expect(await eventually(() => controller.tip === "handsFree")).toBe(true);
      controller.handle("cancel");
    });

    /** A Space tip already up as the second press ends as a tap (a tap as long as a tap can be) gives
     * way to the hands-free tip. */
    test("a Space tip up as the second tap ends gives way to the hands-free tip", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      controller.tipDisplayDuration = (tip) => (tip === "agentAndHistory" ? 60_000 : tipDetails[tip].displayDuration);

      controller.handle("start");
      controller.handle("finish");
      controller.handle("startHandsFree");
      expect(await eventually(() => controller.tip === "agentAndHistory")).toBe(true);
      controller.handle("listenHandsFree");

      expect(controller.tip).toBe("handsFree");
      expect(await throughout(300, () => controller.tip === "handsFree")).toBe(true);
      controller.handle("cancel");
    });

    /** Every lone tap is discarded unseen, not only the first: none ever shows a pill or keeps the
     * microphone listening. */
    test("every lone tap is discarded unseen", async () => {
      const capture = new CountingCapture();
      const { controller } = makeController({ capture });

      for (let tap = 0; tap < 3; tap += 1) {
        controller.handle("start");
        controller.handle("finish");
        expect(await throughout(config.doubleTapWindow * 2, () => controller.phase.kind !== "listening")).toBe(true);
        expect(controller.phase).toEqual(idle);
        expect(capture.events.at(-1)).toBe("stop");
      }
    });

    /** A tap with no second press is discarded unseen once `doubleTapWindow` has passed; a hold that
     * follows a tap is a new recording. */
    test("a lone tap is discarded and a hold after it starts afresh", async () => {
      const capture = new CountingCapture();
      const { controller } = makeController({ capture });

      controller.handle("start");
      controller.handle("finish");
      expect(await throughout(config.minimumHoldDuration, () => controller.phase.kind === "arming")).toBe(true);
      expect(await eventually(() => controller.phase.kind === "idle")).toBe(true);

      controller.handle("start");
      controller.handle("finish");
      controller.handle("start");
      expect(capture.events).toEqual(["start", "stop", "start", "stop", "start"]);
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      controller.handle("cancel");
    });

    /** A double tap's second press released as a tap leaves the hotkey helper hands-free, keeping
     * Space and Escape from the app in front: when no hands-free dictation listens by then, the
     * controller says so, and only then. Here the press came while the last dictation was still
     * being transcribed, so it started nothing; released before or after that dictation ends. */
    test.each(["before", "after"] as const)("a double tap while the last dictation transcribes, released %s it ends, leaves nothing hands-free", async (release) => {
      transcription.enqueue(200, cleanedReply);
      let answer: () => void = () => {};
      transcription.gate = () => new Promise((resolve) => (answer = resolve));
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      let nothingListening = 0;
      controller.onNothingListening = () => {
        nothingListening += 1;
      };

      await holdAndRelease(controller);
      // The upload waits on `answer`.
      expect(await eventually(() => transcription.requests.length === 1)).toBe(true);
      controller.handle("startHandsFree");
      expect(controller.phase).toEqual(transcribing);
      if (release === "after") {
        answer();
        expect(await eventually(() => controller.phase.kind === "idle" && pastes.length === 1)).toBe(true);
      }
      controller.handle("listenHandsFree");
      expect(nothingListening).toBe(1);
      if (release === "before") {
        // The dictation being transcribed goes on, and is pasted.
        expect(controller.phase).toEqual(transcribing);
        answer();
        expect(await eventually(() => controller.phase.kind === "idle")).toBe(true);
      }
      expect(pastes).toEqual([cleaned]);
      expect(controller.tip).toBeNull();
    });

    /** A hands-free dictation that ended while its second press was still down (the menu, a lost
     * microphone) leaves nothing listening at that press's release; one still listening is not
     * ended by it. */
    test("a hands-free dictation ended before its second press is released leaves nothing hands-free", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      let nothingListening = 0;
      controller.onNothingListening = () => {
        nothingListening += 1;
      };

      controller.handle("startHandsFree");
      controller.handle("listenHandsFree");
      expect(controller.phase).toEqual(listening);
      expect(nothingListening).toBe(0);
      controller.handle("cancel");

      controller.handle("startHandsFree");
      controller.handle("cancel");
      controller.handle("listenHandsFree");
      expect(controller.phase).toEqual(idle);
      expect(nothingListening).toBe(1);
      expect(controller.tip).toBeNull();
    });

    /** A double tap whose dictation cannot start (no microphone access) fails at the second press:
     * its release finds nothing listening. */
    test("a double tap that fails to start leaves nothing hands-free", async () => {
      const { controller } = makeController({ microphone: "denied" });
      let nothingListening = 0;
      controller.onNothingListening = () => {
        nothingListening += 1;
      };

      controller.handle("startHandsFree");
      expect(controller.phase.kind).toBe("failed");
      controller.handle("listenHandsFree");
      expect(nothingListening).toBe(1);
    });

    /** Escape during a hands-free dictation: nothing is sent or pasted. */
    test("a hands-free dictation canceled sends nothing", async () => {
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });

      controller.handle("startHandsFree");
      controller.handle("listenHandsFree");
      expect(await eventually(() => controller.isHearing)).toBe(true);
      controller.handle("cancel");

      expect(controller.phase).toEqual(idle);
      await sleep(config.releaseTailDuration * 2);
      expect(transcription.requests).toHaveLength(0);
      expect(pastes).toEqual([]);
    });

    /** The microphone lost mid-recording (its helper exited) ends the dictation as the length cap
     * does: what it heard is transcribed and pasted (owner, 2026-09-27: "send what was said"). */
    test("a microphone lost while listening sends what was said", async () => {
      vi.useFakeTimers();
      transcription.enqueue(200, cleanedReply);
      const capture = new CountingCapture(true);
      const { controller, pastes } = makeController({ capture });
      try {
        controller.handle("start");
        await vi.advanceTimersByTimeAsync(config.minimumHoldDuration);
        expect(controller.phase).toEqual(listening);

        capture.lose();
        await vi.advanceTimersByTimeAsync(config.releaseTailDuration);
        expect(capture.events.at(-1)).toBe("stop");
        await vi.advanceTimersByTimeAsync(0);
        expect(transcription.requests).toHaveLength(1);
        expect(pastes).toEqual([cleaned]);
        expect(controller.phase).toEqual(idle);
      } finally {
        controller.handle("cancel");
        vi.useRealTimers();
      }
    });

    /** The paste is for its dictation: canceled before the paste reaches the system (it waits out a
     * helper restart after the loss), the dictation calls it off, so nothing is pasted (in agent
     * mode too); the next dictation's paste is its own. */
    test.each(["dictation", "agent"] as const)("a %s canceled while its paste waits calls the paste off", async (mode) => {
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, mode === "agent" ? reply("We ship on Friday.") : cleanedStream);
      const signals: AbortSignal[] = [];
      const { controller } = makeController({
        capture: new CountingCapture(true),
        paste: (_text, signal) => {
          signals.push(signal);
          return new Promise(() => {});
        },
      });
      if (mode === "agent") controller.captureContext = () => Promise.resolve(selectionScreen(""));

      await holdAndRelease(controller, mode);
      expect(await eventually(() => signals.length === 1)).toBe(true);
      expect(signals[0]?.aborted).toBe(false);
      controller.handle("cancel");
      expect(signals[0]?.aborted).toBe(true);

      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, mode === "agent" ? reply("We ship on Friday.") : cleanedStream);
      await holdAndRelease(controller, mode);
      expect(await eventually(() => signals.length === 2)).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      controller.handle("cancel");
    });

    /** Lost once released, during the release tail: what was heard is still transcribed and pasted,
     * not failed. */
    test("a microphone lost after release still sends what was said", async () => {
      vi.useFakeTimers();
      transcription.enqueue(200, cleanedReply);
      const capture = new CountingCapture(true);
      const { controller, pastes } = makeController({ capture });
      try {
        controller.handle("start");
        await vi.advanceTimersByTimeAsync(config.minimumHoldDuration);
        controller.handle("finish");
        capture.lose();
        await vi.advanceTimersByTimeAsync(config.releaseTailDuration);
        await vi.advanceTimersByTimeAsync(0);
        expect(transcription.requests).toHaveLength(1);
        expect(pastes).toEqual([cleaned]);
        expect(controller.phase).toEqual(idle);
      } finally {
        controller.handle("cancel");
        vi.useRealTimers();
      }
    });

    /** Lost before the hold was deliberate there is nothing to send: it fails as the microphone
     * does. A loss reported for an earlier dictation changes nothing. */
    test("a microphone lost before the hold is deliberate fails, and a stale loss is ignored", async () => {
      vi.useFakeTimers();
      const capture = new CountingCapture(true);
      const { controller, pastes } = makeController({ capture });
      try {
        controller.handle("start");
        capture.lose();
        await vi.advanceTimersByTimeAsync(config.minimumHoldDuration);
        expect(controller.phase).toEqual(microphoneFailed);
        expect(capture.events.at(-1)).toBe("stop");

        // The first hands-free dictation's microphone, lost only once the next one listens.
        controller.handle("startHandsFree");
        controller.handle("cancel");
        controller.handle("startHandsFree");
        const listened = capture.events.length;
        capture.lose(capture.starts - 1);
        await vi.advanceTimersByTimeAsync(config.minimumHoldDuration + config.releaseTailDuration);
        expect(controller.phase).toEqual(listening);
        expect(capture.events.length).toBe(listened);
        expect(transcription.requests).toHaveLength(0);
        expect(pastes).toEqual([]);
      } finally {
        controller.handle("cancel");
        vi.useRealTimers();
      }
    });

    /** Hands-free listening, which no key release ends, stops at `maxRecordingDuration`: the
     * microphone is released and what it heard is pasted, and the next dictation listens afresh. */
    test("a hands-free dictation stops at the length cap and is pasted", async () => {
      vi.useFakeTimers();
      transcription.enqueue(200, cleanedReply);
      const capture = new CountingCapture(true);
      const { controller, pastes } = makeController({ capture });
      try {
        controller.handle("startHandsFree");
        await vi.advanceTimersByTimeAsync(config.maxRecordingDuration - 1);
        expect(controller.phase).toEqual(listening);
        expect(capture.events).toEqual(["start"]);
        expect(transcription.requests).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1 + config.releaseTailDuration);
        // Released: stopped after its one start (a finish stops it once more as it tears down).
        expect(capture.starts).toBe(1);
        expect(capture.events.at(-1)).toBe("stop");
        await vi.advanceTimersByTimeAsync(0);
        expect(pastes).toEqual([cleaned]);
        expect(controller.phase).toEqual(idle);

        controller.handle("startHandsFree");
        await vi.advanceTimersByTimeAsync(1);
        expect(controller.phase).toEqual(listening);
        expect(capture.starts).toBe(2);
        expect(capture.events.at(-1)).toBe("start");
      } finally {
        controller.handle("cancel");
        vi.useRealTimers();
      }
    });
  });

  /** A long dictation, cut into chunks as it is recorded, each sent at once with its own cleanup
   * (ADR-DESK-049). */
  describe("a long dictation", () => {
    type ChunkReply = { status: number; body: unknown } | "network";

    /** The transcription backend of a long dictation. It tells a request's chunk by its audio (the
     * first audio it hears is chunk 0, the next chunk 1, a retry the same as before), and answers it
     * with `answer`, or "network" for a dropped connection. A request canceled while it waits fails,
     * as `liveTransport`'s does. */
    class ChunkBackend {
      private readonly audio: string[] = [];
      readonly sent: { chunk: number; attempt: number; signal: AbortSignal | undefined; authorization: string | undefined; body: Record<string, unknown> }[] = [];
      /** Requests neither answered nor canceled yet. */
      inFlight = 0;

      constructor(private readonly answer: (chunk: number, attempt: number) => Promise<ChunkReply> | ChunkReply) {}

      readonly transport: HTTPTransport = async (request) => {
        if (request.signal?.aborted) throw new TransportError("canceled");
        const body = JSON.parse(request.body) as Record<string, unknown>;
        const audio = String(body.audio);
        let chunk = this.audio.indexOf(audio);
        if (chunk === -1) chunk = this.audio.push(audio) - 1;
        const attempt = this.attempts(chunk);
        this.sent.push({ chunk, attempt, signal: request.signal, authorization: request.headers.Authorization, body });
        this.inFlight += 1;
        const reply = await new Promise<ChunkReply>((resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new TransportError("canceled")), { once: true });
          Promise.resolve(this.answer(chunk, attempt)).then(resolve, reject);
        }).finally(() => {
          this.inFlight -= 1;
        });
        if (reply === "network") throw new TransportError("network");
        return { status: reply.status, headers: {}, body: JSON.stringify(reply.body) };
      };

      /** How many chunks it has heard. */
      get chunks(): number {
        return this.audio.length;
      }

      /** How many requests carried chunk `chunk`. */
      attempts(chunk: number): number {
        return this.sent.filter((sent) => sent.chunk === chunk).length;
      }
    }

    /** Chunk `chunk`'s answer: heard as `raw <chunk>`, cleaned up to `Part <chunk>.`. */
    const part = (chunk: number): ChunkReply => ({ status: 200, body: { text: `raw ${chunk}`, cleaned_text: `Part ${chunk}.` } });
    const serverError: ChunkReply = { status: 502, body: { error: "transcription_failed" } };
    const refused: ChunkReply = { status: 400, body: { error: "invalid_audio" } };
    const never = (): Promise<ChunkReply> => new Promise(() => {});

    /** Speech of each of `seconds`, a one-and-a-half-second pause between them: a chunk each, cut at
     * the pause, as each has more than `chunkMinimumSpeech` of speech but the last. */
    function pausedSpeech(seed: number, ...seconds: number[]): Float32Array {
      const rand = random(seed);
      return concat(...seconds.flatMap((length, index) => (index === seconds.length - 1 ? [speech(length, rand)] : [speech(length, rand), room(1.5, rand)])));
    }

    function makeLong(backend: ChunkBackend, options: { chunkRetryDelays?: number[]; paste?: DictationDependencies["paste"]; account?: AccountModel } = {}): ReturnType<typeof makeController> & { capture: CountingCapture; phases: Phase[] } {
      const capture = new CountingCapture();
      const made = makeController({ capture, transcriptionTransport: backend.transport, paste: options.paste, account: options.account });
      made.controller.chunkRetryDelays = options.chunkRetryDelays ?? [1];
      made.controller.transcriptionRetryDelays = [1, 1];
      made.controller.transcriptionRetryNoticeDelay = 0;
      const phases: Phase[] = [];
      made.controller.onPhaseChange = (phase) => phases.push(phase);
      return { ...made, capture, phases };
    }

    /** Starts a dictation (agent mode: Space pressed once), waits for it to listen, and has the
     * microphone hear `audio`. */
    async function startHearing(controller: DictationController, capture: CountingCapture, audio: Float32Array, mode: DictationMode = "dictation"): Promise<void> {
      controller.handle("start");
      if (mode === "agent") controller.handle("toggleMode");
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      capture.feed(audio);
    }

    test("is sent in chunks while it is recorded, each with its cleanup, and pasted joined in order", async () => {
      const lastAnswered = deferred<void>();
      const backend = new ChunkBackend(async (chunk) => {
        // The first chunk answers last.
        if (chunk === 0) await lastAnswered.promise;
        if (chunk === 2) setTimeout(lastAnswered.resolve, 20);
        return part(chunk);
      });
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(1, 12, 0.5));
      // Cut at the pause and sent while the user goes on.
      expect(await eventually(() => backend.chunks === 1)).toBe(true);
      expect(controller.phase).toEqual(listening);
      capture.feed(pausedSpeech(2, 12, 5));
      expect(await eventually(() => backend.chunks === 2)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.chunks).toBe(3);
      expect(pastes).toEqual(["Part 0. Part 1. Part 2."]);
      expect(controller.phase).toEqual(idle);
      // Each chunk is a whole request: its cleanup goes with it.
      expect(backend.sent.every((sent) => sent.body.cleanup !== undefined)).toBe(true);
      expect(used).toEqual([["raw 0", "Part 0.", "raw 1", "Part 1.", "raw 2", "Part 2."]]);
    });

    /** Owner, 2026-10-03: "a final polished pass if time permits". Once its chunks are in, their
     * cleanups, joined, go through the cleanup prompt once more as a whole, with the dictation's cleanup
     * variables, and its reply is pasted. */
    test("is polished as a whole once its chunks are in, and the polish is pasted", async () => {
      prefs.value = { ...defaultSettings(), dictionary: ["Xyvora"] };
      completions.enqueue(200, reply("Part zero, part one and part two."));
      const backend = new ChunkBackend(part);
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(1, 12, 12, 5));
      expect(await eventually(() => backend.chunks === 2)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual(["Part zero, part one and part two."]);
      expect(controller.phase).toEqual(idle);
      expect(completions.requests).toHaveLength(1);
      const { role, content, dictation, ...variables } = completions.message(0) ?? {};
      expect({ role, content, dictation }).toEqual({ role: "system", content: "system_prompt_dictate_cleanup", dictation: "Part 0. Part 1. Part 2." });
      expect(variables).toEqual(backend.sent[0]?.body.cleanup);
      expect(variables.dictionary).toBe("Xyvora");
      expect(completions.body(0).disable_tools).toBe(true);
    });

    /** The polish is only if time permits: one that fails, comes back empty or takes longer than
     * `chunkPolishTimeout` leaves the chunks' cleanups, joined, to be pasted, and the dictation ends as
     * ever. One running out of time is canceled. */
    test.each([
      { outcome: "is refused", answer: (stub: StubTransport) => stub.enqueue(500, { error: "failed" }) },
      { outcome: "fails in its stream", answer: (stub: StubTransport) => stub.enqueue(200, Fixtures.completionsStream(JSON.stringify({ error: "failed" }))) },
      { outcome: "comes back empty", answer: (stub: StubTransport) => stub.enqueue(200, reply(" ")) },
      {
        outcome: "runs out of time",
        answer: (stub: StubTransport) => {
          stub.honorsCancel = true;
          stub.gate = () => new Promise(() => {});
        },
      },
    ])("a polish that $outcome leaves the chunks' cleanups pasted", async ({ outcome, answer }) => {
      answer(completions);
      const backend = new ChunkBackend(part);
      const { controller, capture, pastes } = makeLong(backend);
      controller.chunkPolishTimeout = 200;

      await startHearing(controller, capture, pausedSpeech(2, 12, 12, 5));
      expect(await eventually(() => backend.chunks === 2)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual(["Part 0. Part 1. Part 2."]);
      expect(controller.phase).toEqual(idle);
      expect(completions.requests).toHaveLength(1);
      if (outcome === "runs out of time") expect(completions.requests[0]?.signal?.aborted).toBe(true);
    });

    /** A cancel while the polish runs ends the dictation: nothing is pasted, and the polish's request
     * stops. */
    test("canceled while it is polished, it pastes nothing", async () => {
      completions.honorsCancel = true;
      completions.gate = () => new Promise(() => {});
      const backend = new ChunkBackend(part);
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(3, 12, 5));
      expect(await eventually(() => backend.chunks === 1)).toBe(true);
      controller.handle("finish");
      expect(await eventually(() => completions.requests.length === 1)).toBe(true);
      controller.handle("cancel");

      expect(await eventually(() => settled(controller))).toBe(true);
      await sleep(50);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(idle);
      expect(completions.requests[0]?.signal?.aborted).toBe(true);
    });

    /** Speech with no pause is cut anyway, and the next chunk starts before the cut: the words both
     * heard are kept once. */
    test("speech with no pause is cut with an overlap, and the overlap's words are pasted once", async () => {
      const texts = ["We met on Monday and agreed to ship the beta", "agreed to ship the beta on Friday."];
      const backend = new ChunkBackend((chunk) => ({ status: 200, body: { text: texts[chunk], cleaned_text: texts[chunk] } }));
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, speech(config.chunkMaxDuration / 1000 + 10, random(3)));
      expect(await eventually(() => backend.chunks === 1)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.chunks).toBe(2);
      expect(pastes).toEqual(["We met on Monday and agreed to ship the beta on Friday."]);
    });

    /** Nobody waits for a chunk while the user still dictates: a server error, a dropped connection,
     * the backend's own timeout or the speech model's rate limit is tried again, quietly. */
    test("a chunk failing while the user dictates is retried in the background until it answers", async () => {
      const failures: ChunkReply[] = [serverError, "network", { status: 504, body: { error: "transcription_timeout" } }, { status: 429, body: { error: "transcription_rate_limited" } }];
      const backend = new ChunkBackend((chunk, attempt) => (chunk === 0 ? (failures[attempt] ?? part(0)) : part(chunk)));
      const { controller, capture, pastes, phases } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(4, 12, 0.5));
      expect(await eventually(() => backend.attempts(0) === failures.length + 1)).toBe(true);
      expect(controller.phase).toEqual(listening);
      expect(controller.isRetrying).toBe(false);
      capture.feed(pausedSpeech(5, 4));
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual(["Part 0. Part 1."]);
      expect(controller.phase).toEqual(idle);
      expect(phases.some((phase) => phase.kind === "retrying")).toBe(false);
    });

    /** At the release, a chunk still failing gets the last tries one recording gets, with the pill's
     * retry note. */
    test("a chunk still failing at the release gets its last tries, with the retry note", async () => {
      const pill: { controller?: DictationController } = {};
      // It fails until the pill says it is retrying: only once the user released.
      const backend = new ChunkBackend((chunk) => (chunk === 0 && pill.controller?.isRetrying !== true ? serverError : part(chunk)));
      const made = makeLong(backend, { chunkRetryDelays: [20] });
      pill.controller = made.controller;

      await startHearing(made.controller, made.capture, pausedSpeech(6, 12, 3));
      expect(await eventually(() => backend.attempts(0) >= 2)).toBe(true);
      made.controller.handle("finish");

      expect(await eventually(() => settled(made.controller))).toBe(true);
      expect(made.pastes).toEqual(["Part 0. Part 1."]);
      expect(made.controller.phase).toEqual(idle);
      expect(made.phases).toContainEqual({ kind: "retrying", message: retryingMessage });
      // Once the retry answers, the pill shows the transcription going on again.
      expect(made.phases.slice(made.phases.findIndex((phase) => phase.kind === "retrying"))).toContainEqual(transcribing);
    });

    /** The retry note is for a transcription still failing: once every chunk answered, it is not
     * shown, however long the paste takes. */
    test("a retry that answers in time shows no retry note, even during a slow paste", async () => {
      const backend = new ChunkBackend((chunk, attempt) => (chunk === 1 && attempt === 0 ? serverError : part(chunk)));
      const pasted: string[] = [];
      const { controller, capture, phases } = makeLong(backend, {
        paste: async (text) => {
          await sleep(600);
          pasted.push(text);
        },
      });
      controller.transcriptionRetryNoticeDelay = 300;

      await startHearing(controller, capture, pausedSpeech(27, 12, 3));
      expect(await eventually(() => backend.chunks === 1)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller) && pasted.length === 1)).toBe(true);
      expect(pasted).toEqual(["Part 0. Part 1."]);
      expect(backend.attempts(1)).toBe(2);
      expect(phases.some((phase) => phase.kind === "retrying")).toBe(false);
      expect(controller.isRetrying).toBe(false);
    });

    /** While the user dictates, a chunk still failing waits the last of `chunkRetryDelays` between
     * tries, again and again: never a tight loop. */
    test("a chunk failing while the user dictates keeps waiting the last delay between tries", async () => {
      const backend = new ChunkBackend((chunk) => (chunk === 0 ? serverError : part(chunk)));
      const { controller, capture } = makeLong(backend, { chunkRetryDelays: [1, 100] });

      await startHearing(controller, capture, pausedSpeech(28, 12, 0.5));
      expect(await eventually(() => backend.attempts(0) >= 2)).toBe(true);
      await sleep(500);
      // About one try per 100 ms: never dozens.
      expect(backend.attempts(0)).toBeLessThanOrEqual(10);
      controller.handle("cancel");
      expect(await eventually(() => backend.inFlight === 0 && settled(controller))).toBe(true);
    });

    /** Only a server error, a dropped connection, the backend's timeout or the speech model's rate
     * limit is tried again while the user dictates: a refused chunk, or one over this account's own
     * rate limit, gives up at once. */
    test.each([
      ["refused", refused],
      ["over the account's rate limit", { status: 429, body: { error: "rate_limited" } } satisfies ChunkReply],
    ])("a chunk %s while the user dictates is not tried again", async (_name, reply) => {
      const backend = new ChunkBackend((chunk) => (chunk === 0 ? reply : part(chunk)));
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(29, 12, 0.5));
      expect(await eventually(() => backend.attempts(0) === 1 && backend.inFlight === 0)).toBe(true);
      await sleep(100);
      expect(backend.attempts(0)).toBe(1);
      capture.feed(pausedSpeech(30, 3));
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.attempts(0)).toBe(1);
      expect(pastes).toEqual([]);
      expect(controller.phase.kind).toBe("failed");
    });

    /** Agent mode reads the words on both sides of a long silence too. */
    test("agent mode is asked the words on both sides of a long silence", { timeout: 60_000 }, async () => {
      const texts = [
        "Write to the team that I think that one of the main points is the travel cost and the hotel.",
        "",
        "",
        "And also say that I think that one of the main points we missed is staffing.",
      ];
      const backend = new ChunkBackend((chunk) => ({ status: 200, body: { text: texts[chunk], cleaned_text: texts[chunk] } }));
      completions.enqueue(200, reply("Done."));
      const { controller, capture } = makeLong(backend);
      const rand = random(31);

      await startHearing(controller, capture, concat(speech(12, rand), room(1.5, rand), room(240, rand), speech(5, rand)), "agent");
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.chunks).toBe(4);
      expect(completionsVars(0)?.user_request).toBe(`${texts[0]} ${texts[3]}`);
      // Agent mode reads the transcript: nothing is polished.
      expect(completions.requests.map((_, index) => completions.message(index)?.content)).not.toContain("system_prompt_dictate_cleanup");
    });

    /** Speech much softer than the speech before it (the user leaning back, or speaking low) is
     * still sent and pasted: no chunk is judged by its loudness alone (owner, 2026-10-03). */
    test("a soft stretch after loud speech is sent and pasted with the rest", { timeout: 120_000 }, async () => {
      const backend = new ChunkBackend(part);
      const { controller, capture, pastes } = makeLong(backend);
      const rand = random(43);

      // 30 s close to the microphone, a pause, two minutes 28 dB softer (still well above the room),
      // a pause, and 12 s close again.
      await startHearing(controller, capture, concat(speech(30, rand, 0.25), room(1.5, rand), speech(120, rand, 0.01), room(1.5, rand), speech(12, rand, 0.25)));
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.chunks).toBeGreaterThanOrEqual(3);
      expect(pastes).toEqual([Array.from({ length: backend.chunks }, (_, chunk) => `Part ${chunk}.`).join(" ")]);
      expect(controller.phase).toEqual(idle);
    });

    /** A chunk refused after the release gives up at once, as while recording: only a server error,
     * a dropped connection or the backend's timeout is tried again. */
    test("the last chunk refused after the release is not tried again", async () => {
      const backend = new ChunkBackend((chunk) => (chunk === 1 ? refused : part(chunk)));
      const { controller, capture, pastes, phases } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(40, 12, 4));
      expect(await eventually(() => backend.chunks === 1)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.attempts(1)).toBe(1);
      expect(phases.some((phase) => phase.kind === "retrying")).toBe(false);
      expect(pastes).toEqual(["Part 0."]);
    });

    /** Once a chunk gave up, the chunks after it are canceled before the text is pasted, not after. */
    test("the chunks after one that gave up are canceled before the paste", async () => {
      const sent: { backend?: ChunkBackend } = {};
      // Chunk 1 gives up once the last chunk is on its way, which never answers.
      const backend = new ChunkBackend(async (chunk) => {
        if (chunk === 1) {
          await eventually(() => (sent.backend?.attempts(2) ?? 0) > 0);
          return refused;
        }
        return chunk === 2 ? never() : part(chunk);
      });
      sent.backend = backend;
      const abortedAtPaste: boolean[] = [];
      const { controller, capture } = makeLong(backend, {
        paste: async () => {
          abortedAtPaste.push(backend.sent.filter((sent) => sent.chunk === 2).every((sent) => sent.signal?.aborted === true));
        },
      });

      await startHearing(controller, capture, pausedSpeech(41, 12, 12, 4));
      expect(await eventually(() => backend.chunks === 2)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller) && abortedAtPaste.length === 1)).toBe(true);
      expect(backend.attempts(2)).toBeGreaterThan(0);
      expect(abortedAtPaste).toEqual([true]);
    });

    /** A chunk waiting to be tried again while the user dictates is tried at once on the release:
     * the user waits for it now. */
    test("the release cuts a chunk's wait short: its last tries start at once", async () => {
      const backend = new ChunkBackend((chunk, attempt) => (chunk === 0 && attempt === 0 ? serverError : part(chunk)));
      const { controller, capture, pastes } = makeLong(backend, { chunkRetryDelays: [60_000] });

      await startHearing(controller, capture, pausedSpeech(17, 12, 3));
      expect(await eventually(() => backend.attempts(0) === 1 && backend.inFlight === 0)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual(["Part 0. Part 1."]);
      expect(backend.attempts(0)).toBe(2);
    });

    /** Owner, 2026-10-03: "we should not lose the end". The last chunk is sent at the release, so
     * the backend's own timeout on it, or the speech model's rate limit outlasting the backend's
     * retries, comes after the release: it is tried again, as while recording. */
    test.each([
      ["timing out on the backend", { status: 504, body: { error: "transcription_timeout" } } satisfies ChunkReply],
      ["rate limited by the speech model", { status: 429, body: { error: "transcription_rate_limited" } } satisfies ChunkReply],
    ])("the last chunk %s after the release is tried again, and the end is pasted", async (_name, failure) => {
      const backend = new ChunkBackend((chunk, attempt) => (chunk === 1 && attempt < 2 ? failure : part(chunk)));
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(16, 12, 4));
      expect(await eventually(() => backend.chunks === 1)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual(["Part 0. Part 1."]);
      expect(backend.attempts(1)).toBe(3);
    });

    /** Owner, 2026-10-03: "we definitely need more retries … we should not lose the end". The
     * provider's rate limits come in bursts of seconds: the last tries span about a minute. */
    test("the last tries after the release outlast a burst of rate limits", () => {
      const total = config.transcriptionRetryDelays.reduce((sum, delay) => sum + delay, 0);
      expect(total).toBeGreaterThanOrEqual(45_000);
      expect(config.transcriptionRetryDelays.length).toBeGreaterThanOrEqual(6);
    });

    /** Owner, 2026-10-03: "paste only the up to successful part". The chunks after the first that
     * gave up are not pasted either: the text would have a hole. */
    test.each([
      { lost: "a middle chunk refused", answer: (chunk: number) => (chunk === 1 ? refused : part(chunk)), pasted: "Part 0." },
      { lost: "the last chunk failing on every try", answer: (chunk: number) => (chunk === 2 ? serverError : part(chunk)), pasted: "Part 0. Part 1." },
    ])("$lost: the chunks before it are pasted, and the pill says the end is missing", async ({ answer, pasted }) => {
      const backend = new ChunkBackend(answer);
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(7, 12, 12, 4));
      expect(await eventually(() => backend.chunks === 2)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual([pasted]);
      expect(controller.phase).toEqual(failed(partlyTranscribedMessage));
      // The text pasted is polished when it is of two chunks or more (this backend's polish fails).
      expect(completions.requests.map((_, index) => completions.message(index)?.dictation)).toEqual(pasted === "Part 0." ? [] : [pasted]);
    });

    /** The chunks after the first that gave up are no longer needed: their requests stop. */
    test("a chunk giving up cancels the requests of the chunks after it", async () => {
      const backend = new ChunkBackend((chunk) => (chunk === 1 ? refused : chunk === 2 ? never() : part(chunk)));
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(18, 12, 12, 4));
      expect(await eventually(() => backend.chunks === 2)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual(["Part 0."]);
      expect(await eventually(() => backend.inFlight === 0)).toBe(true);
      expect(backend.sent.filter((sent) => sent.chunk === 2).every((sent) => sent.signal?.aborted === true)).toBe(true);
    });

    /** Copied instead of pasted (the user switched apps, ADR-DESK-042), the text still says its end
     * is missing. */
    test("a dictation whose end was lost and that is copied, as the user switched apps, says the end is missing", async () => {
      const backend = new ChunkBackend((chunk) => (chunk === 1 ? refused : part(chunk)));
      const { controller, capture, pastes, copies } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(19, 12, 12, 4));
      expect(await eventually(() => backend.chunks === 2)).toBe(true);
      front.pid = 202;
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual([]);
      expect(copies).toEqual(["Part 0."]);
      expect(controller.phase).toEqual({ kind: "copied", message: partlyCopiedMessage });
    });

    /** A long silence (hands-free, the user away) is cut into chunks the model hears nothing in; the
     * chunk after them overlaps a silent one, not the speech before the silence, so no word on either
     * side of the silence is lost however the two texts read. */
    test("the words on both sides of a long silence are all pasted", { timeout: 60_000 }, async () => {
      // The two silent chunks between the remarks are heard as nothing.
      const texts = [
        "We should meet next week to talk about the budget. I think that one of the main points is the travel cost and the hotel.",
        "",
        "",
        "Okay, back again. I think that one of the main points we missed is staffing, so let us add it.",
      ];
      const backend = new ChunkBackend((chunk) => ({ status: 200, body: { text: texts[chunk], cleaned_text: texts[chunk] } }));
      const { controller, capture, pastes } = makeLong(backend);
      const rand = random(20);

      await startHearing(controller, capture, concat(speech(12, rand), room(1.5, rand), room(240, rand), speech(5, rand)));
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.chunks).toBe(4);
      expect(pastes).toEqual([`${texts[0]} ${texts[3]}`]);
      expect(controller.phase).toEqual(idle);
    });

    /** Space can switch to agent mode and back at any time during the hold, after the first chunk was
     * sent too: every chunk takes the cleanup, and a dictation is pasted cleaned up. */
    test("a dictation switched to agent mode and back after its first chunk is still pasted cleaned up", async () => {
      const backend = new ChunkBackend(part);
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(21, 12, 0.5), "agent");
      expect(await eventually(() => backend.chunks === 1)).toBe(true);
      controller.handle("toggleMode");
      expect(controller.mode).toBe("dictation");
      capture.feed(pausedSpeech(22, 4));
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.sent.map((sent) => sent.body.cleanup !== undefined)).toEqual([true, true]);
      expect(pastes).toEqual(["Part 0. Part 1."]);
    });

    /** Each dictation pastes its own chunks only, and its chunks are retried quietly while it is
     * recorded, however many dictations came before on the same controller. */
    test("a second long dictation pastes only its own chunks, retried quietly while recording", async () => {
      // Chunks 2 and 3 are the second dictation's; chunk 2 fails more times than the release's last tries.
      const backend = new ChunkBackend((chunk, attempt) => (chunk === 2 && attempt < 3 ? serverError : part(chunk)));
      const { controller, capture, pastes, phases } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(23, 12, 4));
      controller.handle("finish");
      expect(await eventually(() => settled(controller) && pastes.length === 1)).toBe(true);
      const second = phases.length;
      await startHearing(controller, capture, pausedSpeech(24, 12, 0.5));
      expect(await eventually(() => backend.attempts(2) === 4)).toBe(true);
      capture.feed(pausedSpeech(25, 4));
      controller.handle("finish");

      expect(await eventually(() => settled(controller) && pastes.length === 2)).toBe(true);
      expect(pastes).toEqual(["Part 0. Part 1.", "Part 2. Part 3."]);
      expect(phases.slice(second).some((phase) => phase.kind === "retrying")).toBe(false);
      expect(controller.phase).toEqual(idle);
    });

    /** A dictation ending late (its paste returning after a cancel and the next dictation's start)
     * never cancels or cuts short the chunks of the dictation that followed it. */
    test("an earlier long dictation ending late leaves the next one's chunks alone", async () => {
      const firstPaste = deferred<void>();
      const pasted: string[] = [];
      const backend = new ChunkBackend(part);
      const { controller, capture } = makeLong(backend, {
        paste: async (text) => {
          if (pasted.length === 0) {
            pasted.push(text);
            await firstPaste.promise;
            return;
          }
          pasted.push(text);
        },
      });

      await startHearing(controller, capture, pausedSpeech(44, 12, 4));
      controller.handle("finish");
      expect(await eventually(() => pasted.length === 1)).toBe(true);
      controller.handle("cancel");
      expect(await eventually(() => controller.phase.kind === "idle")).toBe(true);
      await startHearing(controller, capture, pausedSpeech(45, 12, 0.5));
      expect(await eventually(() => backend.chunks === 3)).toBe(true);
      firstPaste.resolve();
      await sleep(50);
      capture.feed(pausedSpeech(46, 4));
      controller.handle("finish");

      expect(await eventually(() => settled(controller) && pasted.length === 2)).toBe(true);
      expect(pasted).toEqual(["Part 0. Part 1.", "Part 2. Part 3."]);
      expect(controller.phase).toEqual(idle);
    });

    /** A canceled long dictation whose last chunk ends late (its sign-in refresh, which no cancel
     * stops, returning once the next dictation has started) leaves that dictation's upload alone:
     * the next, a request in agent mode, is sent without the cleanup it does not use. */
    test("a canceled long dictation ending late leaves the next one's upload alone", async () => {
      const account = signedIn(auth);
      const validToken = account.validToken.bind(account);
      const refreshed = deferred<void>();
      let holding = false;
      let held = 0;
      account.validToken = async (forceRefresh) => {
        if (holding) {
          held += 1;
          await refreshed.promise;
        }
        return validToken(forceRefresh);
      };
      const backend = new ChunkBackend(part);
      const { controller, capture } = makeLong(backend, { account });

      await startHearing(controller, capture, pausedSpeech(47, 12, 12, 0.5));
      expect(await eventually(() => backend.chunks === 2)).toBe(true);
      holding = true;
      controller.handle("finish");
      expect(await eventually(() => held === 1)).toBe(true);
      holding = false;
      controller.handle("cancel");
      expect(await eventually(() => controller.phase.kind === "idle")).toBe(true);
      await startHearing(controller, capture, speech(3, random(48)), "agent");
      refreshed.resolve();
      await sleep(50);
      controller.handle("finish");

      expect(await eventually(() => settled(controller) && backend.chunks === 3)).toBe(true);
      expect(backend.sent.at(-1)?.chunk).toBe(2);
      expect(backend.sent.at(-1)?.body.cleanup).toBeUndefined();
    });

    /** The user signed out and into another account during a long dictation: its later chunks are
     * not sent under the other account (ADR-DESK-008), and the chunks before are pasted. */
    test("an account switch while it is recorded sends no later chunk under the other account", async () => {
      const account = signedIn(auth);
      auth.enqueue(200, Fixtures.sessionJSON({ access: "access-b", refresh: "refresh-b", userID: "user-2" }));
      const backend = new ChunkBackend(async (chunk) => {
        if (chunk === 0) {
          account.signOut();
          await account.verify(Fixtures.email, "123456");
        }
        return part(chunk);
      });
      const { controller, capture, pastes } = makeLong(backend, { account });

      await startHearing(controller, capture, pausedSpeech(49, 12, 0.5));
      expect(await eventually(() => backend.attempts(0) === 1 && account.session?.userID === "user-2")).toBe(true);
      capture.feed(pausedSpeech(50, 4));
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.sent.map((sent) => sent.authorization)).toEqual(["Bearer access-1"]);
      expect(pastes).toEqual(["Part 0."]);
      expect(controller.phase).toEqual(failed(partlyTranscribedMessage));
    });

    /** The user signed out and into another account as the last chunk answered: the polish is not
     * sent under the other account, and the chunks' cleanups are pasted. */
    test("an account switch before the polish sends it under no other account", async () => {
      const account = signedIn(auth);
      auth.enqueue(200, Fixtures.sessionJSON({ access: "access-b", refresh: "refresh-b", userID: "user-2" }));
      completions.enqueue(200, reply("Polished under the other account."));
      const backend = new ChunkBackend(async (chunk) => {
        if (chunk === 2) {
          account.signOut();
          await account.verify(Fixtures.email, "123456");
        }
        return part(chunk);
      });
      const { controller, capture, pastes } = makeLong(backend, { account });

      await startHearing(controller, capture, pausedSpeech(51, 12, 12, 5));
      expect(await eventually(() => backend.chunks === 2)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(account.session?.userID).toBe("user-2");
      expect(backend.sent.map((sent) => sent.authorization)).toEqual(["Bearer access-1", "Bearer access-1", "Bearer access-1"]);
      expect(completions.authorizations).toEqual([]);
      expect(pastes).toEqual(["Part 0. Part 1. Part 2."]);
      expect(controller.phase).toEqual(idle);
    });

    /** Each chunk is raised to the same peak on its own (ADR-DESK-040): a quiet stretch is not
     * left quiet beside a loud one. */
    test("each chunk is peak-normalized on its own", async () => {
      const backend = new ChunkBackend(part);
      const { controller, capture } = makeLong(backend);
      const rand = random(26);

      await startHearing(controller, capture, concat(speech(12, rand, 0.05), room(1.5, rand), speech(4, rand, 0.4)));
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.chunks).toBe(2);
      const peaks = backend.sent.map((sent) => {
        const pcm = decodeFLAC(new Uint8Array(Buffer.from(String(sent.body.audio), "base64"))).pcm;
        const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        let peak = 0;
        for (let index = 0; index < pcm.length / 2; index += 1) peak = Math.max(peak, Math.abs(view.getInt16(index * 2, true)));
        return peak;
      });
      const target = Math.round(0x7fff * 10 ** (config.normalizedPeakDecibels / 20));
      expect(peaks).toEqual([target, target]);
    });

    /** Owner, 2026-10-03: "if it continuously fails completely, paste nothing". */
    test("the first chunk failing on every try loses the dictation: nothing is pasted", async () => {
      const backend = new ChunkBackend((chunk) => (chunk === 0 ? serverError : part(chunk)));
      const { controller, capture, pastes, phases } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(8, 12, 4));
      expect(await eventually(() => backend.attempts(0) >= 2)).toBe(true);
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(failed("Dictation failed. Please try again."));
      expect(phases).toContainEqual({ kind: "retrying", message: retryingMessage });
    });

    test.each(["while recording", "after the release"])("canceled %s: every chunk's request is canceled and nothing is pasted", async (when) => {
      const backend = new ChunkBackend(never);
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(9, 12, 12, 4));
      expect(await eventually(() => backend.chunks === 2)).toBe(true);
      if (when === "after the release") {
        controller.handle("finish");
        expect(await eventually(() => backend.chunks === 3)).toBe(true);
      }
      controller.handle("cancel");

      expect(await eventually(() => backend.sent.every((sent) => sent.signal?.aborted === true))).toBe(true);
      expect(await eventually(() => backend.inFlight === 0)).toBe(true);
      expect(await eventually(() => settled(controller))).toBe(true);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(idle);
    });

    /** Agent mode carries out a request whole or not at all: half of it may ask for something else. */
    test("agent mode carries out nothing of a request whose end was lost", async () => {
      const backend = new ChunkBackend((chunk) => (chunk === 1 ? refused : part(chunk)));
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, pausedSpeech(10, 12, 4), "agent");
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.chunks).toBe(2);
      // The chunks take the cleanup in agent mode too (the user may switch back); its text is unused.
      expect(backend.sent.every((sent) => sent.body.cleanup !== undefined)).toBe(true);
      expect(completions.requests).toHaveLength(0);
      expect(pastes).toEqual([]);
      expect(controller.phase.kind).toBe("failed");
      expect(controller.phase).not.toEqual(failed(partlyTranscribedMessage));
    });

    /** A chunk of nothing but the room (the quiet after the last words) is sent too: the model
     * decides, as for one recording (no loudness gate, ADR-DESK-005). */
    test("a last chunk of nothing but the room is sent, and the model's nothing adds nothing", async () => {
      const backend = new ChunkBackend((chunk) => (chunk === 1 ? { status: 200, body: { text: "", cleaned_text: null } } : part(chunk)));
      const { controller, capture, pastes } = makeLong(backend);
      const rand = random(11);

      await startHearing(controller, capture, concat(speech(12, rand), room(1.5, rand), room(4, rand)));
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.sent.map((sent) => sent.chunk)).toEqual([0, 1]);
      expect(pastes).toEqual(["Part 0."]);
      expect(controller.phase).toEqual(idle);
    });

    /** A long recording of nothing but the room is sent, every chunk of it: the model decides. */
    test("a long recording of nothing but the room is sent, and nothing is heard", async () => {
      const backend = new ChunkBackend(() => ({ status: 200, body: { text: "", cleaned_text: null } }));
      const { controller, capture, pastes } = makeLong(backend);

      await startHearing(controller, capture, room(config.chunkMaxDuration / 1000 + 2, random(12)));
      controller.handle("finish");

      expect(await eventually(() => settled(controller))).toBe(true);
      expect(backend.sent).toHaveLength(2);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(failed(nothingHeardMessage));
    });

    /** Testing rule 11: seeded long dictations of random chunks, each refused, down for good, or
     * failing a few times by server error or dropped connection, at random latencies, fed in packets
     * that interleave with the answers. Whatever the order things happen in, what is pasted is
     * exactly the chunks before the first lost one, joined in order. */
    test("random chunk failures and timings paste exactly the chunks before the first lost one", { timeout: 120_000 }, async () => {
      for (let seed = 1; seed <= 8; seed += 1) {
        const rand = random(seed);
        const count = 2 + Math.floor(rand() * 4);
        const fates = Array.from({ length: count }, (): "refused" | "down" | number => {
          const fate = rand();
          return fate < 0.12 ? "refused" : fate < 0.24 ? "down" : Math.floor(rand() * 3);
        });
        const timing = random(seed * 7_919);
        const backend = new ChunkBackend(async (chunk, attempt) => {
          await sleep(timing() * 15);
          const fate = fates[chunk];
          if (fate === "refused") return refused;
          if (fate === "down") return serverError;
          if (fate !== undefined && attempt < fate) return timing() < 0.5 ? serverError : "network";
          return part(chunk);
        });
        const { controller, capture, pastes } = makeLong(backend);
        const audio = pausedSpeech(seed * 31, ...Array.from({ length: count }, (_, index) => (index === count - 1 ? 2 + rand() * 5 : 11 + rand() * 8)));

        await startHearing(controller, capture, new Float32Array(0));
        for (let offset = 0; offset < audio.length; offset += config.audioChunkFrames * 40) {
          capture.feed(audio.subarray(offset, offset + config.audioChunkFrames * 40));
          await sleep(timing() * 3);
        }
        controller.handle("finish");

        expect(await eventually(() => settled(controller)), `seed ${seed}`).toBe(true);
        const lost = fates.findIndex((fate) => typeof fate === "string");
        // Every chunk up to the first lost one was sent; the ones after it may be canceled first.
        if (lost === -1) expect(backend.chunks, `seed ${seed}`).toBe(count);
        else expect(backend.chunks, `seed ${seed}`).toBeGreaterThanOrEqual(lost + 1);
        const kept = Array.from({ length: lost === -1 ? count : lost }, (_, chunk) => `Part ${chunk}.`);
        if (lost === -1) {
          expect(pastes, `seed ${seed}`).toEqual([kept.join(" ")]);
          expect(controller.phase, `seed ${seed}`).toEqual(idle);
        } else if (lost === 0) {
          expect(pastes, `seed ${seed}`).toEqual([]);
          expect(controller.phase.kind, `seed ${seed}`).toBe("failed");
          expect(controller.phase, `seed ${seed}`).not.toEqual(failed(partlyTranscribedMessage));
        } else {
          expect(pastes, `seed ${seed}`).toEqual([kept.join(" ")]);
          expect(controller.phase, `seed ${seed}`).toEqual(failed(partlyTranscribedMessage));
        }
        // Nothing is left running once it is done.
        expect(await eventually(() => backend.inFlight === 0), `seed ${seed}`).toBe(true);
      }
    });
  });
});
