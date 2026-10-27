// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AccountModel, withFreshToken } from "../backend/account.js";
import { type AgentChat, appendTurn, type ChatTurn, chatTranscript, emptyChat, type EventQuestion, type QuestionAnswer, settleQuestion } from "../agent/chat.js";
import { type BubbleKey, memoryBubble, screenReadBubble, ranNow } from "../agent/bubbleOrder.js";
import { type ConnectorID, connectorIDs, connectors } from "../agent/connectors/index.js";
import { ToolRegistry, type RegisteredTool } from "../agent/toolRegistry.js";
import { DesktopAgent, type Personalization } from "../agent/requests.js";
import { EmailClient } from "../agent/connectors/thunderbird/emailClient.js";
import { isJSONObject, parsedJSON, type ConnectorTool, type ToolQuestion, type ToolSettings } from "../agent/connectors/contract.js";
import type { ThunderbirdRelay } from "../agent/connectors/thunderbird/relay.js";
import { AgentError, type AgentToolID, agentTools, screenHiddenNote } from "../agent/tools.js";
import { type AudioCapture, AudioRecorder, type RecordedChunk, recordingDuration } from "../audio/recorder.js";
import { LevelSampler } from "../audio/levelSampler.js";
import { BackendError } from "../backend/errors.js";
import { type CompletionsClient, type ToolCall } from "../backend/completions.js";
import { type Transcription, type TranscriptionClient } from "../backend/transcription.js";
import { joinChunkTexts } from "./chunkJoin.js";
import { DictationCleanup, spacedFromCaret } from "./cleanup.js";
import * as config from "../config.js";
import { contextTerms } from "../dictionary/contextTerms.js";
import { type DictationMode, type HotkeyAction, toggled } from "../hotkey/bindings.js";
import { TransportError } from "../backend/http.js";
import { LevelEnvelope } from "../audio/levelEnvelope.js";
import { agentPart, type AgentMemory, memoryRow } from "../memory/store.js";
import { MemoryTools } from "../memory/tools.js";
import { KBRefiner } from "../personalization/kbRefine.js";
import { KBTools } from "../personalization/kbTools.js";
import type { UserPrompts } from "../personalization/prompts.js";
import { elapsed, errorName, log } from "../log.js";
import { Observable } from "../util/observable.js";
import type { PasteHistory } from "./pasteHistory.js";
import type { MicrophoneStatus } from "../onboarding/permissions.js";
import { isScreenHidden, type ScreenContext, type ScreenRead, screenShown } from "./screenContext.js";
import type { ScreenExclusions } from "./excludedSites.js";
import type { DictationSettings } from "../settings.js";
import { charCount, trimWhitespace } from "../util/text.js";
import { type DictationTip, type TipBook, tipDetails } from "../onboarding/tips.js";
import { CancellationError, sleep, TimeoutError, withTimeout } from "../util/timeout.js";
import { PasteTargetError } from "./targetWindow.js";
import { encodeWAV } from "../audio/wav.js";

export type Phase =
  | { kind: "idle" }
  /** Key is down and the microphone is booting, but the hold isn't yet long enough to be
   * deliberate: nothing is shown, so an accidental tap stays invisible and the microphone's start-up
   * time is hidden behind the hold. */
  | { kind: "arming" }
  | { kind: "listening" }
  | { kind: "transcribing" }
  /** The transcription failed on the server's side and has been tried again for a while (`transcribeRetrying`). */
  | { kind: "retrying"; message: string }
  /** Agent mode: this tool's bubble runs once the agent answers or writes; none (null) while the loop
   * thinks, so Answer's bubble never runs for a request that ends by writing (owner, 2026-10-07). */
  | { kind: "running"; tool: AgentToolID | null }
  | { kind: "failed"; message: string }
  /** The user went to another app before the paste: nothing is pasted and the clipboard is left as
   * it is; the text is in the paste history, and a note at the mouse pointer shows it (`text`) and
   * copies it when clicked, for `notPastedDisplayDuration`, and goes once clicked, or dismissed by its
   * x (ADR-DESK-042, amended 2026-10-08 and 2026-10-09). */
  | { kind: "notPasted"; message: string; text: string };

/** What the pointer's note says when the text was not pasted. */
export const notPastedMessage = "Couldn't paste. Click to copy.";

/** What the note says once clicked, when the clipboard refused the text: the paste history has it. */
export const notCopiedMessage = "Couldn't copy. It's in the paste history.";

/** A text not pasted: the dictation ends with its note (`notPasted`). */
class NotPastedError extends Error {
  constructor(readonly text: string) {
    super(notPastedMessage);
    this.name = "NotPastedError";
  }
}

/** The email app agent mode's mail and calendar requests go to, and its installed bundle (the
 * Thunderbird bubble shows its icon); both null when there is none. */
interface EmailApp {
  app: string | null;
  path: string | null;
}

export interface DictationDependencies {
  permissions: { readonly microphone: MicrophoneStatus; readonly accessibilityTrusted: boolean };
  /** Reads the settings, once per dictation. */
  settings: () => DictationSettings;
  account: AccountModel;
  tips: TipBook;
  /** Pastes into the focused field, for the dictation whose `signal` it is: one canceled before the
   * paste reaches the system pastes nothing. */
  paste: (text: string, signal: AbortSignal, target: number) => Promise<void>;
  /** Puts `text` on the clipboard: a text not pasted, when its note is clicked. True once written,
   * false when the clipboard refused it. */
  copy: (text: string) => Promise<boolean>;
  /** Saves the clipboard in the background, for the next paste to put back after its keys
   * (ADR-DESK-002): asked from key-down every `clipboardSaveInterval` until the paste writes, never
   * waited for. */
  saveClipboard: () => void;
  /** Every text pasted, or copied instead, for the triple tap's list (ADR-DESK-043). */
  history: PasteHistory;
  thunderbird: ThunderbirdRelay;
  capture: AudioCapture;
  /** Opaque positive foreground identity (macOS process id; Windows window), null without one. */
  frontmostApp: () => Promise<number | null>;
  /** The active keyboard input source's language. */
  keyboardLanguage: () => Promise<string | null>;
  /** The bundle identifier of the system's default email app. */
  systemEmailApp: () => Promise<string | null>;
  makeTranscriptionClient: (baseURL: string) => TranscriptionClient;
  /** Warms the backend for the transcription to come (`TranscriptionClient.warmUp`). */
  warmUp: (baseURL: string, accessToken: string) => Promise<void>;
  makeCompletionsClient: (baseURL: string) => CompletionsClient;
  /** The tools agent mode's model can call that run on this computer. */
  connectorTools: readonly ConnectorTool[];
  /** Memory: every agent-mode request and what came of it, which the agent can look back at
   * (ADR-DESK-061). */
  memory: AgentMemory;
  /** The user's knowledge base and writing style (ADR-DESK-063): sent with agent mode's requests,
   * edited by its `kb_add` and `kb_del`, and refined when a chat window closes. */
  prompts: UserPrompts;
  /** Keeps the latest recording for "Play Last Recording"; called only for a dictation that started
   * in debug mode (`DictationSettings.keepsRecording`). */
  keepRecording?: (wav: Uint8Array) => void;
  /** Learns the user's corrections of a pasted dictation (`CorrectionWatch`) in the field of the app
   * or window it was pasted into (`targetApp`), read by voice-field-reader; none without the native
   * microphone path. */
  corrections?: { watch(target: number, pasted: string, exclusions: ScreenExclusions): void; stop(): void };
  /** Marks the dictionary's words in a dictation's transcript and cleaned text used
   * (`AppSettings.useWords`), so a full dictionary keeps them (ADR-DESK-038). */
  useWords: (texts: readonly string[]) => void;
}

/** Shown when the recording had no words in it. Kept to one line of the pill. */
export const nothingHeardMessage = "Didn't catch that. Try again.";

/** Shown when the microphone gives nothing but digital silence (`silentMicrophoneDuration`). Kept to
 * one line of the pill. */
export const silentMicrophoneMessage = "Microphone muted or at zero volume.";

/** Shown while a transcription that failed on the server's side is tried again. */
export const retryingMessage = "Server error, retrying…";


/** The status the backend answers when the speech model did not answer in time. */
const gatewayTimeout = 504;
/** The status the backend answers when the speech model's rate limit outlasted its own retries
 * (`transcription_rate_limited`, backend ADR-022; it answered 502 before 2026-10-03). */
const speechModelRateLimited = 429;

/**
 * Drives one push-to-talk dictation at a time: record → transcribe on the backend → clean up the
 * transcript with the screen context → paste. In agent mode (Space pressed during the hold) the
 * transcript is a request instead: the selection picks Edit or Compose, the agent may send it to
 * TabMail's chat in Thunderbird instead, and the tool's text is pasted, or sent there; an answer
 * opens the chat window (`chat`), where the hotkey then starts a follow-up in agent mode. A double
 * tap of the hotkey starts a hands-free dictation instead of a hold. While the pill listens, a tip
 * may show by it (`DictationTip`).
 */
export class DictationController extends Observable {
  private currentPhase: Phase = { kind: "idle" };
  private currentMode: DictationMode = "dictation";
  private currentTools: AgentToolID[] = [];
  private currentReadsWindow = false;
  private currentLevel = 0;
  private hearing = false;
  /** The transcription that has hit a server error and not yet answered or ended, with the dictation
   * it belongs to and its signal (`isRetrying`): only it clears the hint, and it shows only while its
   * dictation is the current one and it is not canceled, so one that ends late, from a canceled
   * dictation or a dropped spoken answer, neither shows on nor clears a newer one's. */
  private retrying: { generation: number; signal: AbortSignal } | null = null;
  private currentLanguage: string | null = null;
  private currentTip: DictationTip | null = null;
  private emailApp: EmailApp | null = null;
  private currentChat: AgentChat | null = null;
  /** The bubbles whose tools ran, the most recent first: for the app's life, never saved. */
  private recent: BubbleKey[] = [];
  /** The apps whose tools run now: one at a time, as the answer's tools run in turn. */
  private runningApps = new Set<BubbleKey>();

  onPhaseChange: ((phase: Phase) => void) | undefined;
  /** The chat window opened (true) or closed. */
  onChatChange: ((isOpen: boolean) => void) | undefined;
  /** How long the chat window stays open untouched. Settable for tests. */
  chatTimeout = config.chatTimeout;
  /** How long the chat window's question shows before an answer to it counts. Settable for tests. */
  confirmationMinimumDisplay = config.chatConfirmationMinimumDisplay;
  /** How long the chat window's question waits for an answer. Settable for tests. */
  confirmationTimeout = config.chatConfirmationTimeout;
  /** Longest a dictation waits for its text after the release, retries included. Settable for tests. */
  transcriptionDeadline = config.transcriptionDeadline;
  /** The waits before each retry of a transcription that failed on the server's side. Settable for tests. */
  transcriptionRetryDelays = config.transcriptionRetryDelays;
  /** How long after the first server error the pill says it is retrying. Settable for tests. */
  transcriptionRetryNoticeDelay = config.transcriptionRetryNoticeDelay;
  /** The waits before each retry of a long dictation's chunk that failed while it was recorded. Settable for tests. */
  chunkRetryDelays = config.chunkRetryDelays;
  /** How long a long dictation's polish may take. Settable for tests. */
  chunkPolishTimeout = config.chunkPolishTimeout;
  /** A double tap's second press was released as a tap, leaving the hotkey helper hands-free, but no
   * hands-free dictation listens: the press came while the last dictation was still busy, or failed
   * to start, or its dictation ended while the key was down. The helper must be told, or it keeps
   * Space and Escape from the app in front until the next hotkey press. */
  onNothingListening: (() => void) | undefined;
  /** A triple tap asks for the paste history (ADR-DESK-043). */
  onShowHistory: (() => void) | undefined;
  /** Starts reading the screen context when a dictation starts (key-down) with screen reading on,
   * with the target app still frontmost. Null: no context (the cleanup runs without it). A screen
   * hidden for privacy is no context either; agent mode's tools are told it is hidden. */
  captureContext: ((exclusions: ScreenExclusions, target: Promise<number | null>) => Promise<ScreenRead | null> | null) | undefined;
  /** Asks a read `captureContext` gave, still going, to answer with what it has read so far: the read
   * then yields that (ADR-DESK-053). */
  stopContext: ((read: Promise<ScreenRead | null>) => void) | undefined;
  /** The whole window of the app a read `captureContext` gave, read once that read has answered
   * (ADR-DESK-016, 2026-10-25): its terms fill the room the shown screen's leave if it is done by the
   * upload, and agent mode reads it only when the model asks (`screen_read`). `stopContext` stops it
   * too. Null: none. */
  captureWindow: ((capture: Promise<ScreenRead | null>) => Promise<ScreenRead | null> | null) | undefined;
  /** How long a dictation's upload waits for that read, which its cleanup variables travel with
   * (agent mode waits `agentScreenWait` for all of it, once its transcript is ready). A read not done
   * by then is asked for what it has read so far, which is waited for as long again
   * (`waitForScreen`). Settable for tests. */
  contextWait = config.contextWait;
  agentScreenWait = config.agentScreenWait;
  /** How long a hold goes on before the double-tap tip is due, and how long a tip shows. Settable
   * for tests. */
  doubleTapTipHoldDuration = config.doubleTapTipHoldDuration;
  tipDisplayDuration: (tip: DictationTip) => number | null = (tip) => tipDetails[tip].displayDuration;

