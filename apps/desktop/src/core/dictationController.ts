// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AccountModel, withFreshToken } from "./account.js";
import { type AgentChat, appendTurn, chatTranscript, emptyChat } from "./agent/agentChat.js";
import { type BubbleKey, ranNow, serverToolConnector } from "./agent/bubbleOrder.js";
import { type Connector, connectors } from "./agent/connectors.js";
import { DesktopAgent } from "./agent/desktopAgent.js";
import { EmailClient } from "./agent/emailClient.js";
import { isJSONObject, type LoopTool } from "./agent/loopTool.js";
import type { ThunderbirdRelay } from "./agent/thunderbirdRelay.js";
import { type AgentTool, toolImplementations } from "./agent/tools.js";
import { type AudioCapture, AudioRecorder, decibels, recordingDuration } from "./audio.js";
import { BackendError, type CompletionsClient, type ServerToolEvent, type ToolCall, type Transcription, type TranscriptionClient } from "./backend.js";
import { DictationCleanup } from "./cleanup.js";
import * as config from "./config.js";
import { contextTerms } from "./contextTerms.js";
import { type DictationMode, type HotkeyAction, toggled } from "./hotkey.js";
import { TransportError } from "./http.js";
import { LevelEnvelope } from "./levelEnvelope.js";
import { elapsed, errorName, log } from "./log.js";
import { Observable } from "./observable.js";
import type { PasteHistory } from "./pasteHistory.js";
import type { MicrophoneStatus } from "./permissions.js";
import type { ScreenContext } from "./screenContext.js";
import type { DictationSettings } from "./settings.js";
import { charCount, trimWhitespace } from "./text.js";
import { type DictationTip, type TipBook, tipDetails } from "./tips.js";
import { sleep, withTimeout } from "./timeout.js";
import { encodeWAV } from "./wav.js";

export type Phase =
  | { kind: "idle" }
  /** Key is down and the microphone is booting, but the hold isn't yet long enough to be
   * deliberate: nothing is shown, so an accidental tap stays invisible and the microphone's start-up
   * time is hidden behind the hold. */
  | { kind: "arming" }
  | { kind: "listening" }
  | { kind: "transcribing" }
  /** The transcription failed on the server's side and is being tried again (`transcribeRetrying`). */
  | { kind: "retrying"; message: string }
  /** Agent mode: the agent chose this tool, which is writing its text. */
  | { kind: "running"; tool: AgentTool }
  | { kind: "failed"; message: string }
  /** The text could not be pasted where the user spoke (`PasteOutcome`): it is on the clipboard and in
   * the paste history instead, and the message says so, at the mouse pointer (ADR-DESK-042). */
  | { kind: "copied"; message: string };

/** What a paste found (ADR-DESK-042): it pasted where the user spoke, with the caret put back if it
 * had moved; or it pasted nothing, the user being in another app (`appChanged`) or the field or caret
 * not going back (`caretMoved`). */
export type PasteOutcome = "pasted" | "appChanged" | "caretMoved";

/** What the pointer's message says when the text was copied instead of pasted. */
export const notPastedMessages: Record<Exclude<PasteOutcome, "pasted">, string> = {
  appChanged: "Switched apps: copied to clipboard and history",
  caretMoved: "Cursor moved: copied to clipboard and history",
};

