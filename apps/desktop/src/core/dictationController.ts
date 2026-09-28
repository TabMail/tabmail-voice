// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AccountModel, withFreshToken } from "./account.js";
import { DesktopAgent } from "./agent/desktopAgent.js";
import { EmailClient } from "./agent/emailClient.js";
import type { ThunderbirdRelay } from "./agent/thunderbirdRelay.js";
import { type AgentTool, toolImplementations } from "./agent/tools.js";
import { type AudioCapture, AudioRecorder, decibels, recordingDuration } from "./audio.js";
import type { CompletionsClient, TranscriptionClient } from "./backend.js";
import { DictationCleanup } from "./cleanup.js";
import * as config from "./config.js";
import { type DictationMode, type HotkeyAction, toggled } from "./hotkey.js";
import { LevelEnvelope } from "./levelEnvelope.js";
import { errorName, log } from "./log.js";
import { Observable } from "./observable.js";
import type { MicrophoneStatus } from "./permissions.js";
import type { ScreenContext } from "./screenContext.js";
import type { DictationSettings } from "./settings.js";
import { charCount, trimWhitespace } from "./text.js";
import { type DictationTip, type TipBook, tipDetails } from "./tips.js";
import { withTimeout } from "./timeout.js";
import { encodeWAV } from "./wav.js";

export type Phase =
  | { kind: "idle" }
  /** Key is down and the microphone is booting, but the hold isn't yet long enough to be
   * deliberate: nothing is shown, so an accidental tap stays invisible and the microphone's start-up
   * time is hidden behind the hold. */
  | { kind: "arming" }
  | { kind: "listening" }
  | { kind: "transcribing" }
  /** Agent mode: the agent chose this tool, which is writing its text. */
  | { kind: "running"; tool: AgentTool }
  | { kind: "failed"; message: string };

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
  /** Pastes into the focused field, for the dictation whose `signal` it is: one cancelled before the
   * paste reaches the system pastes nothing. */
  paste: (text: string, signal: AbortSignal) => Promise<void>;
  thunderbird: ThunderbirdRelay;
  capture: AudioCapture;
  /** The process of the app in front, null without one. */
  frontmostApp: () => Promise<number | null>;
  /** The active keyboard input source's language. */
  keyboardLanguage: () => Promise<string | null>;
  /** The bundle identifier of the system's default email app. */
  systemEmailApp: () => Promise<string | null>;
  makeTranscriptionClient: (baseURL: string) => TranscriptionClient;
  makeCompletionsClient: (baseURL: string) => CompletionsClient;
  /** Debug builds only: keeps the latest recording for "Play Last Recording". */
  keepRecording?: (wav: Uint8Array) => void;
}

/** Shown when the recording had no words in it. Kept to one line of the pill. */
export const nothingHeardMessage = "Didn't catch that. Try again.";