  // Per-dictation state. `generation` invalidates callbacks from a superseded dictation.
  private generation = 0;
  private startedAt: number | null = null;
  /** When the key was released (or hands-free listening ended), for the debug log's step timings. */
  private releasedAt: number | null = null;
  /** The settings this dictation started with; it reads no others. */
  private dictationSettings: DictationSettings;
  /** The knowledge base and writing style this dictation started with, read with its settings. */
  private dictationPersonalization: Personalization;
  /** Learns a closed chat's knowledge into the knowledge base, one chat at a time. */
  private readonly refiner: KBRefiner;
  /** Cancels this dictation's requests when it is discarded. */
  private abort = new AbortController();
  /** The app in front at key-down: the paste goes there only, and the corrections are learned from
   * its field, never from whatever is in front after the paste. */
  private targetApp: Promise<number | null> = Promise.resolve(null);
  /** The keyboard's language at key-down, which the badge shows and the transcription is asked in. */
  private languageRead: Promise<string | null> = Promise.resolve(null);
  private emailAppRead: Promise<EmailApp> | null = null;
  private recorder: AudioRecorder | null = null;
  /** What every upload of this dictation sends with its audio, prepared once, by its first upload. */
  private upload: Promise<Upload> | null = null;
  /** A long dictation's chunks, each sent as it is cut while recording (ADR-DESK-049), in order. */
  private chunks: ChunkJob[] = [];
  /** Cancels those chunks' requests: with the dictation, or once its text no longer needs them. */
  private chunkAbort = new AbortController();
  /** This dictation's release: chunks that still fail get their last tries then. */
  private release: Release = newRelease();
  private envelope = new LevelEnvelope();
  /** Debug tuning aid: the highest waveform level reached this dictation. */
  private peakMeterLevel = 0;
  private contextRead: Promise<ScreenRead | null> | null = null;
  /** That read's result, once done (null without a read); `tools` waits for it. */
  private screenRead: ScreenContext | null = null;
  private isScreenReadDone = false;
  /** This dictation's whole window (`captureWindow`), and its result once done (null till then). */
  private windowRead: Promise<ScreenRead | null> | null = null;
  private windowScreen: ScreenContext | null = null;
  private revealTimer: Timer | null = null;
  private maxDurationTimer: Timer | null = null;
  /** Running from the microphone's first audio until it gives more than digital silence. */
  private silenceTimer: Timer | null = null;
  private releaseTailTimer: Timer | null = null;
  private failureResetTimer: Timer | null = null;
  private clipboardSaveTimer: Timer | null = null;
  /** Tips to show this dictation, in turn, once the pill listens and hears (`showDueTip`). */
  private dueTips: DictationTip[] = [];
  private tipTimer: Timer | null = null;
  private longHoldTimer: Timer | null = null;
  /** Set while a tap's recording waits `doubleTapWindow` for a second press, which makes it
   * hands-free. */
  private secondTapTimer: Timer | null = null;
  /** Set while a double tap's second press is down: held past a tap, it is a hold, with a hold's
   * tips. */
  private secondPressTimer: Timer | null = null;
  /** Closes the chat window when its timeout runs out. */
  private chatCloseTimer: Timer | null = null;
  /** Gives the user's answer to the question the chat window shows, awaited by the tool that asked,
   * with the id it keeps in the chat window once answered (null with the window closed). */
  private confirmationReply: ((answer: ConfirmationAnswer, question: number | null) => void) | null = null;
  /** How many questions the chat window has kept once answered, for each its own id. */
  private questionsKept = 0;
  /** Declines the question when it has gone unanswered for `confirmationTimeout`. */
  private confirmationTimer: Timer | null = null;
  /** When the question now showing appeared. */
  private confirmationShownAt = 0;
  /** The answer to the question being spoken (the hotkey, while the question shows): its recording,
   * and the phase the request it interrupts goes back to. Its own `abort` stops its transcription
   * when it is dropped (canceled, the question clicked), the request going on. */
  private spokenAnswer: { id: number; recorder: AudioRecorder; abort: AbortController; startedAt: number; handsFree: boolean; resume: Phase } | null = null;
  private spokenAnswers = 0;
  /** The call whose question the user answered aloud: the model, having read the answer, confirms or
   * declines it for them (`config.confirmationTool`), naming the question by its `id`; `question` is
   * the one the chat window keeps, ticked with what the model answers. Dropped by any other call, and
   * with its request (`dropAnsweredAloud`). */
  private answeredAloud: { tool: ConnectorTool; args: Record<string, unknown>; round: number; id: string; question: number | null } | null = null;
  /** How many questions have been answered aloud, for each its own id. */
  private questionsAnsweredAloud = 0;

  constructor(private readonly deps: DictationDependencies) {
    super();
    this.dictationSettings = deps.settings();
    this.dictationPersonalization = deps.prompts.personalization;
    this.refiner = new KBRefiner(deps.prompts);
    deps.account.onAccountChange = () => this.accountChanged();
  }

  get phase(): Phase {
    return this.currentPhase;
  }

  /** What the current (or last) recording is for. */
  get mode(): DictationMode {
    return this.currentMode;
  }

  /** Whether this request offers screen_read; kept with its tools between follow-ups. */
  get readsWindow(): boolean {
    return this.currentReadsWindow;
  }

  /** The tools agent mode offers this time (`DesktopAgent.tools`). Empty in dictation mode, and
   * until the screen read at key-down and the email app are known: the selection decides between
   * Edit and Compose. */
  get tools(): AgentToolID[] {
    return this.currentTools;
  }

  /** The apps agent mode shows a bubble for beside the tools': those switched on at key-down whose
   * tools this computer has, while Answer, whose loop runs their tools, is offered; none otherwise. */
  get connectors(): ConnectorID[] {
    if (!this.currentTools.includes("answer")) return [];
    return connectorIDs.filter((connector) => this.dictationSettings.enabledConnectors.includes(connector) && this.deps.connectorTools.some((tool) => tool.connector === connector));
  }

  /** The bubbles whose tools have run since the app started, the most recent first, which the
   * bubbles under the pill are ordered by (`bubbleOrder`). */
  get recentBubbles(): BubbleKey[] {
    return this.recent;
  }

  /** The one bubble that runs now, first in the row (owner, 2026-10-05: "the only one that circles is the
   * one on the far left"): the app whose tool started last, on this computer (`ConnectorTool`) or on the
   * backend (the web's search), or memory while its tools run (owner, 2026-10-19); otherwise the tool agent mode answers or writes with,
   * none while it thinks. */
  get runningBubble(): BubbleKey | null {
    const app = [...this.runningApps].at(-1);
    if (app !== undefined) return app;
    return this.currentPhase.kind === "running" ? this.currentPhase.tool : null;
  }

  /** In agent mode, the email app's bundle, whose icon the Thunderbird bubble shows. */
  get emailAppPath(): string | null {
    return this.currentMode === "agent" ? (this.emailApp?.path ?? null) : null;
  }

  get level(): number {
    return this.currentLevel;
  }

  /** True once the microphone delivers audio; until then the overlay shows its warm-up swirl. */
  get isHearing(): boolean {
    return this.hearing;
  }

  /** True once a voice stood above the room's noise this dictation (`LevelEnvelope.hasVoice`; each
   * dictation and spoken answer starts a new envelope, from the room's noise the last one left):
   * the overlay's waveform takes its recording colour, a sign it is listening (owner, 2026-10-02). */
  get hasVoice(): boolean {
    return this.envelope.hasVoice;
  }

  /** True from a transcription's first server error until it answers or ends, the note or not: the
   * thinking circle's arc turns purple, a hint of the retry before the note shows (owner,
   * 2026-10-02). */
  get isRetrying(): boolean {
    return this.retrying?.generation === this.generation && !this.retrying.signal.aborted;
  }

  /** The language this dictation is transcribed in: the keyboard's at key-down, read once so the
   * overlay's badge and the request always agree (ADR-DESK-019). Null: none sent, no badge. */
  get language(): string | null {
    return this.currentLanguage;
  }

  /** The tip shown under the listening pill, if any. */
  get tip(): DictationTip | null {
    return this.currentTip;
  }

  /** The chat window's conversation while it is open (an answer opens it); null when closed. */
  get chat(): AgentChat | null {
    return this.currentChat;
  }

  /** The settings the current (or last) dictation started with. */
  get settings(): DictationSettings {
    return this.dictationSettings;
  }

  handle(action: HotkeyAction): void {
    switch (action) {
      case "start":
        return this.start();
      case "startHandsFree":
        return this.start(true);
      case "startAgent":
        return this.start(false, "agent");
      case "startAgentHandsFree":
        return this.start(true, "agent");
      case "listenHandsFree":
        return this.listenHandsFree();
      case "finish":
        return this.finish();
      case "cancel":
        return this.cancel();
      case "toggleMode":
        return this.toggleMode();
      case "closeChat":
        return this.closeChat();
      case "showHistory":
        return this.showHistory();
    }
  }

  /** Does the slow, microphone-off part of starting the microphone ahead of the first dictation. */
  prewarm(): void {
    if (this.deps.permissions.microphone !== "granted") return;
    this.deps.capture.prepare();
  }

  /** Menu-driven toggle, for users who prefer clicking to holding a key. */
  toggle(): void {
    if (this.currentPhase.kind === "listening") this.finish();
    else this.start();
  }