/** A text copied instead of pasted: the dictation ends with its message (`copied`). */
class NotPasted extends Error {
  constructor(readonly outcome: Exclude<PasteOutcome, "pasted">) {
    super(notPastedMessages[outcome]);
    this.name = "NotPasted";
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
  /** Keeps the field and caret of the app in front, now (key-down), for the dictation `session`
   * (ADR-DESK-042); true when a field was found. */
  captureTarget: (session: number) => Promise<boolean>;
  /** Pastes into the field and caret kept for `session`, put back if they moved, or pastes nothing
   * and says why; for the dictation whose `signal` it is: one cancelled before the paste reaches the
   * system pastes nothing. */
  paste: (text: string, session: number, signal: AbortSignal) => Promise<PasteOutcome>;
  /** Puts `text` on the clipboard, when it could not be pasted. */
  copy: (text: string) => void;
  /** Every text pasted, or copied instead, for the triple tap's list (ADR-DESK-043). */
  history: PasteHistory;
  thunderbird: ThunderbirdRelay;
  capture: AudioCapture;
  /** The process of the app in front, null without one. */
  frontmostApp: () => Promise<number | null>;
  /** The active keyboard input source's language. */
  keyboardLanguage: () => Promise<string | null>;
  /** The bundle identifier of the system's default email app. */
  systemEmailApp: () => Promise<string | null>;
  makeTranscriptionClient: (baseURL: string) => TranscriptionClient;
  /** Warms the backend for the transcription to come (`TranscriptionClient.warmUp`). */
  warmUp: (baseURL: string, accessToken: string) => Promise<void>;
  makeCompletionsClient: (baseURL: string) => CompletionsClient;
  /** The tools the Answer prompt's model can call that run on this computer. */
  loopTools: readonly LoopTool[];
  /** Debug builds only: keeps the latest recording for "Play Last Recording". */
  keepRecording?: (wav: Uint8Array) => void;
  /** Learns the user's corrections of a pasted dictation (`CorrectionWatch`); none where the field
   * can't be read (no helper on Windows and Linux yet). */
  corrections?: { watch(pid: number, pasted: string): void; stop(): void };
}

/** Shown when the recording had no words in it. Kept to one line of the pill. */
export const nothingHeardMessage = "Didn't catch that. Try again.";

/** Shown while a transcription that failed on the server's side is tried again. */
export const retryingMessage = "Server error, retrying…";

/** The status the backend answers when the speech model did not answer in time. */
const gatewayTimeout = 504;

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
  private currentTools: AgentTool[] = [];
  private currentLevel = 0;
  private hearing = false;
  private currentLanguage: string | null = null;
  private currentTip: DictationTip | null = null;
  private emailApp: EmailApp | null = null;
  private currentChat: AgentChat | null = null;
  /** The bubbles whose tools ran, the most recent first: for the app's life, never saved. */
  private recent: BubbleKey[] = [];
  /** The apps whose tools run now: one at a time, as the answer's tools run in turn. */
  private runningApps = new Set<Connector>();

  onPhaseChange: ((phase: Phase) => void) | undefined;
  /** The chat window opened (true) or closed. */
  onChatChange: ((isOpen: boolean) => void) | undefined;
  /** How long the chat window stays open untouched. Settable for tests. */
  chatTimeout = config.chatTimeout;
  /** How long the chat window's question shows before an answer to it counts. Settable for tests. */
  confirmationMinimumDisplay = config.chatConfirmationMinimumDisplay;
  /** How long the chat window's question waits for an answer. Settable for tests. */
  confirmationTimeout = config.chatConfirmationTimeout;
  /** The waits before each retry of a transcription that failed on the server's side. Settable for tests. */
  transcriptionRetryDelays = config.transcriptionRetryDelays;
  /** A double tap's second press was released as a tap, leaving the hotkey helper hands-free, but no
   * hands-free dictation listens: the press came while the last dictation was still busy, or failed
   * to start, or its dictation ended while the key was down. The helper must be told, or it keeps
   * Space and Escape from the app in front until the next hotkey press. */
  onNothingListening: (() => void) | undefined;
  /** A triple tap asks for the paste history (ADR-DESK-043). */
  onShowHistory: (() => void) | undefined;
  /** Starts reading the screen context when a dictation starts (key-down) with screen reading on,
   * with the target app still frontmost. Null: no context (the cleanup runs without it). */
  captureContext: (() => Promise<ScreenContext | null> | null) | undefined;
  /** How long a dictation's upload waits for that read, which its cleanup variables travel with
   * (agent mode waits for all of it, once its transcript is ready). Settable for tests. */
  contextWait = config.contextWait;
  /** How long a hold goes on before the double-tap tip is due, and how long a tip shows. Settable
   * for tests. */
  doubleTapTipHoldDuration = config.doubleTapTipHoldDuration;
  tipDisplayDuration: (tip: DictationTip) => number | null = (tip) => tipDetails[tip].displayDuration;