/**
 * Drives one push-to-talk dictation at a time: record → transcribe on the backend → clean up the
 * transcript with the screen context → paste. In agent mode (Space pressed during the hold) the
 * transcript is a request instead: the selection picks Edit or Compose, the agent may send it to
 * TabMail's chat in Thunderbird instead, and the tool's text is pasted, or sent there. A double tap
 * of the hotkey starts a hands-free dictation instead of a hold. While the pill listens, a tip may
 * show under it (`DictationTip`).
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

  onPhaseChange: ((phase: Phase) => void) | undefined;
  /** Starts reading the screen context when a dictation starts (key-down) with screen reading on,
   * with the target app still frontmost. Null: no context (the cleanup runs without it). */
  captureContext: (() => Promise<ScreenContext | null> | null) | undefined;
  /** How long the cleanup waits for that read once the transcript is ready (agent mode waits for
   * all of it). Settable for tests. */
  contextWait = config.contextWait;
  /** How long a hold goes on before the double-tap tip is due, and how long a tip shows. Settable
   * for tests. */
  doubleTapTipHoldDuration = config.doubleTapTipHoldDuration;
  tipDisplayDuration: (tip: DictationTip) => number = (tip) => tipDetails[tip].displayDuration;

  // Per-dictation state. `generation` invalidates callbacks from a superseded dictation.
  private generation = 0;
  private startedAt: number | null = null;
  /** The settings this dictation started with; it reads no others. */
  private dictationSettings: DictationSettings;
  /** Cancels this dictation's requests when it is discarded. */
  private abort = new AbortController();
  /** The app in front at key-down, where agent mode's text belongs. */
  private targetApp: Promise<number | null> = Promise.resolve(null);
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

  constructor(private readonly deps: DictationDependencies) {
    super();
    this.dictationSettings = deps.settings();
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
      case "finish":
        return this.finish();
      case "cancel":
        return this.cancel();
      case "toggleMode":
        return this.toggleMode();
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

  /** Starts a dictation; `toggleMode()` makes it an agent request. A hands-free one (a double tap)
   * shows at once, and goes on until `finish()` or `cancel()`: it carries on the first tap's
   * recording, whose microphone is already running, if that tap is still waiting for it. */
  start(handsFree = false): void {
    if (this.secondTapTimer !== null) {
      if (handsFree) {
        this.latchHandsFree();
        return;
      }
      // A new hold: the tap before it was only a tap.
      this.discard();
    }
    if (this.currentPhase.kind !== "idle" && this.currentPhase.kind !== "failed") return;
    // First, before anything else: the settings this dictation uses, whatever changes meanwhile.
    const settings = this.deps.settings();
    this.dictationSettings = settings;
    if (!settings.hasConsented) return this.fail("Finish setting up TabMail Voice from its menu to dictate.");
    if (!this.deps.account.isSignedIn) return this.fail("Sign in to TabMail in Settings to dictate.");
    if (this.deps.permissions.microphone !== "granted") return this.fail("Allow microphone access in TabMail Voice's menu to dictate.");
    if (!this.deps.permissions.accessibilityTrusted) {
      return this.fail("Allow Accessibility access in TabMail Voice's menu so dictation can type for you.");
    }

    cancelTimer(this.failureResetTimer);
    this.failureResetTimer = null;
    this.generation += 1;
    const current = this.generation;
    this.abort = new AbortController();
    this.currentMode = "dictation";
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
    this.currentLanguage = null;
    this.languageRead = this.deps.keyboardLanguage().catch(() => null);
    void this.languageRead.then((language) => {
      if (this.generation !== current) return;
      this.currentLanguage = language;
      this.changed();
    });
    this.dueTips = ["switchMode"];
    this.setPhase({ kind: "arming" });
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
      this.showDueTip();
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

  /** Space during the hold: switches between dictation and agent mode. */
  toggleMode(): void {
    const kind = this.currentPhase.kind;
    if (kind !== "arming" && kind !== "listening") return;
    this.currentMode = toggled(this.currentMode);
    this.deps.tips.markLearned("switchMode");
    if (this.currentTip === "switchMode") this.hideTip();
    if (this.currentMode === "agent") void this.lookUpEmailApp();
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
    const kind = this.currentPhase.kind;
    if (kind === "idle" || kind === "failed") return;
    log.debug("DictationController: cancelled");
    this.discard();
  }

  /** Transcribes one recording, then cleans it up and inserts it (dictation) or carries it out
   * (agent mode). Public for tests. */
  async transcribe(wav: Uint8Array, generation: number): Promise<void> {
    log.debug(`DictationController: uploading ${wav.length} bytes`);
    // Both requests go under the account signed in now, even if the user switches accounts while
    // they run.
    const account = this.deps.account;
    const userId = account.session?.userId ?? null;
    const settings = this.dictationSettings;
    const mode = this.currentMode;
    const signal = this.abort.signal;
    const isCurrent = () => this.generation === generation && !signal.aborted;
    try {
      const language = await this.languageRead;
      const client = this.deps.makeTranscriptionClient(settings.backendURL);
      const transcript = trimWhitespace(await withFreshToken(account, userId, (token) => client.transcribe(wav, language, token, signal)));
      if (!isCurrent()) return;
      log.debug(() => `DictationController: transcript ready (${charCount(transcript)} chars)`);
      log.content(`Transcript (${mode})`, transcript);
      if (transcript === "") {
        this.teardown();
        this.fail(nothingHeardMessage);
        return;
      }
      const read = this.contextRead;
      let context: ScreenContext | null;
      if (mode === "dictation") {
        // The screen context read at key-down, if it is done in time: best effort (ADR-DESK-008).
        context = read ? await withTimeout(this.contextWait, () => read).catch(() => null) : null;
        if (read && context === null) log.debug("DictationController: screen read not done in time; continuing without it");
      } else {
        // All of it: its selection decides between Edit and Compose, as the bubbles showed.
        context = read ? await read : null;
      }
      if (!isCurrent()) return;
      if (mode === "dictation") {
        const client = this.deps.makeCompletionsClient(settings.backendURL);
        const text = await DictationCleanup.cleanUp(transcript, context, client, account, userId, config.cleanupTimeout, signal);
        if (!isCurrent()) return;
        await this.paste(text, signal);
      } else {
        const email = await this.lookUpEmailApp();
        if (!isCurrent()) return;
        const client = this.deps.makeCompletionsClient(settings.backendURL);
        const tool = await DesktopAgent.tool(transcript, context, email.path !== null, client, account, userId, signal);
        if (!isCurrent()) return;
        log.debug(`DictationController: agent chose ${tool}`);
        this.setPhase({ kind: "running", tool });
        const text = await DesktopAgent.write(tool, transcript, context, client, account, userId, signal);
        if (!isCurrent()) return;
        const targetApp = await this.targetApp;
        await toolImplementations[tool].deliver(text, {
          emailApp: email.app,
          paste: (text) => this.paste(text, signal),
          isTargetAppFrontmost: async () => (await this.deps.frontmostApp().catch(() => null)) === targetApp,
          thunderbird: this.deps.thunderbird,
          signal,
        });
      }
      if (this.generation !== generation) return;
      this.teardown();
      this.setPhase({ kind: "idle" });
    } catch (error) {
      if (!isCurrent()) return;
      log.error(`DictationController: ${mode} failed: ${errorName(error)}`);
      this.teardown();
      this.fail(error instanceof Error && error.message !== "" ? error.message : "Dictation failed. Please try again.");
    }
  }

  /** Pastes into the focused field, logging what it pastes (debug builds, ADR-DESK-015). */
  private readonly paste = async (text: string, signal: AbortSignal): Promise<void> => {
    log.content("DictationController: pasting", text);
    await this.deps.paste(text, signal);
  };

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
      ? DesktopAgent.tools(this.screenRead, this.emailApp.path !== null)
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
    log.debug(() => `DictationController: recorded ${recordingDuration(recording).toFixed(2)}s, peak ${recording.peakLevel.toFixed(3)}, waveform peak ${this.peakMeterLevel.toFixed(3)}, first audio after ${micDelay}`);

    const wav = encodeWAV(recording.pcm, recording.sampleRate);
    this.deps.keepRecording?.(wav);

    // No loudness gate: on quiet built-in microphones speech sits only a few dB above the room
    // noise, so any level threshold rejects real speech. The model decides; an empty transcript is
    // reported by `transcribe`.
    if (recording.pcm.length === 0) {
      log.debug("DictationController: no audio captured; not uploading");
      this.teardown();
      this.fail(nothingHeardMessage);
      return;
    }
    await this.transcribe(wav, current);
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
    this.showDueTip();
    log.debug(`DictationController: listening hands-free (generation ${this.generation})`);
  }

  /** Shows the next due tip the user may still see, while the pill listens and hears (the overlay
   * shows no tip over the warm-up swirl), for its display duration. */
  private showDueTip(): void {
    if (this.currentPhase.kind !== "listening" || !this.hearing || this.currentTip !== null) return;
    while (this.dueTips.length > 0) {
      const next = this.dueTips.shift();
      if (next === undefined || !this.deps.tips.isEligible(next)) continue;
      this.currentTip = next;
      this.deps.tips.recordDisplay(next);
      const current = this.generation;
      this.tipTimer = after(this.tipDisplayDuration(next), () => {
        if (this.generation !== current || this.currentTip !== next) return;
        this.hideTip();
      });
      this.changed();
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
    cancelTimer(this.longHoldTimer);
    this.longHoldTimer = null;
    cancelTimer(this.tipTimer);
    this.tipTimer = null;
    this.currentTip = null;
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
  }

  private fail(message: string): void {
    this.setPhase({ kind: "failed", message });
    cancelTimer(this.failureResetTimer);
    this.failureResetTimer = after(config.overlayErrorDisplayDuration, () => {
      if (this.currentPhase.kind === "failed") this.setPhase({ kind: "idle" });
    });
  }

  private setPhase(phase: Phase): void {
    this.currentPhase = phase;
    this.onPhaseChange?.(phase);
    this.changed();
  }
}

type Timer = ReturnType<typeof setTimeout>;

function after(ms: number, action: () => void): Timer {
  return setTimeout(action, ms);
}

function cancelTimer(timer: Timer | null): void {
  if (timer !== null) clearTimeout(timer);
}
