// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AccountModel } from "../src/core/account.js";
import { RelayFailure } from "../src/core/agent/thunderbirdRelay.js";
import { AgentFailure, type AgentTool } from "../src/core/agent/tools.js";
import { BackendError, CompletionsClient, TranscriptionClient } from "../src/core/backend.js";
import * as config from "../src/core/config.js";
import { DictationController, nothingHeardMessage, type Phase } from "../src/core/dictationController.js";
import type { DictationMode } from "../src/core/hotkey.js";
import { MemoryStore } from "../src/core/keyValueStore.js";
import { type MicrophoneStatus, PermissionsModel } from "../src/core/permissions.js";
import type { ScreenContext } from "../src/core/screenContext.js";
import type { DictationSettings } from "../src/core/settings.js";
import { TipBook, tipDetails } from "../src/core/tips.js";
import { sleep } from "../src/core/timeout.js";
import { encodeWAV } from "../src/core/wav.js";
import { type HTTPTransport, liveTransport } from "../src/core/http.js";
import { FakeThunderbird } from "./fakeThunderbird.js";
import { screen as blankScreen } from "./screens.js";
import { CountingCapture, deferred, eventually, Fixtures, loggedContent, signedIn, StubTransport } from "./support.js";

const transcript = "ask jordan about the road map";
const cleaned = "Ask Jordan about the roadmap.";
const request = "make this friendlier";
const cleanedStream = Fixtures.reply(cleaned);
const reply = Fixtures.reply;

const idle: Phase = { kind: "idle" };
const arming: Phase = { kind: "arming" };
const listening: Phase = { kind: "listening" };
const transcribing: Phase = { kind: "transcribing" };
const running = (tool: AgentTool): Phase => ({ kind: "running", tool });
const failed = (message: string): Phase => ({ kind: "failed", message });
const appChanged = new AgentFailure("appChanged").message;
const microphoneFailed = failed("Couldn't start the microphone.");

function defaultSettings(): DictationSettings {
  return { hasConsented: true, hotkey: "rightOption", backendURL: "https://api.example.com", readsScreen: true, emailClient: FakeThunderbird.app, hasTabMail: true };
}