  // Per-dictation state. `generation` invalidates callbacks from a superseded dictation.
  private generation = 0;
  private startedAt: number | null = null;
  /** The settings this dictation started with; it reads no others. */
  private dictationSettings: DictationSettings;
  /** Cancels this dictation's requests when it is discarded. */
  private abort = new AbortController();
  /** The app in front at key-down, whose field the corrections are learned from. */
  private targetApp: Promise<number | null> = Promise.resolve(null);
  /** The field and caret kept at key-down (`captureTarget`), which the paste waits for. */
  private targetCapture: Promise<boolean> = Promise.resolve(false);
  /** The keyboard's language at key-down, which the badge shows and the transcription is asked in. */
  private languageRead: Promise<string | null> = Promise.resolve(null);
  private emailAppRead: Promise<EmailApp> | null = null;
  private recorder: AudioRecorder | null = null;
  private envelope = new LevelEnvelope();
  /** Debug tuning aid: the highest waveform level reached this dictation. */
  private peakMeterLevel = 0;
  private contextRead: Promise<ScreenContext | null> | null = null;
  /** That read's result, once done (null without a read); `tools` waits for it. */
  private screenRead: ScreenContext | null = null;
  private isScreenReadDone = false;
  private revealTimer: Timer | null = null;
  private maxDurationTimer: Timer | null = null;
  private releaseTailTimer: Timer | null = null;
  private failureResetTimer: Timer | null = null;
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
  /** Gives the user's answer to the question the chat window shows, awaited by the tool that asked. */
  private confirmationReply: ((answer: ConfirmationAnswer) => void) | null = null;
  /** Declines the question when it has gone unanswered for `confirmationTimeout`. */
  private confirmationTimer: Timer | null = null;
  /** When the question now showing appeared. */
  private confirmationShownAt = 0;

  constructor(private readonly deps: DictationDependencies) {
    super();
    this.dictationSettings = deps.settings();
    deps.account.onAccountChange = () => this.accountChanged();
  }

  get phase(): Phase {
    return this.currentPhase;
  }

  /** What the current (or last) recording is for. */
  get mode(): DictationMode {
    return this.currentMode;
  }

  /** The tools agent mode offers this time (`DesktopAgent.tools`). Empty in dictation mode, and
   * until the screen read at key-down and the email app are known: the selection decides between
   * Edit and Compose. */
  get tools(): AgentTool[] {
    return this.currentTools;
  }

  /** The apps agent mode shows a bubble for beside the tools': those switched on at key-down whose
   * tools this computer has, while Answer, whose loop runs their tools, is offered; none otherwise. */
  get connectors(): Connector[] {
    if (!this.currentTools.includes("answer")) return [];
    return connectors.filter((connector) => this.dictationSettings.enabledConnectors.includes(connector) && this.deps.loopTools.some((tool) => tool.connector === connector));
  }

  /** The bubbles whose tools have run since the app started, the most recent first, which the
   * bubbles under the pill are ordered by (`bubbleOrder`). */
  get recentBubbles(): BubbleKey[] {
    return this.recent;
  }