  /** Starts a dictation; `toggleMode()` makes it an agent request. A hands-free one (a double
   * tap's second press) shows at once: it carries on the first tap's recording, whose microphone is
   * already running, if that tap is still waiting for it. Released as a tap, the press leaves it
   * listening until `finish()` or `cancel()` (`listenHandsFree()`); held, it finishes on release
   * like any hold. With the chat window open it is a follow-up: an agent request from the start,
   * which keeps the window open, and shows no tips. While the chat window asks a tool's question,
   * it records the user's answer to it instead (`startSpokenAnswer`). */
  start(handsFree = false, initialMode: DictationMode = "dictation"): void {
    // With a question showing, the hotkey answers it aloud.
    if (this.confirmationReply !== null) return this.startSpokenAnswer(handsFree);
    if (this.secondTapTimer !== null) {
      if (handsFree) {
        // Explicit agent intent also applies when reusing the first tap's audio.
        // An ordinary second tap preserves a mode already selected with Space.
        if (initialMode === "agent") this.currentMode = "agent";
        if (this.currentMode === "agent") this.prepareAgent();
        this.updateTools();
        this.latchHandsFree();
        return;
      }
      // A new hold: the tap before it was only a tap.
      this.discard();
    }
    if (!isResting(this.currentPhase)) return;
    // First, before anything else: the settings this dictation uses, whatever changes meanwhile.
    const settings = this.deps.settings();
    this.dictationSettings = settings;
    this.dictationPersonalization = this.deps.prompts.personalization;
    if (!settings.hasConsented) return this.fail("Finish setting up TabMail Voice from its menu to dictate.");
    if (!this.deps.account.isSignedIn) return this.fail("Sign in to TabMail in Settings to dictate.");
    if (this.deps.permissions.microphone !== "granted") return this.fail("Allow microphone access in TabMail Voice's menu to dictate.");
    if (!this.deps.permissions.accessibilityTrusted) {
      return this.fail("Allow Accessibility access in TabMail Voice's menu so dictation can type for you.");
    }

    // This dictation's paste must not be taken for the user's correction of the last one.
    this.deps.corrections?.stop();
    cancelTimer(this.failureResetTimer);
    this.failureResetTimer = null;
    this.generation += 1;
    const current = this.generation;
    this.abort = new AbortController();
    const chunkAbort = new AbortController();
    this.abort.signal.addEventListener("abort", () => chunkAbort.abort(), { once: true });
    this.chunkAbort = chunkAbort;
    this.chunks = [];
    this.upload = null;
    this.release = newRelease();
    const isFollowUp = this.currentChat !== null;
    if (isFollowUp) this.keepChatOpen();
    this.currentMode = isFollowUp ? "agent" : initialMode;
    this.emailApp = null;
    this.emailAppRead = null;
    this.screenRead = null;
    this.isScreenReadDone = false;
    this.windowScreen = null;
    this.currentTools = [];
    this.currentReadsWindow = false;
    this.currentLevel = 0;
    this.peakMeterLevel = 0;
    this.envelope = new LevelEnvelope(this.envelope.room);
    this.hearing = false;
    this.startedAt = performance.now();
    this.releasedAt = null;
    this.targetApp = this.deps.frontmostApp().catch(() => null);
    this.currentLanguage = null;
    this.languageRead = this.deps.keyboardLanguage().catch(() => null);
    void this.languageRead.then((language) => {
      if (this.generation !== current) return;
      this.currentLanguage = language;
      this.changed();
    });
    // What's new goes first, once (`agentKnowledgeBase`).
    this.dueTips = ["agentKnowledgeBase", "agentAndHistory"];
    if (this.currentMode === "agent") this.prepareAgent();
    void this.warmUp(settings.backendURL);
    // Boot the microphone now; the overlay appears only once the hold is long enough, by which
    // time most of the start-up is done.
    // A long dictation is cut into chunks as it is recorded, each sent at once (ADR-DESK-049).
    const recorder = new AudioRecorder(config.recordingSampleRate, config.maxRecordingDuration, (chunk) => this.chunkCut(chunk, current));
    const meter = new LevelSampler();
    this.recorder = recorder;
    let audioArrived = false;
    this.deps.capture.start(
      (samples) => {
        if (this.generation !== current) return;
        if (!audioArrived) {
          audioArrived = true;
          this.silenceTimer = after(config.silentMicrophoneDuration, () => this.microphoneSilent(current));
        }
        recorder.append(samples);
        meter.append(samples, (level, voiceLevel) => this.updateLevel(level, voiceLevel));
      },
      (error) => {
        if (error) this.microphoneFailed(error, current);
      },
      () => this.microphoneLost(current),
    );
    // Capture must be dispatched before optional accessibility work: the caret lookup arming makes
    // can block a helper's request loop (on Linux, the one the microphone starts on), and nothing
    // said before the microphone starts is recorded.
    if (this.generation !== current) return;
    this.setPhase({ kind: "arming" });
    this.saveClipboardUntilThePaste();
    this.contextRead = settings.readsScreen ? (this.captureContext?.({ apps: settings.excludedApps, sites: settings.excludedSites }, this.targetApp) ?? null) : null;
    const read = this.contextRead;
    if (read) {
      const reading = performance.now();
      void read.then((context) => {
        if (this.generation !== current) return;
        log.debug(() => `DictationController: screen read answered in ${elapsed(reading)}${this.sinceRelease()}`);
        this.screenRead = screenShown(context);
        this.isScreenReadDone = true;
        this.updateTools();
      });
    } else {
      this.isScreenReadDone = true;
    }
    this.windowRead = read ? (this.captureWindow?.(read) ?? null) : null;
    void this.windowRead?.then((context) => {
      if (this.generation === current) this.windowScreen = screenShown(context);
    });

    if (handsFree) {
      // A double tap is deliberate: no hold to wait for.
      this.deps.tips.markLearned("doubleTap");
      this.setPhase({ kind: "listening" });
      this.awaitSecondRelease();
    } else {
      this.revealTimer = after(config.minimumHoldDuration, () => {
        if (this.generation !== current || this.currentPhase.kind !== "arming") return;
        this.setPhase({ kind: "listening" });
        this.showDueTip();
      });
      // A long hold: this user might rather not hold the key.
      this.longHoldTimer = after(this.doubleTapTipHoldDuration, () => {
        if (this.generation !== current) return;
        this.dueTips.push("doubleTap");
        this.showDueTip();
      });
    }

    // Past the longest dictation, stop and send what was said rather than silently dropping audio.
    this.maxDurationTimer = after(config.maxRecordingDuration, () => {
      if (this.generation !== current) return;
      log.debug("DictationController: max duration reached; finishing");
      this.finish();
    });
    log.debug(`DictationController: ${handsFree ? "listening hands-free" : "arming"} (generation ${current})`);
  }

  /** Space during the hold: switches between dictation and agent mode; a follow-up in the chat
   * window stays in agent mode. */
  toggleMode(): void {
    const kind = this.currentPhase.kind;
    if (kind !== "arming" && kind !== "listening") return;
    if (this.currentChat !== null) return;
    this.currentMode = toggled(this.currentMode);
    // Space was used; the tip, which teaches the history too, shows again at the next hold.
    if (this.currentTip === "agentAndHistory") this.hideTip();
    if (this.currentMode === "agent") this.prepareAgent();
    this.updateNameTip();
    this.updateTools();
    log.debug(`DictationController: switched to ${this.currentMode}`);
  }

  finish(): void {
    if (this.spokenAnswer !== null) return this.finishSpokenAnswer();
    switch (this.currentPhase.kind) {
      case "arming": {
        // Released before the hold became deliberate: a tap. Nothing was shown. Unless a second
        // press follows within `doubleTapWindow` (a double tap: hands-free), it is discarded unseen.
        if (this.secondTapTimer !== null) return;
        log.debug("DictationController: tap; waiting for a second press");
        cancelTimer(this.revealTimer);
        this.revealTimer = null;
        cancelTimer(this.longHoldTimer);
        this.longHoldTimer = null;
        const current = this.generation;
        this.secondTapTimer = after(config.doubleTapWindow, () => {
          if (this.generation !== current) return;
          log.debug("DictationController: no second press; discarding");
          this.discard();
        });
        return;
      }
      case "listening":
        break;
      default:
        return;
    }
    if (this.recorder === null) return;
    cancelTimer(this.maxDurationTimer);
    this.maxDurationTimer = null;
    // The muted check covers the hold only; it must not outlive it into a spoken answer.
    cancelTimer(this.silenceTimer);
    this.silenceTimer = null;
    this.endTips();

    // Keep the microphone open briefly after release so the last word isn't clipped.
    const current = this.generation;
    this.currentLevel = 0;
    this.setPhase({ kind: "transcribing" });
    const releasedAt = performance.now();
    this.releasedAt = releasedAt;
    log.debug(() => `DictationController: released after ${this.startedAt === null ? "?" : elapsed(this.startedAt)}; recording ${config.releaseTailDuration}ms more`);
    this.releaseTailTimer = after(config.releaseTailDuration, () => {
      if (this.generation !== current) return;
      void this.completeRecording(current, releasedAt);
    });
  }

  cancel(): void {
    // Only the answer being spoken: its question, and the request that asks it, go on.
    if (this.spokenAnswer !== null) return this.abandonSpokenAnswer("canceled");
    if (isResting(this.currentPhase)) return;
    log.debug("DictationController: canceled");
    this.discard();
  }

  /** Waits `wait` for the screen read. One not done by then is asked to stop and answer with what
   * it has read so far, a valid read of part of the window (ADR-DESK-053), which is waited for as
   * long again; `late` when even that does not come. */
  private async waitForScreen(read: Promise<ScreenRead | null>, wait: number): Promise<{ screen: ScreenRead | null; stopped: boolean; late: boolean }> {
    try {
      return { screen: await withTimeout(wait, () => read), stopped: false, late: false };
    } catch {
      this.stopContext?.(read);
    }
    try {
      return { screen: await withTimeout(wait, () => read), stopped: true, late: false };
    } catch {
      return { screen: null, stopped: true, late: true };
    }
  }

  /** The names and terms on the screen read at key-down (`contextTerms`), sent with the recording
   * after the dictionary's words, as many as the vocabulary has room for (ADR-DESK-038): those of what
   * the window shows first, only if that read is done by the upload (a dictation waits `contextWait`
   * for it, agent mode not at all), then those of the whole window in the room left, only if it is
   * done by then too (never waited for: ADR-DESK-016, 2026-10-25); none when the screen is not read. */
  private screenTerms(dictionary: readonly string[]): string[] {
    const termsOf = (screen: ScreenContext | null, excluding: readonly string[], max: number) =>
      screen && max > 0 ? contextTerms(`${screen.windowTitle ?? ""}\n${screen.renderedText}`, excluding, max) : [];
    const room = config.vocabularyMaxTerms - dictionary.length;
    const shown = termsOf(this.screenRead, dictionary, room);
    const window = termsOf(this.screenRead && this.windowScreen, [...dictionary, ...shown], room - shown.length);
    log.debug(() => `DictationController: sending ${dictionary.length} dictionary word(s), ${shown.length} screen term(s) and ${window.length} from the whole window`);
    return [...shown, ...window];
  }

  /** Transcribes one recording, cleaned up in the same request, and inserts it (dictation), or
   * transcribes it and carries it out (agent mode). Its wait for the text ends
   * `transcriptionDeadline` after `releasedAt`. */
  private async transcribe(flac: Uint8Array, generation: number, releasedAt: number): Promise<void> {
    const signal = this.abort.signal;
    const isCurrent = () => this.generation === generation && !signal.aborted;
    const deadline = releasedAt + this.transcriptionDeadline;
    await this.deliver(generation, () =>
      this.withinDeadline(deadline, async (timeout) => {
        const upload = await this.preparedUpload(false);
        if (!isCurrent()) return null;
        log.debug(`DictationController: uploading ${flac.length} bytes`);
        const requestSignal = AbortSignal.any([signal, timeout]);
        const transcription = await this.transcribeRetrying(() => upload.send(flac, requestSignal), isCurrent, requestSignal);
        return { parts: [{ transcription, overlapped: false }], lost: null, deadline };
      }),
    );
  }

  /** Runs `operation`, a dictation's wait for its text, until `deadline` (owner, 2026-10-08: "nobody
   * waits for dictation more than 10" seconds; every retry falls inside it). Past it, `operation`'s
   * signal aborts, calling off its requests and waits, and it fails at once as a request that timed
   * out ("TabMail took too long to answer"). */
  private async withinDeadline<T>(deadline: number, operation: (timeout: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return await withTimeout(Math.max(0, deadline - performance.now()), operation);
    } catch (error) {
      if (error instanceof TimeoutError) throw new TransportError("timeout");
      throw error;
    }
  }

  /** What every upload of this dictation sends with its audio, prepared by its first upload: the
   * account signed in then (every request goes under it, even if the user switches accounts while
   * they run), the keyboard's language, the dictionary and the screen's terms, and in dictation mode
   * the cleanup's variables, with the screen context read at key-down if it is done in time (best
   * effort, ADR-DESK-008): they go with the recording, for the backend's cleanup. A long dictation's
   * chunks always take the cleanup: the first is sent before the release, and the user may still
   * switch to agent mode and back (agent mode reads only the transcript). */
  private preparedUpload(forChunks: boolean): Promise<Upload> {
    this.upload ??= this.prepareUpload(forChunks);
    return this.upload;
  }