/** A screen with `sentinel` in its app name and text. */
function screen(sentinel: string): ScreenContext {
  return blankScreen({ appName: `Example Notes ${sentinel}`, windowTitle: "Weekly sync", renderedText: `Agenda ${sentinel}` });
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

/** Done: idle or failed. */
function settled(controller: DictationController): boolean {
  return controller.phase.kind === "idle" || controller.phase.kind === "failed";
}

/** The content-log steps of the controller and the agent, without the backend clients' own entries. */
function steps(entries: { label: string; text: string }[]): { label: string; text: string }[] {
  return entries.filter((entry) => !entry.label.startsWith("Transcription ") && !entry.label.startsWith("Completions "));
}

/** A finished recording through the controller: transcription, cleanup with the screen context, and
 * what gets pasted. A stub paste and never the network. */
describe("DictationController", { timeout: 20_000 }, () => {
  let transcription: StubTransport;
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

  beforeEach(() => {
    transcription = new StubTransport();
    completions = new StubTransport();
    auth = new StubTransport();
    front = { pid: 101 };
    keyboard = { language: null, atReveal: [] };
    prefs = { value: defaultSettings() };
    tipStore = new MemoryStore();
  });

  /** A controller with both grants and the user's consent, signed in to `account`, on the stub
   * backend. Thunderbird is not installed unless a test passes one. */
  function makeController(
    options: { account?: AccountModel; capture?: CountingCapture; thunderbird?: FakeThunderbird; microphone?: MicrophoneStatus; accessibility?: boolean; transcriptionTransport?: HTTPTransport; frontmostApp?: () => Promise<number | null>; paste?: (text: string, signal: AbortSignal) => Promise<void> } = {},
  ): { controller: DictationController; pastes: string[] } {
    const pastes: string[] = [];
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
      paste:
        options.paste ??
        (async (text) => {
          pastes.push(text);
        }),
      thunderbird: thunderbird.relay(),
      capture: options.capture ?? new CountingCapture(),
      frontmostApp: options.frontmostApp ?? (async () => front.pid),
      keyboardLanguage: async () => keyboard.language,
      systemEmailApp: async () => null,
      makeTranscriptionClient: (url) => new TranscriptionClient(url, "test", options.transcriptionTransport ?? transcription.transport),
      makeCompletionsClient: (url) => new CompletionsClient(url, "test", completions.transport),
    });
    return { controller, pastes };
  }

  /** Runs one recording through the controller; returns what was pasted. */
  async function dictate(account?: AccountModel): Promise<{ pasted: string[]; controller: DictationController }> {
    const { controller, pastes } = makeController({ account });
    await controller.transcribe(encodeWAV(new Uint8Array([0, 0, 1, 0]), 16_000), 0);
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

  /** The variables of the `index`th completions request. */
  function cleanupVars(index: number): Record<string, unknown> | undefined {
    return completions.message(index);
  }

  function hosts(stub: StubTransport): string[] {
    return stub.requests.map((request) => new URL(request.url).host);
  }

  /** The `language` of each transcription request (null: none sent). */
  function transcriptionLanguages(): (string | null)[] {
    return transcription.requests.map((_, index) => (transcription.body(index).language as string | undefined) ?? null);
  }

  test("pastes the cleaned-up transcript", async () => {
    transcription.enqueue(200, { text: transcript });
    completions.enqueue(200, cleanedStream);

    const { pasted, controller } = await dictate();

    expect(pasted).toEqual([cleaned]);
    expect(controller.phase).toEqual(idle);
    expect(completions.requests).toHaveLength(1);
    expect(cleanupVars(0)?.dictation).toBe(transcript);
    expect(transcription.authorizations).toEqual(["Bearer access-1"]);
    expect(completions.authorizations).toEqual(["Bearer access-1"]);
  });

  test("pastes the transcript as heard when the cleanup fails", async () => {
    transcription.enqueue(200, { text: transcript });
    completions.enqueue(500, { error: "internal_error" });

    const { pasted, controller } = await dictate();

    expect(pasted).toEqual([transcript]);
    expect(controller.phase).toEqual(idle);
  });

  test("an empty transcript is neither cleaned up nor pasted", async () => {
    transcription.enqueue(200, { text: "  " });

    const { pasted, controller } = await dictate();

    expect(pasted).toEqual([]);
    expect(completions.requests).toHaveLength(0);
    expect(controller.phase).toEqual(failed(nothingHeardMessage));
  });

  /** The shared backend errors still explain the failure in the overlay, without a cleanup or paste. */
  test.each([
    [402, `{"error":"no_active_subscription"}`, "Dictation needs an active TabMail subscription."],
    [502, `{"error":"transcription_failed"}`, "Dictation failed. Please try again."],
    [200, `{"unexpected":true}`, "TabMail returned an unexpected response."],
  ])("a failed transcription (%i %s) is neither cleaned up nor pasted", async (status, body, message) => {
    transcription.enqueue(status, body);

    const { pasted, controller } = await dictate();

    expect(pasted).toEqual([]);
    expect(completions.requests).toHaveLength(0);
    expect(controller.phase).toEqual(failed(message));
  });

  /** Cancelled while the cleanup runs (another key pressed while the hotkey is held): the request is
   * cancelled right away, not at the cleanup's timeout, and its result is not pasted. */
  test("a dictation cancelled during the cleanup pastes nothing", async () => {
    transcription.enqueue(200, { text: transcript });
    completions.enqueue(200, cleanedStream);
    const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
    let cancelledAfter: number | null = null;
    completions.gate = async (asked) => {
      const started = performance.now();
      controller.handle("cancel");
      try {
        await sleep(5_000, asked.signal);
      } catch {
        cancelledAfter = performance.now() - started;
      }
    };

    await holdAndRelease(controller);

    expect(await eventually(() => cancelledAfter !== null)).toBe(true);
    await sleep(50);
    expect(completions.requests).toHaveLength(1);
    expect(pastes).toEqual([]);
    expect(controller.phase).toEqual(idle);
    // Well inside `cleanupTimeout`, whose timer would cancel it anyway.
    expect(cancelledAfter ?? 60_000).toBeLessThan(1_000);
  });

  /** The user signed out and into another account while the transcription ran: the transcript is not
   * sent to the cleanup under that account, and is pasted as heard. */
  test("an account switch during the transcription skips the cleanup", async () => {
    const account = signedIn(auth);
    transcription.enqueue(200, { text: transcript });
    completions.enqueue(200, cleanedStream);
    auth.enqueue(200, Fixtures.sessionJSON({ access: "access-b", refresh: "refresh-b", userId: "user-2" }));
    transcription.gate = async () => {
      account.signOut();
      await account.verify(Fixtures.email, "123456");
    };

    const { pasted } = await dictate(account);

    expect(account.session?.userId).toBe("user-2");
    expect(transcription.authorizations).toEqual(["Bearer access-1"]);
    expect(completions.requests).toHaveLength(0);
    expect(pasted).toEqual([transcript]);
  });

  /** A cleanup that never answers holds the paste only until the app's own cleanup timeout; then the
   * transcript is pasted as heard. */
  test("a cleanup that never answers pastes the transcript at its timeout", async () => {
    transcription.enqueue(200, { text: transcript });
    completions.enqueue(200, cleanedStream);
    completions.gate = (asked) => sleep(60_000, asked.signal).catch(() => {});
    const started = performance.now();

    const { pasted, controller } = await dictate();

    expect(completions.requests).toHaveLength(1);
    expect(pasted).toEqual([transcript]);
    expect(controller.phase).toEqual(idle);
    // The owner's cap on how long a cleanup may hold the paste is 3 seconds. It is written out here
    // rather than read from the config, so raising the setting past it fails.
    const ownersCap = 3_000;
    expect(config.cleanupTimeout).toBeLessThanOrEqual(ownersCap);
    // Slack for a loaded runner, far below the wait a stalled stream would otherwise cause.
    expect(performance.now() - started).toBeLessThan(ownersCap + 5_000);
  });

  /** A cleanup slower than the screen-read wait but within the app's own cleanup timeout is pasted:
   * the controller gives the cleanup that timeout, not a shorter one. */
  test("a cleanup that answers within its timeout is pasted", async () => {
    transcription.enqueue(200, { text: transcript });
    completions.enqueue(200, cleanedStream);
    completions.gate = () => sleep(config.contextWait + 500);

    const { pasted, controller } = await dictate();

    expect(completions.requests).toHaveLength(1);
    expect(pasted).toEqual([cleaned]);
    expect(controller.phase).toEqual(idle);
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

    /** Cancelled while the transcription runs: nothing is cleaned up or pasted, and the overlay just
     * goes, with no error for the user's own cancel (not even "nothing heard"), whether the reply
     * still arrives or the request fails as cancelled. */
    test.each([
      ["whose reply arrives anyway", false, transcript],
      ["whose empty reply arrives anyway", false, "  "],
      ["whose request fails as cancelled", true, transcript],
    ])("a dictation cancelled during the transcription %s shows nothing", async (_, honoursCancel, heard) => {
      transcription.honoursCancel = honoursCancel;
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

    /** A hold started while the cancelled dictation's request is still failing keeps its microphone:
     * the older dictation's end doesn't stop the newer one. */
    test("a hold right after a cancel during the transcription keeps listening", async () => {
      transcription.honoursCancel = true;
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

    /** Cancelled while the sign-in is refreshed, before the recording goes out: the recording is
     * never sent. The real transport, against a server on the loopback interface. */
    test("a dictation cancelled during a sign-in refresh sends nothing", async () => {
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
        auth.gate = async () => {
          controller.handle("cancel");
        };

        await holdAndRelease(controller);

        expect(await eventually(() => auth.requests.length === 1)).toBe(true);
        await sleep(300);
        expect(uploads).toEqual([]);
        expect(pastes).toEqual([]);
        expect(controller.phase).toEqual(idle);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });

    /** The screen is read at key-down; a read done within `contextWait` of the transcript is sent with
     * it to the cleanup. */
    test("cleans up with the screen read at key-down", async () => {
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      const read = deferred<ScreenContext | null>();
      const readStarted: { phase: Phase; transcriptions: number }[] = [];
      controller.captureContext = () => {
        readStarted.push({ phase: controller.phase, transcriptions: transcription.requests.length });
        return read.promise;
      };
      controller.contextWait = 30_000;

      await holdAndRelease(controller);
      expect(await eventually(() => transcription.requests.length === 1)).toBe(true);
      // Read once, at key-down: before the overlay is revealed and before anything is transcribed.
      expect(readStarted).toEqual([{ phase: arming, transcriptions: 0 }]);
      // Longer than the default wait: using the default instead of the override loses this screen.
      await sleep(config.contextWait * 2);
      expect(completions.requests).toHaveLength(0);
      expect(pastes).toEqual([]);
      read.resolve(screen("A"));

      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length > 0)).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(cleanupVars(0)?.dictation).toBe(transcript);
      expect(cleanupVars(0)?.app_name).toBe("Example Notes A");
      expect(cleanupVars(0)?.screen_text).toContain("Agenda A");
    });

    /** The debug log file gets what was heard, what the cleanup made of it and what was pasted
     * (ADR-DESK-015), after the backend clients' own entries. */
    test("a dictation logs its transcript, cleaned text and paste", async () => {
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);

      const entries = steps(await loggedContent(async () => {
        await dictate();
      }));

      expect(entries.map((entry) => entry.label)).toEqual(["Transcript (dictation)", "DictationCleanup: cleaned text", "DictationController: pasting"]);
      expect(entries.map((entry) => entry.text)).toEqual([transcript, cleaned, cleaned]);
    });

    /** Cancelled while its screen is still being read: nothing is sent to the cleanup or pasted, and the
     * next dictation is cleaned up with its own screen. */
    test("a dictation cancelled while its screen is read is not cleaned up", async () => {
      transcription.enqueue(200, { text: "first dictation" });
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      const first = deferred<ScreenContext | null>();
      controller.captureContext = () => first.promise;
      controller.contextWait = 5_000;

      await holdAndRelease(controller);
      expect(await eventually(() => transcription.requests.length === 1)).toBe(true);
      await sleep(200);
      controller.handle("cancel");
      first.resolve(screen("A"));
      await sleep(200);
      expect(completions.requests).toHaveLength(0);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(idle);

      controller.captureContext = async () => screen("B");
      await holdAndRelease(controller);

      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length > 0)).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(completions.requests).toHaveLength(1);
      expect(cleanupVars(0)?.dictation).toBe(transcript);
      expect(cleanupVars(0)?.app_name).toBe("Example Notes B");
    });

    /** The screen read is best effort: not done within the app's own `contextWait` of the transcript,
     * the dictation is cleaned up without it rather than waiting. */
    test("a screen read not done in time is left out", async () => {
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      const read = deferred<ScreenContext | null>();
      controller.captureContext = () => read.promise;

      await holdAndRelease(controller);
      expect(await eventually(() => transcription.requests.length === 1)).toBe(true);
      const transcribed = performance.now();

      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length > 0)).toBe(true);
      // Slack for a loaded runner, far below a wait that would hold the paste for a slow app.
      expect(performance.now() - transcribed).toBeLessThan(config.contextWait + 3_000);
      expect(pastes).toEqual([cleaned]);
      expect(completions.requests).toHaveLength(1);
      expect(cleanupVars(0)?.dictation).toBe(transcript);
      expect(cleanupVars(0)?.app_name).toBe("");
      expect(cleanupVars(0)?.screen_text).toBe("");
      read.resolve(null);
    });

    /** A screen read done shortly after the transcript, within the app's own `contextWait`, is still
     * sent with it to the cleanup. */
    test("a screen read done just after the transcript is sent", async () => {
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      const read = deferred<ScreenContext | null>();
      controller.captureContext = () => read.promise;
      // Released a fifth of the wait after the transcription is asked for; it answers at once.
      transcription.gate = async () => {
        void sleep(config.contextWait / 5).then(() => read.resolve(screen("A")));
      };

      await holdAndRelease(controller);

      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length > 0)).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(completions.requests).toHaveLength(1);
      expect(cleanupVars(0)?.app_name).toBe("Example Notes A");
    });
  });

  describe("agent mode (Space during the hold)", () => {
    /** One agent-mode request, spoken over `context`: the controller, what was pasted, and every phase
     * it went through. `prepare` runs on the controller before the hold. */
    async function carryOut(
      context: ScreenContext | null,
      thunderbird?: FakeThunderbird,
      prepare: (controller: DictationController) => void = () => {},
    ): Promise<{ controller: DictationController; pastes: string[]; phases: Phase[] }> {
      const { controller, pastes } = makeController({ capture: new CountingCapture(true), thunderbird });
      const phases: Phase[] = [];
      controller.onPhaseChange = (phase) => phases.push(phase);
      controller.captureContext = () => (context ? Promise.resolve(context) : null);
      prepare(controller);
      await holdAndRelease(controller, "agent");
      expect(await eventually(() => settled(controller))).toBe(true);
      return { controller, pastes, phases };
    }

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
      expect(cleanupVars(0)?.content).toBe("system_prompt_desktop_edit");
      expect(cleanupVars(0)?.user_request).toBe(request);
      expect(cleanupVars(0)?.selected_text).toBe("Ship it Friday or else.\n");
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
      expect(cleanupVars(0)?.content).toBe("system_prompt_desktop_compose");
    });

    /** The selection alone decides between Edit and Compose, as the bubbles showed it: the agent only
     * decides whether the request goes to the email app, and its pick of the other writing tool is
     * overruled. */
    test.each<[string, string, AgentTool, string]>([
      ["Ship it Friday or else.", "compose", "edit", "system_prompt_desktop_edit"],
      ["", "edit", "compose", "system_prompt_desktop_compose"],
    ])("the selection %j decides the writing tool over the agent's %s", async (selected, agentChoice, tool, prompt) => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply(agentChoice));
      completions.enqueue(200, reply("Could we ship on Friday?"));

      const { controller, pastes, phases } = await carryOut(selectionScreen(selected), new FakeThunderbird());

      expect(controller.tools).toEqual([tool, "thunderbird"]);
      expect(phases).toContainEqual(running(tool));
      expect(phases).not.toContainEqual(running(tool === "edit" ? "compose" : "edit"));
      expect(pastes).toEqual(["Could we ship on Friday?"]);
      expect(cleanupVars(0)?.content).toBe("system_prompt_desktop_agent");
      expect(cleanupVars(1)?.content).toBe(prompt);
    });

    /** Whatever goes wrong, agent mode pastes nothing: the spoken request is not text for the document. */
    test.each<[[number, string][], string]>([
      [[[200, "rewrite"]], new AgentFailure("noTool").message],
      [[[200, "compose"], [200, ""]], new AgentFailure("noText").message],
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
      expect(cleanupVars(1)?.content).toBe("system_prompt_desktop_thunderbird");
      expect(cleanupVars(1)?.user_request).toBe("find sam's invoice from last week");
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
      expect(cleanupVars(0)?.content).toBe("system_prompt_desktop_compose");
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

      expect(controller.phase).toEqual(failed(new RelayFailure("chatNotFocused").message));
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
      expect(cleanupVars(0)?.selected_text).toBe("Ship it Friday or else.");
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

    /** The user moved to another app while the text was written: it is not pasted there. */
    test.each<[string, AgentTool]>([
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
      expect(controller.phase).toEqual(failed(appChanged));
    });

    /** Cancelled while the app in front is read for the paste, the last wait before it, with the next
     * dictation already listening: the old request's text is pasted nowhere. */
    test.each<[string, AgentTool]>([
      ["Ship it Friday or else.", "edit"],
      ["", "compose"],
    ])("agent text cancelled during the last app check is not pasted (selection %j)", async (selected, tool) => {
      transcription.enqueue(200, { text: request });
      completions.enqueue(200, reply("Could we ship on Friday?"));
      const checking = deferred<void>();
      const lastCheck = deferred<number | null>();
      let reads = 0;
      // The first read is key-down's; the second, the check before the paste.
      const frontmostApp = (): Promise<number | null> => {
        reads += 1;
        if (reads !== 2) return Promise.resolve(front.pid);
        checking.resolve();
        return lastCheck.promise;
      };
      const { controller, pastes } = makeController({ capture: new CountingCapture(true), frontmostApp });
      controller.captureContext = async () => selectionScreen(selected);

      await holdAndRelease(controller, "agent");
      await checking.promise;
      expect(controller.phase).toEqual(running(tool));
      expect(completions.requests).toHaveLength(1);
      controller.handle("cancel");
      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening")).toBe(true);
      lastCheck.resolve(front.pid);
      await sleep(50);

      expect(pastes).toEqual([]);
      expect(controller.phase.kind).toBe("listening");
      controller.handle("cancel");
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
      expect(controller.phase).toEqual(failed(appChanged));
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

      expect(await eventually(() => controller.phase.kind === "failed")).toBe(true);
      expect(controller.phase).toEqual(failed(appChanged));
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

    /** Settings are read once, as a hold starts: changing the server, the email app and screen reading
     * while it runs changes nothing for it, and the change applies from the next hold. */
    test("settings changed during a hold apply from the next one", async () => {
      const thunderbird = new FakeThunderbird();
      let reads = 0;
      transcription.enqueue(200, { text: "find sam's invoice" });
      completions.enqueue(200, reply("thunderbird"));
      completions.enqueue(200, reply("Find the invoice Sam sent."));

      const { controller } = await carryOut(selectionScreen(""), thunderbird, (controller) => {
        controller.onPhaseChange = (phase) => {
          if (phase.kind !== "listening") return;
          prefs.value = { hasConsented: true, hotkey: "rightOption", backendURL: "https://dev.example.com", readsScreen: false, emailClient: "org.example.othermail", hasTabMail: true };
        };
        const read = controller.captureContext;
        controller.captureContext = () => {
          reads += 1;
          return read?.() ?? null;
        };
      });

      expect(thunderbird.pasted).toEqual(["Find the invoice Sam sent."]);
      expect(thunderbird.apps).toEqual([FakeThunderbird.app]);
      expect(new Set([...hosts(transcription), ...hosts(completions)])).toEqual(new Set(["api.example.com"]));
      expect(reads).toBe(1);

      controller.onPhaseChange = undefined;
      transcription.enqueue(200, { text: "find sam's receipt" });
      completions.enqueue(200, reply("thunderbird"));
      completions.enqueue(200, reply("Find the receipt Sam sent."));
      await holdAndRelease(controller, "agent");

      expect(await eventually(() => thunderbird.pasted.length === 2)).toBe(true);
      expect(thunderbird.apps).toEqual([FakeThunderbird.app, "org.example.othermail"]);
      expect([...hosts(transcription), ...hosts(completions)].filter((host) => host === "dev.example.com")).toHaveLength(3);
      expect(reads).toBe(1);
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
      for (const [, written] of [["first words", "First words."], ["second words", "Second words."], ["third words", "Third words."]]) {
        completions.enqueue(200, reply(written ?? ""));
      }
      for (const words of ["first words", "second words", "third words"]) transcription.enqueue(200, { text: words });
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
      expect(Object.keys(transcription.body(2)).sort()).toEqual(["audio", "format"]);
      expect(pastes).toEqual(["First words.", "Second words.", "Third words."]);
    });

    /** Both requests of one ordinary dictation use its key-down server; the next hold uses the new one. */
    test("an ordinary dictation keeps its server until the next hold", async () => {
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
      transcription.gate = async () => {
        prefs.value = { ...prefs.value, backendURL: "https://dev.example.com" };
      };

      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length === 1)).toBe(true);
      expect(pastes).toEqual([cleaned]);
      expect(hosts(transcription)).toEqual(["api.example.com"]);
      expect(hosts(completions)).toEqual(["api.example.com"]);
      expect(cleanupVars(0)?.dictation).toBe(transcript);

      transcription.gate = undefined;
      transcription.enqueue(200, { text: "next dictated words" });
      completions.enqueue(200, reply("Next dictated words."));
      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "idle" && pastes.length === 2)).toBe(true);
      expect(pastes).toEqual([cleaned, "Next dictated words."]);
      expect(hosts(transcription)).toEqual(["api.example.com", "dev.example.com"]);
      expect(hosts(completions)).toEqual(["api.example.com", "dev.example.com"]);
      expect(cleanupVars(1)?.dictation).toBe("next dictated words");
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

      const offered: AgentTool[] = atKeyDown === null ? ["compose"] : ["compose", "thunderbird"];
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

    /** Cancelled while the tool writes: nothing is pasted, then or when the text arrives. */
    test("a request cancelled while running pastes nothing", async () => {
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
      // The request itself is cancelled, not just its reply ignored: it stops at once, and one not
      // yet sent (behind a sign-in refresh) never goes.
      expect(completions.requests[0]?.signal?.aborted).toBe(true);
      expect(pastes).toEqual([]);
      expect(controller.phase).toEqual(idle);
    });

    /** Space switches nothing once the hold is over: not while transcribing, nor after a failure. */
    test("Space switches nothing after the hold", async () => {
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
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
      expect(cleanupVars(0)?.content).toBe(config.cleanupPrompt);

      transcription.gate = undefined;
      await holdAndRelease(controller);
      expect(await eventually(() => controller.phase.kind === "failed")).toBe(true);
      expect(controller.phase).toEqual(failed(nothingHeardMessage));
      controller.handle("toggleMode");
      expect(controller.mode).toBe("dictation");
      expect(controller.tools).toEqual([]);
      expect(controller.emailAppPath).toBeNull();
    });

    /** A cancelled hold's screen read that finishes during the next hold does not change the tools that
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
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
      const { controller, pastes } = await carryOut(null);

      await holdAndRelease(controller);
      expect(await eventually(() => pastes.length === 2)).toBe(true);

      expect(controller.mode).toBe("dictation");
      expect(controller.tools).toEqual([]);
      expect(pastes).toEqual(["We ship on Friday.", cleaned]);
      expect(cleanupVars(1)?.content).toBe(config.cleanupPrompt);
    });
  });

  describe("tips and hands-free dictation", () => {
    /** The Space tip shows as the pill listens, until the user switches modes once; then never again. */
    test("the Space tip shows until Space is used", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      controller.tipDisplayDuration = () => 60_000;

      controller.handle("start");
      expect(await eventually(() => controller.tip === "switchMode")).toBe(true);
      expect(controller.phase).toEqual(listening);
      controller.handle("toggleMode");
      expect(controller.tip).toBeNull();
      controller.handle("cancel");

      controller.handle("start");
      expect(await eventually(() => controller.phase.kind === "listening" && controller.isHearing)).toBe(true);
      expect(await throughout(300, () => controller.tip === null)).toBe(true);
      controller.handle("cancel");
      expect(new TipBook(tipStore).isEligible("switchMode")).toBe(false);
    });

    /** A tip shows for its display duration, and goes away with the hold. */
    test("a tip shows for its display duration and goes with the hold", async () => {
      const { controller } = makeController({ capture: new CountingCapture(true) });
      controller.tipDisplayDuration = () => 150;

      controller.handle("start");
      expect(await eventually(() => controller.tip === "switchMode")).toBe(true);
      expect(await eventually(() => controller.tip === null)).toBe(true);
      expect(controller.phase).toEqual(listening);
      controller.handle("cancel");

      controller.tipDisplayDuration = () => 60_000;
      controller.handle("start");
      expect(await eventually(() => controller.tip === "switchMode")).toBe(true);
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
      controller.tipDisplayDuration = (tip) => (tip === "switchMode" ? 50 : 60_000);

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
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
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
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
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
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
      const { controller, pastes } = makeController({ capture: new CountingCapture(true) });

      controller.handle("start");
      controller.handle("finish");
      controller.handle("startHandsFree");
      expect(controller.phase).toEqual(listening);
      controller.handle("finish");

      expect(await eventually(() => pastes.length === 1 && pastes[0] === cleaned && controller.phase.kind === "idle")).toBe(true);
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
      for (let index = 0; index < (config.switchModeTip.maxDisplays ?? 0) + 5; index += 1) book.recordDisplay("handsFree");
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
      expect(new TipBook(tipStore).isEligible("switchMode")).toBe(true);
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
      expect(await throughout(config.minimumHoldDuration * 3, () => controller.tip !== "switchMode")).toBe(true);
      expect(controller.tip).toBe("handsFree");
      controller.handle("cancel");

      secondPress();
      expect(await throughout(config.minimumHoldDuration / 2, () => controller.tip === null)).toBe(true);
      expect(await eventually(() => controller.tip === "switchMode")).toBe(true);
      expect(await throughout(config.minimumHoldDuration * 3, () => controller.tip !== "handsFree")).toBe(true);
      controller.handle("finish");
      expect(controller.phase).toEqual(transcribing);
      // Nothing is sent after this test.
      controller.handle("cancel");
    });

    /** A second press cancelled while down (a typing chord) leaves nothing for the next one: a newer
     * second press shows no tip until it has been down as long as a hold, even when the cancelled one
     * would have become a hold before that; released as a tap, it gets the hands-free tip. */
    test("a cancelled second press leaves no tip for the next one", async () => {
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
      // Past when the cancelled press would have become a hold, short of when this one does.
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
      controller.tipDisplayDuration = (tip) => (tip === "switchMode" ? 60_000 : tipDetails[tip].displayDuration);

      controller.handle("start");
      controller.handle("finish");
      controller.handle("startHandsFree");
      expect(await eventually(() => controller.tip === "switchMode")).toBe(true);
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

    /** Escape during a hands-free dictation: nothing is sent or pasted. */
    test("a hands-free dictation cancelled sends nothing", async () => {
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
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
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

    /** The paste is for its dictation: cancelled before the paste reaches the system (it waits out a
     * helper restart after the loss), the dictation calls it off, so nothing is pasted (in agent
     * mode too); the next dictation's paste is its own. */
    test.each(["dictation", "agent"] as const)("a %s cancelled while its paste waits calls the paste off", async (mode) => {
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
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
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
      transcription.enqueue(200, { text: transcript });
      completions.enqueue(200, cleanedStream);
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
});