  /** The apps whose tools run now: one on this computer (`LoopTool`), or on the backend (the web's
   * search), each while it runs. */
  get runningConnectors(): Connector[] {
    return [...this.runningApps];
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
   * which keeps the window open, and shows no tips. */
  start(handsFree = false): void {
    if (this.secondTapTimer !== null) {
      if (handsFree) {
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
    const isFollowUp = this.currentChat !== null;
    if (isFollowUp) this.keepChatOpen();
    this.currentMode = isFollowUp ? "agent" : "dictation";
    this.emailApp = null;
    this.emailAppRead = null;
    this.screenRead = null;
    this.isScreenReadDone = false;
    this.currentTools = [];
    this.currentLevel = 0;
    this.peakMeterLevel = 0;
    this.envelope = new LevelEnvelope();
    this.hearing = false;
    this.startedAt = performance.now();
    this.targetApp = this.deps.frontmostApp().catch(() => null);
    this.targetCapture = this.deps.captureTarget(current).catch((error: unknown) => {
      log.error(`DictationController: couldn't keep the field: ${errorName(error)}`);
      return false;
    });
    this.currentLanguage = null;
    this.languageRead = this.deps.keyboardLanguage().catch(() => null);
    void this.languageRead.then((language) => {
      if (this.generation !== current) return;
      this.currentLanguage = language;
      this.changed();
    });
    this.dueTips = ["agentAndHistory"];
    if (isFollowUp) void this.lookUpEmailApp();
    this.setPhase({ kind: "arming" });
    void this.warmUp(settings.backendURL);
    this.contextRead = settings.readsScreen ? (this.captureContext?.() ?? null) : null;
    const read = this.contextRead;
    if (read) {
      void read.then((context) => {
        if (this.generation !== current) return;
        this.screenRead = context;
        this.isScreenReadDone = true;
        this.updateTools();
      });
    } else {
      this.isScreenReadDone = true;
    }

    // Boot the microphone now; the overlay appears only once the hold is long enough, by which
    // time most of the start-up is done.
    const recorder = new AudioRecorder();
    this.recorder = recorder;
    this.deps.capture.start(
      (samples) => {
        if (this.generation !== current) return;
        recorder.append(samples);
        this.updateLevel(decibels(samples));
      },
      (error) => {
        if (error) this.microphoneFailed(error, current);
      },
      () => this.microphoneLost(current),
    );
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

    // Past the length the backend transcribes, stop and send what was said rather than silently dropping audio.
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
    if (this.currentMode === "agent") void this.lookUpEmailApp();
    this.updateNameTip();
    this.updateTools();
    log.debug(`DictationController: switched to ${this.currentMode}`);
  }

  finish(): void {
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
    this.endTips();

    // Keep the microphone open briefly after release so the last word isn't clipped.
    const current = this.generation;
    this.currentLevel = 0;
    this.setPhase({ kind: "transcribing" });
    this.releaseTailTimer = after(config.releaseTailDuration, () => {
      if (this.generation !== current) return;
      void this.completeRecording(current);
    });
  }

  cancel(): void {
    if (isResting(this.currentPhase)) return;
    log.debug("DictationController: cancelled");
    this.discard();
  }

  /** The names and terms on the screen read at key-down (`contextTerms`), sent with the recording
   * beside the dictionary's words (ADR-DESK-038): only if the read is done by the upload (a dictation
   * waits `contextWait` for it, agent mode not at all); none when the screen is not read. */
  private screenTerms(dictionary: readonly string[]): string[] {
    const screen = this.screenRead;
    const terms = screen ? contextTerms(`${screen.windowTitle ?? ""}\n${screen.renderedText}`, dictionary, config.contextTermsMax) : [];
    log.debug(() => `DictationController: sending ${dictionary.length} dictionary word(s) and ${terms.length} screen term(s)`);
    return terms;
  }

  /** Transcribes one recording, cleaned up in the same request, and inserts it (dictation), or
   * transcribes it and carries it out (agent mode). Public for tests. */
  async transcribe(flac: Uint8Array, generation: number): Promise<void> {
    // Every request goes under the account signed in now, even if the user switches accounts while
    // they run.
    const account = this.deps.account;
    const userId = account.session?.userId ?? null;
    const settings = this.dictationSettings;
    const mode = this.currentMode;
    const signal = this.abort.signal;
    const isCurrent = () => this.generation === generation && !signal.aborted;
    try {
      const language = await this.languageRead;
      const read = this.contextRead;
      let context: ScreenContext | null = null;
      if (mode === "dictation") {
        // The screen context read at key-down, if it is done in time: best effort (ADR-DESK-008). It
        // goes with the recording, for the backend's cleanup.
        context = read ? await withTimeout(this.contextWait, () => read).catch(() => null) : null;
        if (read && context === null) log.debug("DictationController: screen read not done in time; continuing without it");
        if (!isCurrent()) return;
      }
      const cleanup = mode === "dictation" ? DictationCleanup.variables(context, settings.dictionary) : undefined;
      log.debug(`DictationController: uploading ${flac.length} bytes`);
      const client = this.deps.makeTranscriptionClient(settings.backendURL);
      const vocabulary = [...settings.dictionary, ...this.screenTerms(settings.dictionary)];
      const started = performance.now();
      const transcription = await this.transcribeRetrying(() => withFreshToken(account, userId, (token) => client.transcribe(flac, language, vocabulary, token, signal, cleanup)), isCurrent, signal);
      if (!isCurrent()) return;
      const transcript = trimWhitespace(transcription.text);
      log.debug(() => `DictationController: transcript ready in ${elapsed(started)} (${charCount(transcript)} chars)`);
      log.content(`Transcript (${mode})`, transcript);
      if (transcript === "") {
        this.teardown();
        this.fail(nothingHeardMessage);
        return;
      }
      if (mode === "dictation") {
        const text = DictationCleanup.pasted(transcript, transcription.cleanedText);
        await this.paste(text, generation, signal);
        const corrections = this.deps.corrections;
        if (settings.learnsWords && corrections) {
          const pid = await this.targetApp;
          if (pid !== null && isCurrent()) corrections.watch(pid, text);
        }
      } else {
        // All of it: its selection decides between Edit and Compose, as the bubbles showed.
        context = read ? await read : null;
        if (!isCurrent()) return;
        const email = await this.lookUpEmailApp();
        if (!isCurrent()) return;
        const client = this.deps.makeCompletionsClient(settings.backendURL);
        // The tools the bubbles show: the same read, settings and email app.
        const offered = DesktopAgent.tools(context, settings.enabledTools, email.path !== null);
        const chat = this.currentChat;
        const conversation = chat ? chatTranscript(chat) : "";
        if (chat) this.setChat({ ...chat, pendingRequest: transcript });
        const tool = await DesktopAgent.tool(transcript, offered, context, conversation, client, account, userId, signal);
        if (!isCurrent()) return;
        log.debug(`DictationController: agent chose ${tool}`);
        this.recent = ranNow(this.recent, tool);
        this.setPhase({ kind: "running", tool });
        // Only the tools of apps switched on at key-down are offered, and only those run.
        const loopTools = this.deps.loopTools.filter((loopTool) => settings.enabledConnectors.includes(loopTool.connector));
        const text =
          tool === "answer"
            ? await DesktopAgent.answer(
                transcript,
                context,
                conversation,
                settings.userName,
                DesktopAgent.answerTools(loopTools),
                client,
                account,
                userId,
                (call) => this.runLoopTool(call, loopTools, transcript, isCurrent, signal),
                (event) => this.serverToolRan(event, isCurrent),
                signal,
              )
            : await DesktopAgent.write(tool, transcript, context, conversation, settings.userName, client, account, userId, signal);
        if (!isCurrent()) return;
        await toolImplementations[tool].deliver(text, {
          emailApp: email.app,
          paste: (text) => this.paste(text, generation, signal),
          thunderbird: this.deps.thunderbird,
          // Closed, cancelled or superseded meanwhile: the answer goes nowhere.
          showAnswer: (answer) => {
            if (isCurrent()) this.showInChat(transcript, tool, answer);
          },
          signal,
        });
        // Closed, cancelled or superseded while it delivered: the chat now open may be a newer one.
        if (!isCurrent()) return;
        // A follow-up's other tools are listed in the chat too, so a later follow-up can refer to them.
        if (tool !== "answer" && this.currentChat !== null) this.showInChat(transcript, tool, text);
      }
      if (this.generation !== generation) return;
      this.teardown();
      this.setPhase({ kind: "idle" });
    } catch (error) {
      if (!isCurrent()) return;
      this.teardown();
      if (error instanceof NotPasted) {
        log.debug(`DictationController: not pasted (${error.outcome}); copied instead`);
        this.showMessage({ kind: "copied", message: error.message });
        return;
      }
      log.error(`DictationController: ${mode} failed: ${errorName(error)}`);
      this.fail(error instanceof Error && error.message !== "" ? error.message : "Dictation failed. Please try again.");
    }
  }

  /** Warms the backend at key-down (`warmUp`), under the account signed in now. Best effort: nothing
   * waits for it, and a failure is only logged. */
  private async warmUp(backendURL: string): Promise<void> {
    const account = this.deps.account;
    try {
      await withFreshToken(account, account.session?.userId ?? null, (token) => this.deps.warmUp(backendURL, token));
    } catch (error) {
      log.debug(`DictationController: warm-up failed: ${errorName(error)}`);
    }
  }

  /** Makes the transcription request, and makes it again after a server error (a 5xx other than the
   * backend's own timeout: the speech model behind it was rate limited or failed) or a dropped
   * connection, up to `transcriptionRetryDelays.length` more times, so the user need not say it again.
   * The pill says so while it waits and tries, and goes back to transcribing once a retry answers. Any
   * other failure (signed out, over quota, a refused request, a timeout) fails at once. */
  private async transcribeRetrying(request: () => Promise<Transcription>, isCurrent: () => boolean, signal: AbortSignal): Promise<Transcription> {
    for (let retry = 0; ; retry += 1) {
      try {
        const transcription = await request();
        if (retry > 0 && isCurrent()) this.setPhase({ kind: "transcribing" });
        return transcription;
      } catch (error) {
        const delay = this.transcriptionRetryDelays[retry];
        if (delay === undefined || !isServerError(error) || !isCurrent()) throw error;
        log.debug(`DictationController: transcription failed (${errorName(error)}); retrying in ${delay}ms`);
        this.setPhase({ kind: "retrying", message: retryingMessage });
        await sleep(delay, signal);
      }
    }
  }

  /** Runs a tool the Answer prompt's model called, and returns what the model reads next: the tool's
   * result, that the user declined, or why it could not run. The chat window opens (if the request
   * was not a follow-up) to show which tool runs and, for one that sends or creates, to ask first. */
  private async runLoopTool(call: ToolCall, loopTools: readonly LoopTool[], request: string, isCurrent: () => boolean, signal: AbortSignal): Promise<string> {
    const tool = loopTools.find((candidate) => candidate.name === call.function.name);
    if (tool === undefined) {
      log.error("DictationController: the agent called a tool this app doesn't have");
      return `Error: there is no tool named ${call.function.name}.`;
    }
    const args = parsedJSON(call.function.arguments);
    if (!isJSONObject(args)) {
      log.error(`DictationController: ${tool.name} called with arguments that aren't a JSON object`);
      return "Error: the arguments were not a JSON object.";
    }
    this.setChat({ ...(this.currentChat ?? this.newChat()), pendingRequest: request });
    const question = tool.confirmation(args);
    // Closing the window or ending the request declines the question (`teardown`).
    if (question !== null) {
      const answer = await this.confirm(question);
      if (answer !== "confirmed") {
        log.debug(`DictationController: ${tool.name} ${answer}`);
        return answer === "declined" ? config.loopToolDeclined : config.loopToolUnanswered;
      }
    }
    log.debug(`DictationController: running ${tool.name}`);
    this.updateChat({ activity: tool.progressLabel });
    this.appStarted(tool.connector);
    try {
      return await tool.run(args, signal);
    } catch (error) {
      log.error(`DictationController: ${tool.name} failed: ${errorName(error)}`);
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (isCurrent()) {
        this.appEnded(tool.connector);
        this.updateChat({ activity: null });
      }
    }
  }

  /** A backend tool started or ended within the answer's round: its app's bubble (the web's, for its
   * search) runs meanwhile, and the chat window says what it does, as for a tool here. The backend's
   * own tools (the date tools) belong to no app, and only show in the chat. */
  private serverToolRan(event: ServerToolEvent, isCurrent: () => boolean): void {
    if (!isCurrent()) return;
    log.debug(`DictationController: backend ${event.running ? "running" : "ran"} ${event.tool}`);
    const connector = serverToolConnector(event.tool);
    if (connector !== null) {
      if (event.running) this.appStarted(connector);
      else this.appEnded(connector);
    }
    if (event.label !== null) this.updateChat({ activity: event.running ? event.label : null });
  }

  /** One of `connector`'s tools starts: its bubble moves to the front of the history and runs. */
  private appStarted(connector: Connector): void {
    this.recent = ranNow(this.recent, connector);
    this.runningApps.add(connector);
    this.changed();
  }

  private appEnded(connector: Connector): void {
    this.runningApps.delete(connector);
    this.changed();
  }

  /** Shows `question` in the chat window, and waits for the user to confirm or decline it
   * (`answerConfirmation`); closing the window or cancelling the request declines it, and so does
   * leaving it unanswered for `confirmationTimeout`. */
  private confirm(question: string): Promise<ConfirmationAnswer> {
    this.confirmationShownAt = Date.now();
    this.updateChat({ confirmation: question, confirmationExpiresAt: this.confirmationShownAt + this.confirmationTimeout });
    return new Promise((resolve) => {
      this.confirmationReply = resolve;
      this.confirmationTimer = after(this.confirmationTimeout, () => {
        this.confirmationTimer = null;
        this.replyToConfirmation("unanswered");
      });
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
    this.updateChat({ confirmation: null, confirmationExpiresAt: null });
    reply(answer);
  }

  /** Pastes where the dictation `session` started, logging what it pastes (debug builds,
   * ADR-DESK-015), and keeps the text in the paste history, pasted or not. Where it can't paste, the
   * text goes on the clipboard instead, and the dictation ends saying so (`NotPasted`). */
  private readonly paste = async (text: string, session: number, signal: AbortSignal): Promise<void> => {
    log.content("DictationController: pasting", text);
    await this.targetCapture;
    const outcome = await this.deps.paste(text, session, signal);
    this.deps.history.add(text);
    if (outcome === "pasted") return;
    this.deps.copy(text);
    throw new NotPasted(outcome);
  };

  /** A triple tap: the second tap's hands-free dictation has heard nothing yet, and goes unseen; the
   * paste history shows. */
  private showHistory(): void {
    log.debug("DictationController: triple tap; showing the paste history");
    this.deps.tips.markLearned("agentAndHistory");
    if (this.currentPhase.kind === "listening" || this.currentPhase.kind === "arming") this.discard();
    this.onShowHistory?.();
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
      ? DesktopAgent.tools(this.screenRead, this.dictationSettings.enabledTools, this.emailApp.path !== null)
      : [];
    this.changed();
  }

  private microphoneFailed(error: Error, current: number): void {
    if (this.generation !== current) return;
    log.error(`DictationController: microphone start failed: ${errorName(error)}`);
    // A tap waiting for its second press was never shown: it goes unseen, failure or not.
    if (this.secondTapTimer !== null) return this.discard();
    this.generation += 1;
    this.abort.abort();
    this.teardown();
    this.fail("Couldn't start the microphone.");
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

  private async completeRecording(current: number): Promise<void> {
    this.deps.capture.stop();
    const recorder = this.recorder;
    if (!recorder) return;
    const recording = recorder.finish();
    const startedAt = this.startedAt ?? 0;
    const micDelay = recording.firstChunkAt === null ? "no audio" : `${Math.round(recording.firstChunkAt - startedAt)}ms`;
    log.debug(() => `DictationController: recorded ${recordingDuration(recording).toFixed(2)}s, peak ${recording.peakLevel.toFixed(3)}, gain ${(20 * Math.log10(recording.gain)).toFixed(1)} dB, waveform peak ${this.peakMeterLevel.toFixed(3)}, first audio after ${micDelay}`);

    this.deps.keepRecording?.(encodeWAV(recording.pcm, recording.sampleRate));

    // No loudness gate: on quiet built-in microphones speech sits only a few dB above the room
    // noise, so any level threshold rejects real speech. The model decides; an empty transcript is
    // reported by `transcribe`.
    if (recording.pcm.length === 0) {
      log.debug("DictationController: no audio captured; not uploading");
      this.teardown();
      this.fail(nothingHeardMessage);
      return;
    }
    await this.transcribe(recording.flac, current);
  }

  private updateLevel(level: number): void {
    const kind = this.currentPhase.kind;
    if (kind !== "arming" && kind !== "listening") return;
    // The device delivers digital silence while it starts; the waveform appears with the first
    // real signal.
    if (!this.hearing && level > config.silenceDecibels) {
      this.hearing = true;
      this.showDueTip();
    }
    if (!this.hearing) return;
    const next = this.envelope.level(level);
    const rate = next > this.currentLevel ? config.levelAttack : config.levelRelease;
    this.currentLevel += (next - this.currentLevel) * rate;
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
      this.dueTips = ["agentAndHistory"];
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
    this.dueTips = ["handsFree"];
    this.hideTip();
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
  private showInChat(request: string, tool: AgentTool, reply: string): void {
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

  /** The chat window as it opens, empty and untouched: for an answer, or a tool the answer's model
   * calls. */
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
   * cancelled. */
  closeChat(): void {
    if (this.currentChat === null) return;
    this.endConversation();
    log.debug("DictationController: chat window closed");
  }

  /** The conversation and any request under way end: the chat window closes. */
  private endConversation(): void {
    // A failure still showing goes too: the pill it shows is where the conversation started.
    if (this.currentPhase.kind !== "idle") this.discard();
    this.dropChat();
  }

  private dropChat(): void {
    cancelTimer(this.chatCloseTimer);
    this.chatCloseTimer = null;
    this.setChat(null);
  }

  /** Signing out, or into another account, ends the conversation and any agent request under way,
   * so neither reaches the next account; a refreshed token for the same account changes nothing. */
  private accountChanged(): void {
    // A dictation never reaches the chat (one is open only after an agent request, and every request
    // while it is open is one): it goes on, its transcription and cleanup both from the account signed
    // in at the upload.
    if (this.currentMode !== "agent") return;
    log.debug("DictationController: account changed; conversation ended");
    this.endConversation();
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
    this.recorder = null;
    this.contextRead = null;
    cancelTimer(this.revealTimer);
    this.revealTimer = null;
    this.hearing = false;
    cancelTimer(this.maxDurationTimer);
    this.maxDurationTimer = null;
    cancelTimer(this.secondTapTimer);
    this.secondTapTimer = null;
    this.endTips();
    this.releaseTailTimer = null;
    this.startedAt = null;
    this.currentLevel = 0;
    this.runningApps.clear();
    // A tool runs only with its request pending.
    const chat = this.currentChat;
    if (chat?.pendingRequest != null) this.setChat({ ...chat, pendingRequest: null, activity: null });
    this.replyToConfirmation("declined");
    // A chat window a tool opened with nothing in it yet goes, whether the request failed, was
    // cancelled or ended with the account: the pill says what failed, and the next hold dictates.
    if (this.currentChat?.turns.length === 0) this.dropChat();
  }

  private fail(message: string): void {
    this.showMessage({ kind: "failed", message });
  }

  /** Shows a failure, or the text copied instead of pasted, for `overlayErrorDisplayDuration`. */
  private showMessage(phase: Extract<Phase, { kind: "failed" | "copied" }>): void {
    this.setPhase(phase);
    cancelTimer(this.failureResetTimer);
    this.failureResetTimer = after(config.overlayErrorDisplayDuration, () => {
      if (this.currentPhase === phase) this.setPhase({ kind: "idle" });
    });
  }

  private setPhase(phase: Phase): void {
    this.currentPhase = phase;
    this.onPhaseChange?.(phase);
    this.changed();
  }
}

/** Nothing under way: idle, or a message showing, which the next hold replaces. */
function isResting(phase: Phase): boolean {
  return phase.kind === "idle" || phase.kind === "failed" || phase.kind === "copied";
}

/** `json` parsed; undefined when it isn't JSON. */
function parsedJSON(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

type Timer = ReturnType<typeof setTimeout>;

/** How the chat window's question ended: the user confirmed or declined it, or it went unanswered
 * for `confirmationTimeout`. */
type ConfirmationAnswer = "confirmed" | "declined" | "unanswered";

/** A failure on the server's side, worth trying again: a 5xx, or a connection that dropped. Not a 504:
 * the backend gave up waiting for the speech model, and like a request that timed out here, it
 * already waited (ADR-DESK-039). */
function isServerError(error: unknown): boolean {
  if (error instanceof BackendError) return error.kind === "failed" && error.status !== undefined && error.status >= 500 && error.status !== gatewayTimeout;
  return error instanceof TransportError && error.reason === "network";
}

function after(ms: number, action: () => void): Timer {
  return setTimeout(action, ms);
}

function cancelTimer(timer: Timer | null): void {
  if (timer !== null) clearTimeout(timer);
}