  private async prepareUpload(forChunks: boolean): Promise<Upload> {
    const account = this.deps.account;
    const userID = account.session?.userID ?? null;
    const settings = this.dictationSettings;
    // Smart Dictation off (Settings, the default): no cleanup, so no screen to wait for.
    const cleans = settings.smartDictation && (forChunks || this.currentMode === "dictation");
    // This dictation's screen read, taken before the first wait: once that wait ends, a newer hold
    // may have started its own, which this one must never stop.
    const read = this.contextRead;
    const preparing = performance.now();
    const language = await this.languageRead;
    log.debug(() => `DictationController: keyboard language read after ${elapsed(preparing)}`);
    let context: ScreenContext | null = null;
    if (cleans) {
      const waiting = performance.now();
      const waited = read ? await this.waitForScreen(read, this.contextWait) : null;
      context = screenShown(waited?.screen ?? null);
      if (waited?.late) log.debug(`DictationController: screen read not done in time (waited ${elapsed(waiting)}); continuing without it`);
      else if (waited) log.debug(() => `DictationController: waited ${elapsed(waiting)} for the screen read${waited.stopped ? ", stopped with what it had read" : ""}`);
    }
    const cleanup = cleans ? DictationCleanup.variables(context, settings.dictionary) : undefined;
    const client = this.deps.makeTranscriptionClient(settings.backendURL);
    const completions = this.deps.makeCompletionsClient(settings.backendURL);
    const vocabulary = [...settings.dictionary, ...this.screenTerms(settings.dictionary)];
    return {
      send: (flac, signal) => withFreshToken(account, userID, (token) => client.transcribe(flac, language, vocabulary, token, signal, cleanup)),
      polish: cleanup
        ? (text, signal) =>
            withFreshToken(account, userID, (token) => completions.complete({ role: "system", content: DictationCleanup.prompt, vars: { ...cleanup, dictation: text } }, token, signal))
        : null,
    };
  }

  /** Waits for the transcription `obtain` gets, in its parts (one, or a long dictation's chunks), and
   * inserts it (dictation) or carries it out (agent mode). `obtain` answers null when the dictation
   * ended meanwhile. With `lost` (a long dictation whose later chunks failed), a dictation pastes what
   * came before them as any dictation's text, with nothing said of the end (owner, 2026-10-09: "paste
   * directly whatever it has"); agent mode carries out nothing of it. */
  private async deliver(generation: number, obtain: () => Promise<{ parts: TranscribedPart[]; lost: unknown; polish?: Polish | null; deadline: number } | null>): Promise<void> {
    // Agent mode's requests go under the account signed in now, even if the user switches accounts
    // while they run.
    const account = this.deps.account;
    const userID = account.session?.userID ?? null;
    const settings = this.dictationSettings;
    const mode = this.currentMode;
    const signal = this.abort.signal;
    const targetApp = this.targetApp;
    const isCurrent = () => this.generation === generation && !signal.aborted;
    let lost: unknown = null;
    try {
      const read = this.contextRead;
      const windowRead = this.windowRead;
      let context: ScreenContext | null = null;
      const started = performance.now();
      const result = await obtain();
      if (result === null || !isCurrent()) return;
      const { parts } = result;
      lost = result.lost;
      // Every part, empty ones too: an overlapped chunk is joined to the one just before it only.
      const texts = parts.map((part) => ({ ...part, text: trimWhitespace(part.transcription.text) }));
      const heard = texts.filter((part) => part.text !== "");
      const transcript = joinChunkTexts(texts);
      if (lost !== null && (transcript === "" || mode !== "dictation")) throw lost;
      log.debug(() => `DictationController: transcript ready in ${elapsed(started)}${this.sinceRelease()} (${charCount(transcript)} chars${parts.length > 1 ? `, ${parts.length} chunks` : ""})`);
      log.content(`Transcript (${mode})`, transcript);
      if (transcript === "") {
        this.teardown();
        this.fail(nothingHeardMessage);
        return;
      }
      this.deps.useWords(heard.flatMap((part) => (part.transcription.cleanedText === null ? [part.text] : [part.text, part.transcription.cleanedText])));
      if (mode === "dictation") {
        const joined = joinChunkTexts(texts.map((part) => ({ text: part.text === "" || !settings.smartDictation ? part.text : DictationCleanup.pasted(part.text, part.transcription.cleanedText), overlapped: part.overlapped })));
        const text = result.polish ? await this.polished(joined, result.polish, result.deadline, signal) : joined;
        if (!isCurrent()) return;
        await this.paste(text, targetApp, signal, this.screenRead);
        const corrections = this.deps.corrections;
        if (settings.learnsWords && corrections) {
          // Resolved already: the paste was checked against it.
          const target = await targetApp;
          if (target !== null && isCurrent()) corrections.watch(target, text, { apps: settings.excludedApps, sites: settings.excludedSites });
        }
      } else {
        // The request shows in the chat window as soon as it is heard, and under it what the agent
        // does as it runs, whether it then answers or writes (owner, 2026-10-09: "always show what's
        // going on").
        const chat = this.currentChat;
        this.setChat({ ...(chat ?? this.newChat()), pendingRequest: transcript });
        // All of it: its selection decides between Edit and Compose, as the bubbles showed.
        const waiting = performance.now();
        const waited = read ? await this.waitForScreen(read, this.agentScreenWait) : null;
        const screen = waited?.screen ?? null;
        if (waited) log.debug(() => `DictationController: agent waited ${elapsed(waiting)} for the screen read${waited.stopped ? ", stopped with what it had read" : ""}${waited.late ? ", not done" : ""}`);
        context = screenShown(screen);
        const screenHidden = isScreenHidden(screen);
        if (!isCurrent()) return;
        const looking = performance.now();
        const email = await this.lookUpEmailApp();
        log.debug(() => `DictationController: email app known after ${elapsed(looking)}`);
        if (!isCurrent()) return;
        const client = this.deps.makeCompletionsClient(settings.backendURL);
        // The tools the bubbles show: the same read and settings.
        const offered = DesktopAgent.tools(context, settings.enabledTools);
        if (offered.length === 0) throw new AgentError("noToolEnabled");
        const conversation = chat ? chatTranscript(chat) : "";
        // The loop thinks under no tool's bubble: only an app whose tool runs, until the agent answers
        // or writes.
        this.setPhase({ kind: "running", tool: null });
        // Only the tools of apps switched on at key-down are offered, and only those run; with Answer off
        // none is offered (`requestTools`), and none runs: the backend passes on whatever the model calls.
        const connectorTools = offered.includes("answer") ? this.deps.connectorTools.filter((connectorTool) => settings.enabledConnectors.includes(connectorTool.connector)) : [];
        // This request's searches, for their later pages.
        const memoryTools = new MemoryTools(this.deps.memory);
        const personalization = this.dictationPersonalization;
        // What the tools work with, from the settings read at key-down: a change meanwhile applies next time.
        const toolSettings: ToolSettings = { eventDuration: settings.eventDuration };
        const registry = this.requestTools(offered, connectorTools, memoryTools, toolSettings, windowRead, context, email.app, transcript, targetApp, isCurrent, signal);
        const { tool, text } = await DesktopAgent.run(
          transcript, context, screenHidden, conversation, settings.userName, personalization, registry,
          client, account, userID, (event) => registry.serverEvent(event), signal,
        );
        if (!isCurrent()) return;
        this.remember(transcript, agentPart(text, registry.get(tool)?.chatCaption ?? null, context?.appName ?? null), settings.memorySizeLimit);
      }
      if (this.generation !== generation) return;
      this.teardown();
      if (lost !== null) log.error(`DictationController: the end of a long dictation was lost (${errorName(lost)})`);
      this.setPhase({ kind: "idle" });
    } catch (error) {
      if (!isCurrent()) return;
      this.teardown();
      if (error instanceof NotPastedError) {
        if (lost !== null) log.error(`DictationController: the end of a long dictation was lost (${errorName(lost)})`);
        this.showMessage({ kind: "notPasted", message: error.message, text: error.text }, config.notPastedDisplayDuration);
        return;
      }
      log.error(`DictationController: ${mode} failed: ${errorName(error)}`);
      this.fail(error instanceof Error && error.message !== "" ? error.message : "Dictation failed. Please try again.");
    }
  }

  /** A long dictation's joined text (its chunks' cleanups), polished as a whole by the cleanup prompt
   * if that answers within `chunkPolishTimeout` and before the dictation's `deadline` (owner,
   * 2026-10-03: "a final polished pass if time permits"): the chunks' seams read as one text. Else,
   * or when it fails or comes back empty, `text` as it is: a failed polish never costs the user their
   * dictation, as a failed cleanup doesn't. */
  private async polished(text: string, polish: Polish, deadline: number, signal: AbortSignal): Promise<string> {
    const started = performance.now();
    const allowed = Math.min(this.chunkPolishTimeout, deadline - started);
    if (allowed <= 0) {
      log.debug("DictationController: no time left to polish; pasting the chunks' cleanups");
      return text;
    }
    try {
      const polishedText = trimWhitespace(await withTimeout(allowed, (timeout) => polish(text, AbortSignal.any([signal, timeout]))));
      if (polishedText === "") {
        log.debug("DictationController: polish came back empty; pasting the chunks' cleanups");
        return text;
      }
      log.debug(() => `DictationController: polished in ${elapsed(started)}${this.sinceRelease()} (${charCount(text)} → ${charCount(polishedText)} chars)`);
      return polishedText;
    } catch (error) {
      if (signal.aborted) throw error;
      log.debug(`DictationController: polish ${error instanceof TimeoutError ? "ran out of time" : `failed (${errorName(error)})`} after ${elapsed(started)}; pasting the chunks' cleanups`);
      return text;
    }
  }

  /** Warms the backend at key-down (`warmUp`), under the account signed in now. Best effort: nothing
   * waits for it, and a failure is only logged. */
  private async warmUp(backendURL: string): Promise<void> {
    const account = this.deps.account;
    try {
      await withFreshToken(account, account.session?.userID ?? null, (token) => this.deps.warmUp(backendURL, token));
    } catch (error) {
      log.debug(`DictationController: warm-up failed: ${errorName(error)}`);
    }
  }

  /** Makes the transcription request, and makes it again after a server error (a 5xx other than the
   * backend's own timeout: the speech model behind it failed; or its rate limit) or a dropped connection, up to
   * `transcriptionRetryDelays.length` more times while the dictation's deadline allows (the caller's
   * `withinDeadline`), so the user need not say it again. The pill keeps
   * transcribing until `transcriptionRetryNoticeDelay` has passed since the first failure, then says
   * it is retrying while it waits and tries, and goes back to transcribing once a retry answers. Any
   * other failure (signed out, over quota, a refused request, a timeout) fails at once. */
  private async transcribeRetrying(request: () => Promise<Transcription>, isCurrent: () => boolean, signal: AbortSignal): Promise<Transcription> {
    const notice = this.retryNotice(isCurrent, signal);
    try {
      for (let retry = 0; ; retry += 1) {
        const sent = performance.now();
        try {
          const transcription = await request();
          log.debug(() => `DictationController: transcription answered in ${elapsed(sent)}`);
          notice.answered();
          return transcription;
        } catch (error) {
          const delay = this.transcriptionRetryDelays[retry];
          if (delay === undefined || !isServerError(error) || !isCurrent()) throw error;
          log.debug(`DictationController: transcription failed (${errorName(error)}) after ${elapsed(sent)}; retrying in ${delay}ms`);
          notice.failed();
          await sleep(delay, signal);
        }
      }
    } finally {
      // Answered, failed or canceled: the note must not come up over what follows.
      notice.end();
    }
  }

  /** The retry hint and note of a transcription (`transcribeRetrying`), or of a long dictation's
   * chunks after the release: `failed` at each server error marks it retrying (`isRetrying`) and,
   * `transcriptionRetryNoticeDelay` after the first, shows the note; `answered` goes back to
   * transcribing if the note showed; `end` clears both. Once `signal` aborts, neither changes the
   * phase: a transcription its deadline gave up on may still be in a retry (`withinDeadline` does not
   * wait for it), and its note must not come up over the failure, or the next dictation. */
  private retryNotice(isCurrent: () => boolean, signal: AbortSignal): RetryNotice {
    let timer: Timer | null = null;
    let shown = false;
    let attempt: { generation: number; signal: AbortSignal } | null = null;
    return {
      failed: () => {
        attempt ??= { generation: this.generation, signal };
        if (this.retrying !== attempt) {
          this.retrying = attempt;
          this.changed();
        }
        timer ??= setTimeout(() => {
          if (!isCurrent() || signal.aborted) return;
          shown = true;
          this.setPhase({ kind: "retrying", message: retryingMessage });
        }, this.transcriptionRetryNoticeDelay);
      },
      answered: () => {
        if (shown && isCurrent() && !signal.aborted) this.setPhase({ kind: "transcribing" });
      },
      end: () => {
        if (timer !== null) clearTimeout(timer);
        if (attempt !== null && this.retrying === attempt) {
          this.retrying = null;
          this.changed();
        }
      },
    };
  }

  /** The recorder cut a chunk off a long dictation (ADR-DESK-049): it is sent at once, with its
   * cleanup, while the user goes on. Every chunk is sent, a long silence's too: the model decides
   * what was said, as for one recording (ADR-DESK-005: no loudness gate), and soft speech judged by
   * loudness alone could be lost (owner, 2026-10-03: send every chunk). */
  private chunkCut(chunk: RecordedChunk, generation: number): void {
    if (this.generation !== generation) return;
    log.debug(() => `DictationController: chunk ${chunk.index} cut at ${(chunk.end / config.recordingSampleRate).toFixed(1)}s (${((chunk.end - chunk.start) / config.recordingSampleRate).toFixed(1)}s${chunk.overlapped ? ", overlapping the one before" : ""})`);
    this.chunks.push({ index: chunk.index, overlapped: chunk.overlapped, outcome: this.sendChunk(chunk, generation) });
  }

  /** Transcribes one chunk, never failing: its transcription, or why it gave up. */
  private async sendChunk(chunk: RecordedChunk, generation: number): Promise<ChunkOutcome> {
    const signal = this.chunkAbort.signal;
    const release = this.release;
    const isCurrent = () => this.generation === generation && !signal.aborted;
    try {
      const upload = await this.preparedUpload(true);
      if (!isCurrent()) throw new CancellationError();
      log.debug(`DictationController: uploading chunk ${chunk.index} (${chunk.flac.length} bytes)`);
      const sent = performance.now();
      const transcription = await this.transcribeChunk(() => upload.send(chunk.flac, signal), isCurrent, signal, release);
      log.debug(() => `DictationController: chunk ${chunk.index} transcribed in ${elapsed(sent)}`);
      return { transcription };
    } catch (error) {
      if (isCurrent()) log.error(`DictationController: chunk ${chunk.index} failed for good: ${errorName(error)}`);
      return { error };
    }
  }

  /** Makes a chunk's request until it answers (owner, 2026-10-03: "retries should keep on happening
   * until the final give up"). While the user is still dictating, a server error, a dropped
   * connection, the speech model's rate limit, or the backend's own timeout (`backendTimedOut`) is tried
   * again after each of `chunkRetryDelays`, the last repeating, for as long as the dictation goes
   * on: nobody waits for it yet. From the release, it gets `transcriptionRetryDelays` more tries on
   * the same failures, with the pill's retry note, so the end of a dictation is not lost to a burst
   * of rate limits (owner, 2026-10-03), until the dictation's deadline (`transcribeChunks`, owner
   * 2026-10-08) ends it. Any other failure (signed out, over quota, a refused request) gives up at once. */
  private async transcribeChunk(request: () => Promise<Transcription>, isCurrent: () => boolean, signal: AbortSignal, release: Release): Promise<Transcription> {
    let waits = 0;
    let lastTries = 0;
    for (;;) {
      try {
        return await request();
      } catch (error) {
        if (!isCurrent()) throw error;
        if (!release.done) {
          if (!isServerError(error) && !backendTimedOut(error)) throw error;
          const delay = this.chunkRetryDelays[Math.min(waits, this.chunkRetryDelays.length - 1)] ?? 0;
          waits += 1;
          log.debug(`DictationController: chunk failed while recording (${errorName(error)}); retrying in ${delay}ms`);
          // The release cuts the wait short: its last tries start at once.
          await Promise.race([sleep(delay, signal), release.released]);
          continue;
        }
        const delay = this.transcriptionRetryDelays[lastTries];
        if (delay === undefined || (!isServerError(error) && !backendTimedOut(error))) throw error;
        lastTries += 1;
        log.debug(`DictationController: chunk failed after the release (${errorName(error)}); retrying in ${delay}ms`);
        release.notice?.failed();
        await sleep(delay, signal);
      }
    }
  }

  /** The release of a dictation cut into chunks: the last one is sent, the chunks still failing get
   * their last tries, and the text is the chunks' in order up to the first that gave up (owner,
   * 2026-10-03: "paste only the up to successful part"). The first giving up loses the dictation, as
   * one recording's failure does. A chunk not in by `transcriptionDeadline` after the release gives
   * up then, as a request that timed out (owner, 2026-10-08), and the chunks after it are called off. */
  private async transcribeChunks(last: RecordedChunk, generation: number, releasedAt: number): Promise<void> {
    const deadline = releasedAt + this.transcriptionDeadline;
    const signal = this.chunkAbort.signal;
    const isCurrent = () => this.generation === generation && !signal.aborted;
    this.chunkCut(last, generation);
    const release = this.release;
    const notice = this.retryNotice(isCurrent, signal);
    release.notice = notice;
    release.done = true;
    release.markReleased();
    const chunks = this.chunks;
    const chunkAbort = this.chunkAbort;
    // This dictation's upload, which its first chunk prepared and every part went with. Taken now: a
    // dictation started while the chunks are awaited prepares its own.
    const upload = this.upload;
    // Once the text is known, the retry note and any chunk after one that gave up end at once, not
    // after the paste or the agent's run.
    const settled = <T>(result: T): T => {
      notice.answered();
      notice.end();
      chunkAbort.abort();
      return result;
    };
    try {
      await this.deliver(generation, async () => {
        const parts: TranscribedPart[] = [];
        let lost: unknown = null;
        let outOfTime = false;
        for (const chunk of chunks) {
          // A chunk's outcome never fails: only the deadline does.
          const outcome = await this.withinDeadline(deadline, () => chunk.outcome).catch((error: unknown): ChunkOutcome => {
            outOfTime = true;
            return { error };
          });
          if ("error" in outcome) {
            lost = outcome.error;
            break;
          }
          parts.push({ transcription: outcome.transcription, overlapped: chunk.overlapped });
        }
        // Out of time, there is none for a polish either. Said here, not left to `polished`'s clock: a
        // timer may fire up to a millisecond early (Node truncates its delay), leaving that clock a
        // fraction of one, and the whole text would go out for a request called off at once.
        const { polish } = parts.length > 1 && upload && !outOfTime ? await upload : { polish: null };
        return settled({ parts, lost, polish, deadline });
      });
    } finally {
      notice.end();
      // Any chunk after one that gave up is no longer needed. This dictation's own: a dictation
      // started since has its own.
      chunkAbort.abort();
    }
  }

  /** Bind one flat tool list to this request's captured context and settings. */
  private requestTools(offered: readonly AgentToolID[], connectorTools: readonly ConnectorTool[], memory: MemoryTools, settings: ToolSettings, windowRead: Promise<ScreenRead | null> | null, context: ScreenContext | null, emailApp: string | null, transcript: string, targetApp: Promise<number | null>, isCurrent: () => boolean, signal: AbortSignal): ToolRegistry {
    const definitions: RegisteredTool[] = [
      ...config.answerServerTools.filter(() => offered.includes("answer")).map((name) => ({ name, terminal: false })),
      ...connectors.filter((connector) => connectorTools.some((tool) => tool.connector === connector.id)).flatMap((connector) => (connector.serverTools ?? []).map((name) => ({ name, terminal: false, bubble: connector.id }))),
      ...(connectorTools.length === 0 ? [] : [{ name: config.confirmationTool, terminal: false, preservesConfirmation: true, run: (call: ToolCall, round: number) => this.runConfirmationTool(call, round, (tool, args) => registry.perform(tool.name, () => this.runTool(tool, args, settings, signal), tool.progressLabelFor?.(args))) }]),
      ...connectorTools.map((tool) => ({ name: tool.name, terminal: tool.terminal ?? false, bubble: tool.connector, progressLabel: tool.progressLabel, deferredActivity: true, run: (call: ToolCall, round: number) => this.runConnectorTool(tool, call, round, settings, isCurrent, signal, (args) => registry.perform(tool.name, () => this.runTool(tool, args, settings, signal), tool.progressLabelFor?.(args))) })),
      ...MemoryTools.names.map((name) => ({ name, terminal: false, bubble: memoryBubble, progressLabel: config.memoryToolProgressLabel, run: (call: ToolCall) => this.runMemoryTool(call, memory) })),
      ...KBTools.names.map((name) => ({ name, terminal: false, bubble: memoryBubble, run: async (call: ToolCall) => this.runKBTool(call) })),
      ...(windowRead !== null && context !== null ? [{ name: config.screenReadTool, terminal: false, bubble: screenReadBubble, progressLabel: config.screenReadProgressLabel, run: () => this.runScreenRead(windowRead) }] : []),
      ...offered.map((name) => {
        const definition = agentTools[name];
        return { name, terminal: definition.terminal, bubble: name, chatCaption: definition.chatCaption, response: definition.response, advertise: !definition.response,
          check: (call: ToolCall) => void definition.text(parsedJSON(call.function.arguments), context),
          run: async (call: ToolCall) => {
            const text = definition.text(parsedJSON(call.function.arguments), context);
            log.content(`DesktopAgent: ${name} wrote`, text);
            if (!isCurrent()) { signal.throwIfAborted(); throw new AgentError("noText"); }
            if (definition.closesChat) this.dropChat();
            this.setPhase({ kind: "running", tool: name });
            await definition.deliver(text, { emailApp, paste: (text) => this.paste(text, targetApp, signal, context), thunderbird: this.deps.thunderbird, showAnswer: (answer) => { if (isCurrent()) this.showInChat(transcript, name, answer); }, signal });
            return text;
          },
        };
      }),
    ];
    const registry = new ToolRegistry(definitions, (tool, running, label) => {
      if (!isCurrent()) return;
      if (tool.bubble) {
        if (running) this.appStarted(tool.bubble);
        else this.appEnded(tool.bubble);
      }
      const progress = label === undefined ? tool.progressLabel : label;
      if (progress !== undefined) this.updateChat({ activity: running ? progress : null });
    }, (tool) => {
      if (isCurrent() && !tool?.preservesConfirmation) this.dropAnsweredAloud();
    });
    return registry;
  }

  /** Runs a tool agent mode's model called, and returns what the model reads next: the tool's
   * result, that the user declined, what the user answered aloud, or why it could not run. The chat
   * window, open since the request was heard, shows which tool runs, and asks first for a tool that
   * sends or creates. An answer spoken to the question goes to the model, which reads
   * whether it agrees and answers the question for the user (`config.confirmationTool`): confirmed,
   * the call that asked runs as the user was shown it. The confirmation names the question it answers
   * (its `question_id`), so it never runs another. Any other call drops the waiting one and is asked
   * about as usual. */
  private async runConfirmationTool(call: ToolCall, round: number, run: (tool: ConnectorTool, args: Record<string, unknown>) => Promise<string>): Promise<string> {
    const waiting = this.answeredAloud;
    const answer = parsedJSON(call.function.arguments);
    if (waiting === null) {
      log.error(`DictationController: ${config.confirmationTool} called with no spoken answer waiting`);
      return config.confirmationToolNothingWaiting;
    }
    // One written in the round that asked was written before the user answered, and one naming
    // another question answers it nothing: the answer waits on, for a confirmation that names it.
    if (round <= waiting.round) {
      log.error(`DictationController: ${config.confirmationTool} called in the round that asked`);
      return config.confirmationToolNothingWaiting;
    }
    if (isJSONObject(answer) && answer.question_id !== waiting.id) {
      log.error(`DictationController: ${config.confirmationTool} called for another question`);
      return config.confirmationToolNothingWaiting;
    }
    // Otherwise the call the user answered aloud is answered by the model's very next call only.
    if (!isJSONObject(answer) || typeof answer.confirmed !== "boolean") {
      this.dropAnsweredAloud();
      log.error(`DictationController: ${config.confirmationTool} called without true or false`);
      return config.confirmationToolNoAnswer;
    }
    this.answeredAloud = null;
    log.debug(`DictationController: ${waiting.tool.name} ${answer.confirmed ? "confirmed" : "declined"} for the user`);
    // The question the user answered aloud shows the model's answer ticked, as a click would.
    this.settleQuestion(waiting.question, answer.confirmed ? "confirmed" : "declined");
    return answer.confirmed ? run(waiting.tool, waiting.args) : config.connectorToolDeclined;
  }

  private async runConnectorTool(tool: ConnectorTool, call: ToolCall, round: number, settings: ToolSettings, isCurrent: () => boolean, signal: AbortSignal, run: (args: Record<string, unknown>) => Promise<string>): Promise<string> {
    const args = parsedJSON(call.function.arguments);
    if (!isJSONObject(args)) {
      log.error(`DictationController: ${tool.name} called with arguments that aren't a JSON object`);
      return "Error: the arguments were not a JSON object.";
    }
    let asked: ToolQuestion | null;
    try {
      asked = await tool.confirmation(args, signal, settings);
    } catch (error) {
      if (!isCurrent() || signal.aborted) return config.connectorToolUnanswered;
      log.error(`DictationController: ${tool.name} preparation failed: ${errorName(error)}`);
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    // Preparing a confirmation may resolve a local file path asynchronously. A canceled or
    // superseded request must never reopen its question or run the tool after that lookup.
    if (!isCurrent() || signal.aborted) return config.connectorToolUnanswered;
    // Closing the window or ending the request declines the question (`teardown`); the window is
    // open from the request's start.
    if (asked !== null) {
      const question = typeof asked === "string" ? asked : asked.text;
      const { answer, kept } = await this.confirm(question, typeof asked === "string" ? null : asked.event);
      if (typeof answer !== "string") {
        log.debug(`DictationController: ${tool.name} answered aloud`);
        this.questionsAnsweredAloud += 1;
        const id = `q${this.questionsAnsweredAloud}`;
        if (isCurrent()) this.answeredAloud = { tool, args, round, id, question: kept };
        return config.connectorToolAnsweredAloud(question, answer.spoken, id);
      }
      if (answer !== "confirmed") {
        log.debug(`DictationController: ${tool.name} ${answer}`);
        return config.connectorToolDeclined;
      }
    }
    return run(args);
  }

  /** Runs a memory tool: it only reads, so it asks nothing; memory's bubble runs, and the chat window
   * says what it does. */
  private async runMemoryTool(call: ToolCall, memoryTools: MemoryTools): Promise<string> {
    const args = parsedJSON(call.function.arguments);
    if (!isJSONObject(args)) {
      log.error(`DictationController: ${call.function.name} called with arguments that aren't a JSON object`);
      return "Error: the arguments were not a JSON object.";
    }
    log.debug(`DictationController: running ${call.function.name}`);
    return memoryTools.run(call.function.name, args);
  }

  /** Runs `screen_read`: waits for the whole window as agent mode waits for the screen
   * (`waitForScreen`), and tells the model its text, that it is hidden, or that it gave nothing. It
   * only reads, so it asks nothing; the chat window says what it does. */
  private async runScreenRead(window: Promise<ScreenRead | null>): Promise<string> {
    log.debug(`DictationController: running ${config.screenReadTool}`);
    const waiting = performance.now();
    const waited = await this.waitForScreen(window, this.agentScreenWait);
    log.debug(() => `DictationController: waited ${elapsed(waiting)} for the whole window${waited.stopped ? ", stopped with what it had read" : ""}${waited.late ? ", not done" : ""}`);
    if (isScreenHidden(waited.screen)) return screenHiddenNote;
    const screen = screenShown(waited.screen);
    if (screen === null) return config.screenReadUnavailable;
    log.debug(() => `DictationController: ${config.screenReadTool} gave ${charCount(screen.renderedText)} chars`);
    return screen.renderedText;
  }

  /** Runs a knowledge-base tool: it edits only the user's own knowledge base, so it asks nothing.
   * Memory's bubble runs for it (`requestTools`); it runs at once, so the chat window shows no activity
   * for it, and Settings shows the change. */
  private runKBTool(call: ToolCall): string {
    const args = parsedJSON(call.function.arguments);
    if (!isJSONObject(args)) {
      log.error(`DictationController: ${call.function.name} called with arguments that aren't a JSON object`);
      return "Error: the arguments were not a JSON object.";
    }
    log.debug(`DictationController: running ${call.function.name}`);
    return new KBTools(this.deps.prompts).run(call.function.name, args);
  }

  /** Keeps an agent-mode request and what came of it (`agent`) in memory, within `maxBytes`, the size
   * limit at key-down. Best effort: nothing waits for it, and a failure is only logged. */
  private remember(request: string, agent: string, maxBytes: number): void {
    const row = memoryRow(request, agent, Date.now(), globalThis.crypto.randomUUID());
    this.deps.memory.index([row], maxBytes).catch((error: unknown) => log.error(`DictationController: memory not kept: ${errorName(error)}`));
  }

  /** Agent mode was chosen for this dictation: what its request will need is looked up meanwhile, the
   * email app, and the memory helper, whose first start downloads its model. */
  private prepareAgent(): void {
    void this.lookUpEmailApp();
    this.deps.memory.prepare();
  }

  /** Runs `tool`, confirmed if it asks: the chat window says what it does, and its app's bubble runs. */
  private async runTool(tool: ConnectorTool, args: Record<string, unknown>, settings: ToolSettings, signal: AbortSignal): Promise<string> {
    log.debug(`DictationController: running ${tool.name}`);
    try {
      return await tool.run(args, signal, settings);
    } catch (error) {
      log.error(`DictationController: ${tool.name} failed: ${errorName(error)}`);
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** One of `connector`'s tools starts (or memory's): its bubble moves to the front of the history and
   * runs. */
  private appStarted(connector: BubbleKey): void {
    this.recent = ranNow(this.recent, connector);
    this.runningApps.add(connector);
    this.changed();
  }

  /** One of `connector`'s tools ends: the bubble still running (another app's, or the tool agent mode
   * answers or writes with), if any, moves back to the front. */
  private appEnded(connector: BubbleKey): void {
    this.runningApps.delete(connector);
    const running = this.runningBubble;
    if (running !== null) this.recent = ranNow(this.recent, running);
    this.changed();
  }

  /** Shows `question` in the chat window, and waits for the user to confirm or decline it
   * (`answerConfirmation`) or answer it aloud (`startSpokenAnswer`); closing the window or canceling
   * the request declines it, and so does leaving it unanswered for `confirmationTimeout`. */
  private confirm(question: string, event: EventQuestion | null): Promise<{ answer: ConfirmationAnswer; kept: number | null }> {
    this.confirmationShownAt = Date.now();
    this.updateChat({ confirmation: question, confirmationEvent: event });
    return new Promise((resolve) => {
      this.confirmationReply = (answer, kept) => resolve({ answer, kept });
      this.startConfirmationClock();
    });
  }

  /** The question's time to answer starts: from when it shows, and again, whole, when an answer
   * spoken to it came to nothing. */
  private startConfirmationClock(): void {
    cancelTimer(this.confirmationTimer);
    this.updateChat({ confirmationExpiresAt: Date.now() + this.confirmationTimeout });
    this.confirmationTimer = after(this.confirmationTimeout, () => {
      this.confirmationTimer = null;
      // Left unanswered, it is declined, as with a click on Cancel (owner, 2026-10-20).
      this.replyToConfirmation("declined");
    });
  }

  /** The user confirmed (true) or declined the chat window's question. An answer that comes before
   * the question has shown for `confirmationMinimumDisplay` was meant for the one before it (the
   * second click of a double-click), and is ignored. */
  answerConfirmation(confirmed: boolean): void {
    if (Date.now() - this.confirmationShownAt < this.confirmationMinimumDisplay) {
      log.debug("DictationController: an answer too soon after the question was ignored");
      return;
    }
    this.replyToConfirmation(confirmed ? "confirmed" : "declined");
  }

  private replyToConfirmation(answer: ConfirmationAnswer): void {
    const reply = this.confirmationReply;
    if (reply === null) return;
    this.confirmationReply = null;
    cancelTimer(this.confirmationTimer);
    this.confirmationTimer = null;
    // Answered another way (a click, the window closing) while an answer was being spoken.
    this.endSpokenAnswer();
    // The question stays where it was asked, its answer ticked on it; one answered aloud waits for
    // the model's reading of the words (owner, 2026-10-20: the answer shows, and the question stays).
    const chat = this.currentChat;
    let kept: number | null = null;
    if (chat !== null && chat.confirmation !== null) {
      this.questionsKept += 1;
      kept = this.questionsKept;
      const spoken = typeof answer === "string" ? null : answer.spoken;
      const question = { id: kept, text: chat.confirmation, event: chat.confirmationEvent, spoken, answer: typeof answer === "string" ? answer : null };
      this.setChat({ ...chat, questions: [...chat.questions, question], confirmation: null, confirmationEvent: null, confirmationExpiresAt: null });
    }
    reply(answer, kept);
  }

  /** Ticks `answer` on the question the chat window keeps as `id`. */
  private settleQuestion(id: number | null, answer: QuestionAnswer): void {
    const chat = this.currentChat;
    if (id !== null && chat !== null) this.setChat(settleQuestion(chat, id, answer));
  }

  /** The call answered aloud is dropped, the model not acting on the answer: it is declined, nothing
   * it asked about done, and its question shows so (owner, 2026-10-20). */
  private dropAnsweredAloud(): void {
    const waiting = this.answeredAloud;
    this.answeredAloud = null;
    if (waiting !== null) this.settleQuestion(waiting.question, "declined");
  }

  /** The hotkey while the chat window asks a tool's question: the user answers it aloud. The
   * request that asks goes on under it (its generation, settings and signal are kept), the question
   * stays, and its clock stops while the answer is spoken and transcribed. A double tap answers
   * hands-free, as it dictates. */
  private startSpokenAnswer(handsFree: boolean): void {
    if (this.spokenAnswer !== null || this.currentPhase.kind !== "running") return;
    cancelTimer(this.confirmationTimer);
    this.confirmationTimer = null;
    this.updateChat({ confirmationExpiresAt: null });
    this.keepChatOpen();
    this.spokenAnswers += 1;
    const id = this.spokenAnswers;
    const recorder = new AudioRecorder(config.recordingSampleRate, config.maxUnchunkedDuration);
    const meter = new LevelSampler();
    this.spokenAnswer = { id, recorder, abort: new AbortController(), startedAt: performance.now(), handsFree, resume: this.currentPhase };
    this.currentLevel = 0;
    this.envelope = new LevelEnvelope(this.envelope.room);
    this.hearing = false;
    const isCurrent = () => this.spokenAnswer?.id === id;
    this.deps.capture.start(
      (samples) => {
        if (!isCurrent()) return;
        recorder.append(samples);
        meter.append(samples, (level, voiceLevel) => this.updateLevel(level, voiceLevel));
      },
      (error) => {
        if (error && isCurrent()) this.abandonSpokenAnswer("the microphone failed to start");
      },
      () => {
        // The microphone stopped by itself: what was said is sent, as for a dictation.
        if (isCurrent() && this.currentPhase.kind === "listening") this.finishSpokenAnswer();
      },
    );
    this.maxDurationTimer = after(config.maxUnchunkedDuration, () => {
      if (isCurrent()) this.finishSpokenAnswer();
    });
    this.setPhase({ kind: "listening" });
    log.debug(`DictationController: listening for an answer to the question${handsFree ? ", hands-free" : ""}`);
  }

  /** The answer's hold is released: a tap says nothing (its second press may start a hands-free
   * answer); otherwise what was said is transcribed and given to the tool that asked. An answer with
   * no words in it, or one that could not be transcribed, leaves the question asking. */
  private finishSpokenAnswer(): void {
    const spoken = this.spokenAnswer;
    if (spoken === null || this.currentPhase.kind !== "listening") return;
    if (!spoken.handsFree && performance.now() - spoken.startedAt < config.minimumHoldDuration) return this.abandonSpokenAnswer("a tap");
    cancelTimer(this.maxDurationTimer);
    this.maxDurationTimer = null;
    this.currentLevel = 0;
    this.setPhase({ kind: "transcribing" });
    const isCurrent = () => this.spokenAnswer?.id === spoken.id;
    const deadline = performance.now() + this.transcriptionDeadline;
    // The microphone stays open briefly, as after a dictation, so the last word isn't clipped.
    this.releaseTailTimer = after(config.releaseTailDuration, () => {
      if (isCurrent()) void this.transcribeSpokenAnswer(spoken.recorder, spoken.abort.signal, isCurrent, deadline);
    });
  }

  private async transcribeSpokenAnswer(recorder: AudioRecorder, answerSignal: AbortSignal, isCurrent: () => boolean, deadline: number): Promise<void> {
    this.deps.capture.stop();
    const recording = recorder.finish();
    if (recording.pcm.length === 0) return this.abandonSpokenAnswer("no audio");
    const account = this.deps.account;
    const userID = account.session?.userID ?? null;
    const settings = this.dictationSettings;
    // Ended with the request, or dropped on its own: nothing more is sent.
    const signal = AbortSignal.any([this.abort.signal, answerSignal]);
    try {
      const language = await this.languageRead;
      if (!isCurrent()) return;
      const client = this.deps.makeTranscriptionClient(settings.backendURL);
      // Past the deadline the answer is abandoned below, which calls off its request and waits.
      const transcription = await this.withinDeadline(deadline, () =>
        this.transcribeRetrying(() => withFreshToken(account, userID, (token) => client.transcribe(recording.flac, language, settings.dictionary, token, signal)), isCurrent, signal),
      );
      if (!isCurrent()) return;
      const transcript = trimWhitespace(transcription.text);
      log.content("Transcript (answer to the question)", transcript);
      if (transcript === "") return this.abandonSpokenAnswer("nothing heard");
      this.replyToConfirmation({ spoken: transcript });
    } catch (error) {
      if (!isCurrent()) return;
      log.error(`DictationController: the answer to the question was not transcribed: ${errorName(error)}`);
      this.abandonSpokenAnswer("not transcribed");
    }
  }

  /** The answer being spoken came to nothing: the question asks on, its time to answer whole again. */
  private abandonSpokenAnswer(why: string): void {
    if (this.spokenAnswer === null) return;
    log.debug(`DictationController: no answer to the question (${why})`);
    this.endSpokenAnswer();
    if (this.confirmationReply !== null) this.startConfirmationClock();
  }

  /** Stops recording an answer to the question, if one is being spoken: the pill shows the request
   * it interrupted again. */
  private endSpokenAnswer(): void {
    const spoken = this.spokenAnswer;
    if (spoken === null) return;
    this.spokenAnswer = null;
    spoken.abort.abort();
    this.deps.capture.stop();
    cancelTimer(this.maxDurationTimer);
    this.maxDurationTimer = null;
    cancelTimer(this.releaseTailTimer);
    this.releaseTailTimer = null;
    this.hearing = false;
    this.currentLevel = 0;
    this.setPhase(spoken.resume);
  }

  /** Pastes into the focused field, logging what it pastes (debug builds, ADR-DESK-015), and keeps
   * the text in the paste history, pasted or not. Only into `targetApp`, the app in front at
   * key-down: when the user has gone to another app (`focusChanged`), nothing is pasted and the
   * clipboard is left alone; the dictation ends with a note that copies the text when clicked
   * (`NotPastedError`, ADR-DESK-042). Dictation and agent writing pass their screen read at key-down, to be spaced from
   * a delimiter before the caret and from a word after it (`spacedFromCaret`); the history and the
   * note's copy get the text as it is. */
  private readonly paste = async (text: string, targetApp: Promise<number | null>, signal: AbortSignal, screenRead: ScreenContext | null = null): Promise<void> => {
    log.content("DictationController: pasting", text);
    const checking = performance.now();
    const target = await targetApp;
    log.debug(() => `DictationController: target window resolved in ${elapsed(checking)}`);
    if (signal.aborted) throw new CancellationError();
    this.deps.history.add(text);
    if (target === null || !Number.isSafeInteger(target) || target <= 0) throw new NotPastedError(text);
    // A save asked once the text is on the clipboard would be of the paste's own text.
    this.stopSavingClipboard();
    const pasting = performance.now();
    try {
      await this.deps.paste(spacedFromCaret(screenRead?.textBeforeCaret ?? "", text, screenRead?.textAfterCaret ?? ""), signal, target);
    } catch (error) {
      if (signal.aborted) throw new CancellationError();
      if (error instanceof PasteTargetError) throw new NotPastedError(text);
      throw error;
    }
    log.debug(() => `DictationController: pasted in ${elapsed(pasting)}${this.sinceRelease()}`);
  };

  /** ", N ms after the release" once the key is released, for the debug log's step timings. */
  private sinceRelease(): string {
    return this.releasedAt === null ? "" : `, ${elapsed(this.releasedAt)} after the release`;
  }

  /** A triple tap: the paste history shows, by the pill (ADR-DESK-043), which is placed while the
   * hold still shows; then the second tap's hands-free dictation, which has heard nothing yet, goes
   * unseen. */
  private showHistory(): void {
    log.debug("DictationController: triple tap; showing the paste history");
    this.deps.tips.markLearned("agentAndHistory");
    this.onShowHistory?.();
    if (this.spokenAnswer !== null) this.abandonSpokenAnswer("left for the paste history");
    else if (this.currentPhase.kind === "listening" || this.currentPhase.kind === "arming") this.discard();
  }

  /** The email app of the settings this dictation started with, asked once per dictation. */
  private lookUpEmailApp(): Promise<EmailApp> {
    if (this.emailAppRead) return this.emailAppRead;
    const current = this.generation;
    const settings = this.dictationSettings;
    const read = (async (): Promise<EmailApp> => {
      const systemDefault = settings.hasTabMail && settings.emailClient === null ? await this.deps.systemEmailApp() : null;
      const app = EmailClient.resolve(settings.emailClient, systemDefault, settings.hasTabMail);
      return { app, path: await this.deps.thunderbird.applicationPath(app) };
    })().catch((error: unknown): EmailApp => {
      log.error(`DictationController: email app lookup failed: ${errorName(error)}`);
      return { app: null, path: null };
    });
    this.emailAppRead = read;
    void read.then((email) => {
      if (this.generation !== current) return;
      this.emailApp = email;
      this.updateTools();
    });
    return read;
  }

  private updateTools(): void {
    this.currentTools = this.currentMode === "agent" && this.isScreenReadDone && this.emailApp !== null
      ? DesktopAgent.tools(this.screenRead, this.dictationSettings.enabledTools)
      : [];
    this.currentReadsWindow = this.currentTools.length > 0 && this.windowRead !== null && this.screenRead !== null;
    this.changed();
  }

  private microphoneFailed(error: Error, current: number): void {
    if (this.generation !== current) return;
    log.error(`DictationController: microphone start failed: ${errorName(error)}`);
    this.endForMicrophone("Couldn't start the microphone.");
  }

  /** The microphone gave nothing but digital silence for `silentMicrophoneDuration`: it is muted or
   * its volume is at zero (owner, 2026-10-04: "if the volume is 0, we should just tell it"). Once the
   * key is released, what was recorded goes on as any recording does. */
  private microphoneSilent(current: number): void {
    this.silenceTimer = null;
    const kind = this.currentPhase.kind;
    if (this.generation !== current || this.hearing || (kind !== "arming" && kind !== "listening")) return;
    log.debug("DictationController: the microphone gives only digital silence");
    this.endForMicrophone(silentMicrophoneMessage);
  }

  private endForMicrophone(message: string): void {
    // A tap waiting for its second press was never shown: it goes unseen, failure or not.
    if (this.secondTapTimer !== null) return this.discard();
    this.generation += 1;
    this.abort.abort();
    this.teardown();
    this.fail(message);
  }

  /** The microphone stopped by itself mid-recording (its helper exited): as at the length cap, what
   * was said is sent (owner, 2026-09-27: "send what was said"); before the hold was deliberate there
   * is nothing to send, so it fails as the microphone does. */
  private microphoneLost(current: number): void {
    if (this.generation !== current) return;
    log.error("DictationController: microphone lost mid-recording");
    if (this.currentPhase.kind === "listening") return this.finish();
    // Already released (the release tail): its end transcribes what was heard.
    if (this.currentPhase.kind !== "arming") return;
    this.microphoneFailed(new Error("microphone lost"), current);
  }

  private async completeRecording(current: number, releasedAt: number): Promise<void> {
    this.deps.capture.stop();
    const recorder = this.recorder;
    if (!recorder) return;
    const encoding = performance.now();
    const recording = recorder.finish();
    log.debug(() => `DictationController: recording encoded in ${elapsed(encoding)}${this.sinceRelease()}`);
    const startedAt = this.startedAt ?? 0;
    const micDelay = recording.firstChunkAt === null ? "no audio" : `${Math.round(recording.firstChunkAt - startedAt)}ms`;
    log.debug(() => `DictationController: recorded ${recordingDuration(recording).toFixed(2)}s, peak ${recording.peakLevel.toFixed(3)}, gain ${(20 * Math.log10(recording.gain)).toFixed(1)} dB, waveform peak ${this.peakMeterLevel.toFixed(3)}, first audio after ${micDelay}`);

    if (this.dictationSettings.keepsRecording) this.deps.keepRecording?.(encodeWAV(recording.pcm, recording.sampleRate));

    // No loudness gate: on quiet built-in microphones speech sits only a few dB above the room
    // noise, so any level threshold rejects real speech. The model decides; an empty transcript is
    // reported by `transcribe`.
    if (recording.pcm.length === 0) {
      log.debug("DictationController: no audio captured; not uploading");
      this.teardown();
      this.fail(nothingHeardMessage);
      return;
    }
    if (recording.lastChunk !== null) return this.transcribeChunks(recording.lastChunk, current, releasedAt);
    await this.transcribe(recording.flac, current, releasedAt);
  }

  private updateLevel(level: number, voiceLevel: number): void {
    const kind = this.currentPhase.kind;
    if (kind !== "arming" && kind !== "listening") return;
    // The device delivers digital silence while it starts; the waveform appears with the first
    // real signal.
    if (!this.hearing && level > config.silenceDecibels) {
      this.hearing = true;
      this.showDueTip();
    }
    if (!this.hearing) return;
    // The overlay eases the bars toward each level, every frame.
    this.currentLevel = this.envelope.level(voiceLevel);
    this.peakMeterLevel = Math.max(this.peakMeterLevel, this.currentLevel);
    this.changed();
  }

  /** The second press of a double tap, while the first tap's recording waits for it: that
   * recording goes on, hands-free, and shows at once. */
  private latchHandsFree(): void {
    cancelTimer(this.secondTapTimer);
    this.secondTapTimer = null;
    this.deps.tips.markLearned("doubleTap");
    this.setPhase({ kind: "listening" });
    this.awaitSecondRelease();
    log.debug(`DictationController: listening hands-free (generation ${this.generation})`);
  }

  /** While a double tap's second press is down, no tip yet: released as a tap, the dictation shows
   * the hands-free tip (`listenHandsFree()`); still held once a tap is over, it is a hold, and gets
   * a hold's tips. */
  private awaitSecondRelease(): void {
    this.dueTips = [];
    const current = this.generation;
    this.secondPressTimer = after(config.minimumHoldDuration, () => {
      if (this.generation !== current) return;
      this.secondPressTimer = null;
      this.dueTips = ["agentKnowledgeBase", "agentAndHistory"];
      this.showDueTip();
    });
  }

  /** The second press of a double tap was a tap: the dictation listens on without the key, and
   * shows the hands-free tip in place of any hold tip shown as the tap ended. */
  private listenHandsFree(): void {
    cancelTimer(this.secondPressTimer);
    this.secondPressTimer = null;
    if (this.currentPhase.kind !== "listening") {
      log.debug(`DictationController: second press was a tap, but nothing listens hands-free (phase ${this.currentPhase.kind})`);
      this.onNothingListening?.();
      return;
    }
    this.dueTips = ["agentKnowledgeBase", "handsFree"];
    // What's new shows only once: up as the tap ended, it stays its time.
    if (this.currentTip !== "agentKnowledgeBase") this.hideTip();
    log.debug("DictationController: second press was a tap; listening without the key");
  }

  /** In agent mode with no name set, the tip inviting one is next; out of it, it goes. A tip with
   * no display duration (hands-free) would never give way, so it steps aside and returns after. */
  private updateNameTip(): void {
    this.dueTips = this.dueTips.filter((tip) => tip !== "setName");
    if (this.currentMode === "agent" && this.dictationSettings.userName === "") {
      this.dueTips.unshift("setName");
      const shown = this.currentTip;
      if (shown !== null && this.tipDisplayDuration(shown) === null) {
        this.dueTips.splice(1, 0, shown);
        this.hideTip();
      } else {
        this.showDueTip();
      }
    } else if (this.currentTip === "setName") {
      this.hideTip();
    }
  }

  /** Shows the next due tip the user may still see, while the pill listens and hears (the overlay
   * shows no tip over the warm-up swirl), for its display duration, or with none (the hands-free
   * tip) until the dictation stops listening. */
  private showDueTip(): void {
    // A follow-up's pill is in the chat window, which shows no tips.
    if (this.currentPhase.kind !== "listening" || !this.hearing || this.currentTip !== null || this.currentChat !== null) return;
    while (this.dueTips.length > 0) {
      const next = this.dueTips.shift();
      if (next === undefined || !this.deps.tips.isEligible(next)) continue;
      this.currentTip = next;
      this.deps.tips.recordDisplay(next);
      this.changed();
      const duration = this.tipDisplayDuration(next);
      if (duration === null) return;
      const current = this.generation;
      this.tipTimer = after(duration, () => {
        if (this.generation !== current || this.currentTip !== next) return;
        this.hideTip();
      });
      return;
    }
  }

  private hideTip(): void {
    cancelTimer(this.tipTimer);
    this.tipTimer = null;
    this.currentTip = null;
    this.changed();
    this.showDueTip();
  }

  private endTips(): void {
    this.dueTips = [];
    cancelTimer(this.secondPressTimer);
    this.secondPressTimer = null;
    cancelTimer(this.longHoldTimer);
    this.longHoldTimer = null;
    cancelTimer(this.tipTimer);
    this.tipTimer = null;
    this.currentTip = null;
  }

  /** Adds a turn to the chat window, opening it if it is closed: then, unless the user has touched
   * it, it closes after `chatTimeout` (`keepChatOpen()`). */
  private showInChat(request: string, tool: AgentToolID, reply: string): void {
    const chat = appendTurn(this.currentChat ?? this.newChat(), request, tool, reply);
    // Only the first answer finds it untouched: a follow-up touches it.
    if (chat.touched) return this.setChat(chat);
    this.chatCloseTimer = after(this.chatTimeout, () => {
      this.chatCloseTimer = null;
      log.debug("DictationController: chat window timed out");
      this.closeChat();
    });
    this.setChat({ ...chat, closesAt: Date.now() + this.chatTimeout });
  }

  /** The chat window as it opens, empty and untouched: for an agent request, as soon as it is heard. */
  private newChat(): AgentChat {
    log.debug("DictationController: chat window opened");
    return emptyChat;
  }

  /** The user touched the chat window (a hover, click or scroll) or followed up: it no longer times
   * out, and stays open until closed. */
  keepChatOpen(): void {
    const chat = this.currentChat;
    if (chat === null || chat.touched) return;
    cancelTimer(this.chatCloseTimer);
    this.chatCloseTimer = null;
    this.setChat({ ...chat, closesAt: null, touched: true });
    log.debug("DictationController: chat window kept open");
  }

  /** Escape or the window's close button: the conversation is gone, and a follow-up under way is
   * canceled. */
  closeChat(): void {
    if (this.currentChat === null) return;
    this.endConversation();
    log.debug("DictationController: chat window closed");
  }

  /** A click elsewhere, or another app in front (ADR-DESK-022): the chat window closes as Escape
   * closes it, but only while it is idle (owner, 2026-10-25): not while a follow-up listens, or the
   * request thinks or runs, a question it asks waiting for its answer among them. */
  dismissChat(): void {
    if (!isResting(this.currentPhase)) return;
    this.closeChat();
  }

  /** The conversation and any request under way end: the chat window closes, and what it taught is
   * learned into the knowledge base unless it is the account's end (`refines`). */
  private endConversation(refines = true): void {
    // A failure still showing goes too: the pill it shows is where the conversation started.
    if (this.currentPhase.kind !== "idle") this.discard();
    this.dropChat(refines);
  }

  /** The chat window closes; its conversation, unless `refines` is false, goes to the knowledge
   * base's refine (`KBRefiner`, which passes over a short one). */
  private dropChat(refines = true): void {
    cancelTimer(this.chatCloseTimer);
    this.chatCloseTimer = null;
    const turns = this.currentChat?.turns ?? [];
    this.setChat(null);
    if (refines && turns.length > 0) this.refine(turns);
  }

  /** Refines the knowledge base with a closed chat's `turns`, under the account signed in now and the
   * settings read now, its first step: nothing is sent once consent is withdrawn, and nothing waits
   * for it (ADR-DESK-063). */
  private refine(turns: readonly ChatTurn[]): void {
    const settings = this.deps.settings();
    if (!settings.hasConsented) {
      log.debug("DictationController: consent withdrawn; chat not refined");
      return;
    }
    const account = this.deps.account;
    const client = this.deps.makeCompletionsClient(settings.backendURL);
    void this.refiner.refine(turns, client, account, account.session?.userID ?? null);
  }

  /** Signing out, or into another account, ends the conversation and any agent request under way,
   * so neither reaches the next account; a refreshed token for the same account changes nothing. */
  private accountChanged(): void {
    // A dictation never reaches the chat (one is open only after an agent request, and every request
    // while it is open is one): it goes on, its transcription and cleanup both from the account signed
    // in at the upload.
    if (this.currentMode !== "agent") return;
    log.debug("DictationController: account changed; conversation ended");
    // The conversation was the last account's: it teaches the knowledge base nothing.
    this.endConversation(false);
  }

  /** Changes the open chat window's `change` fields; nothing while it is closed. */
  private updateChat(change: Partial<AgentChat>): void {
    if (this.currentChat !== null) this.setChat({ ...this.currentChat, ...change });
  }

  private setChat(chat: AgentChat | null): void {
    const wasOpen = this.currentChat !== null;
    this.currentChat = chat;
    if (wasOpen !== (chat !== null)) this.onChatChange?.(chat !== null);
    this.changed();
  }

  private discard(): void {
    this.generation += 1;
    this.abort.abort();
    cancelTimer(this.releaseTailTimer);
    this.teardown();
    this.setPhase({ kind: "idle" });
  }

  private teardown(): void {
    this.deps.capture.stop();
    this.stopSavingClipboard();
    this.recorder = null;
    this.contextRead = null;
    this.windowRead = null;
    cancelTimer(this.revealTimer);
    this.revealTimer = null;
    this.hearing = false;
    cancelTimer(this.maxDurationTimer);
    this.maxDurationTimer = null;
    cancelTimer(this.silenceTimer);
    this.silenceTimer = null;
    cancelTimer(this.secondTapTimer);
    this.secondTapTimer = null;
    this.endTips();
    this.releaseTailTimer = null;
    this.startedAt = null;
    this.currentLevel = 0;
    this.runningApps.clear();
    this.replyToConfirmation("declined");
    this.dropAnsweredAloud();
    // A tool runs only with its request pending; a request that ended without its turn takes the
    // questions it asked with it.
    const chat = this.currentChat;
    if (chat !== null && (chat.pendingRequest !== null || chat.questions.length > 0)) this.setChat({ ...chat, pendingRequest: null, questions: [], activity: null });
    // A chat window a tool opened with nothing in it yet goes, whether the request failed, was
    // canceled or ended with the account: the pill says what failed, and the next hold dictates.
    if (this.currentChat?.turns.length === 0) this.dropChat();
  }

  private fail(message: string): void {
    this.showMessage({ kind: "failed", message });
  }

  /** Saves the clipboard now and every `clipboardSaveInterval` until the paste writes or the
   * dictation ends (ADR-DESK-002, amended 2026-10-09): what goes back after the paste is the newest
   * copy, one made while the words are transcribed too. An unchanged clipboard is not read again. */
  private saveClipboardUntilThePaste(): void {
    this.stopSavingClipboard();
    const save = (): void => {
      this.deps.saveClipboard();
      this.clipboardSaveTimer = after(config.clipboardSaveInterval, save);
    };
    save();
  }

  private stopSavingClipboard(): void {
    cancelTimer(this.clipboardSaveTimer);
    this.clipboardSaveTimer = null;
  }

  /** Shows a failure or a text not pasted, for `duration`. */
  private showMessage(phase: Extract<Phase, { kind: "failed" | "notPasted" }>, duration = config.overlayErrorDisplayDuration): void {
    this.setPhase(phase);
    cancelTimer(this.failureResetTimer);
    this.failureResetTimer = after(duration, () => {
      if (this.currentPhase === phase) this.setPhase({ kind: "idle" });
    });
  }

  /** The not-pasted note was clicked: its text goes on the clipboard, and the note goes once it is
   * there, or says it isn't. A newer hold, or the note's end, while the clipboard is written wins. */
  async copyNotPasted(): Promise<void> {
    const note = this.currentPhase;
    if (note.kind !== "notPasted") return;
    const written = await this.deps.copy(note.text);
    if (this.currentPhase !== note) return;
    log.debug(`DictationController: not-pasted note clicked; ${written ? "copied" : "not copied"}`);
    if (written) this.setPhase({ kind: "idle" });
    else this.fail(notCopiedMessage);
  }

  /** The not-pasted note's x: it goes, copying nothing; the text stays in the paste history. */
  dismissNotPasted(): void {
    if (this.currentPhase.kind !== "notPasted") return;
    log.debug("DictationController: not-pasted note dismissed");
    this.setPhase({ kind: "idle" });
  }

  private setPhase(phase: Phase): void {
    this.currentPhase = phase;
    this.onPhaseChange?.(phase);
    this.changed();
  }
}

/** Nothing under way: idle, or a message showing, which the next hold replaces. */
export function isResting(phase: Phase): boolean {
  return phase.kind === "idle" || phase.kind === "failed" || phase.kind === "notPasted";
}

type Timer = ReturnType<typeof setTimeout>;

/** How the chat window's question ended: the user confirmed or declined it (a question left
 * unanswered for `confirmationTimeout` is declined), or answered it aloud (`spoken`, the words). */
type ConfirmationAnswer = "confirmed" | "declined" | { spoken: string };

/** Sends a recording, or a chunk of one, with what every upload of the dictation sends (`prepareUpload`). */
interface Upload {
  send: (flac: Uint8Array, signal: AbortSignal) => Promise<Transcription>;
  /** A long dictation's polish (`polished`), under the same account and with the same cleanup
   * variables as its chunks; null when the upload takes no cleanup. */
  polish: Polish | null;
}

/** Runs the cleanup prompt over `text`, and returns its reply. */
type Polish = (text: string, signal: AbortSignal) => Promise<string>;

/** A transcribed recording, or chunk of one, and whether it starts inside the one before it. */
interface TranscribedPart {
  transcription: Transcription;
  overlapped: boolean;
}

/** A chunk of a long dictation, sent as it was cut, and how its transcription ended. */
interface ChunkJob {
  index: number;
  overlapped: boolean;
  outcome: Promise<ChunkOutcome>;
}

type ChunkOutcome = { transcription: Transcription } | { error: unknown };

/** See `retryNotice`. */
interface RetryNotice {
  failed: () => void;
  answered: () => void;
  end: () => void;
}

/** A dictation's release, which its chunks still failing wait on: from then on they get their last
 * tries, under `notice`. */
interface Release {
  done: boolean;
  released: Promise<void>;
  markReleased: () => void;
  notice: RetryNotice | null;
}

function newRelease(): Release {
  let markReleased!: () => void;
  const released = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  return { done: false, released, markReleased, notice: null };
}

/** The backend gave up waiting for the speech model (504 `transcription_timeout`). One recording is
 * not tried again (it already waited, ADR-DESK-039); a long dictation's chunk is (ADR-DESK-049). */
function backendTimedOut(error: unknown): boolean {
  return error instanceof BackendError && error.kind === "failed" && error.status === gatewayTimeout;
}

/** A failure on the server's side, worth trying again: a 5xx, the speech model's rate limit (which
 * the backend answered as a 502 before it began retrying it itself, and which one recording was
 * always tried again on), or a connection that dropped. Not a 504: the backend gave up waiting for
 * the speech model, and like a request that timed out here, it already waited (ADR-DESK-039). */
function isServerError(error: unknown): boolean {
  if (error instanceof BackendError) return error.kind === "failed" && error.status !== undefined && ((error.status >= 500 && error.status !== gatewayTimeout) || error.status === speechModelRateLimited);
  return error instanceof TransportError && error.reason === "network";
}

function after(ms: number, action: () => void): Timer {
  return setTimeout(action, ms);
}

function cancelTimer(timer: Timer | null): void {
  if (timer !== null) clearTimeout(timer);
}
