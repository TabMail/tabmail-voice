// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AgentChat } from "../core/agent/chat.js";
import type { BubbleKey } from "../core/agent/bubbleOrder.js";
import { type ConnectorID, isConnectorID } from "../core/agent/connectors/index.js";
import { isEventDuration } from "../core/agent/connectors/settings.js";
import { type AgentToolID, switchableAgentToolIDs } from "../core/agent/tools.js";
import type { Phase } from "../core/dictation/controller.js";
import { type DictationHotkey, type DictationMode, isDictationHotkey } from "../core/hotkey/bindings.js";
import * as config from "../core/config.js";
import type { DictionaryEntry } from "../core/dictionary/entries.js";
import type { ExcludedApp } from "../core/dictation/excludedApps.js";
import type { StoredFile } from "../core/ui/fileProblems.js";
import type { MemoryPageState } from "../core/memory/page.js";
import type { PersonalizationState } from "../core/personalization/page.js";
import type { ShownBullet } from "../core/personalization/prompts.js";
import { displayedSections, isName } from "../core/sync/bullets.js";
import type { UpdateState } from "../core/ui/menuModel.js";
import type { PasteEntry } from "../core/dictation/pasteHistory.js";
import type { ScreenContext } from "../core/dictation/screenContext.js";
import type { DictationTip } from "../core/onboarding/tips.js";
import type { WelcomeStep } from "../core/onboarding/welcomeWizard.js";

/** Between the main process, which owns every model, and the windows, which draw its state and send
 * back what the user did. The preload script exposes `VoiceBridge` as `window.voice`. */

/** What the overlay draws. */
export interface OverlayState {
  /** Standalone pill anchor inside the actual native surface; transparent canvas edges are not anchors. */
  overlayPlacement?: { anchor: { x: number; y: number }; canvas: { width: number; height: number } };
  /** The overlay's latest showing afresh (`OverlayWindowController.reveal`): it stays transparent until
   * the page says it has drawn the state carrying it (`overlayDrawn`). */
  reveal: number;
  phase: Phase;
  mode: DictationMode;
  level: number;
  isHearing: boolean;
  /** `DictationController.hasVoice`: the waveform takes its recording colour. */
  hasVoice: boolean;
  /** `DictationController.isRetrying`: the thinking circle's arc and track fade to the retry's colors. */
  isRetrying: boolean;
  language: string | null;
  tip: DictationTip | null;
  gnomeRecordingKeys?: boolean;
  /** The overlay opened above the caret's line, so a tip that stays up goes over the pill
   * (`tipGoesAbove`). */
  opensUpward: boolean;
  /** Agent mode's row of bubbles fits under the pill (`bubblesFitUnder`); else it goes over it. */
  bubblesFitUnder: boolean;
  hotkey: DictationHotkey;
  tools: AgentToolID[];
  /** Whether this request offers the whole-window screen-reading tool. */
  readsWindow: boolean;
  /** The apps whose bubbles show beside the tools' (`DictationController.connectors`). */
  connectors: ConnectorID[];
  /** The bubbles whose tools ran, the most recent first, which the row is ordered by (`bubbleOrder`). */
  recentBubbles: BubbleKey[];
  /** The one bubble that runs now (`DictationController.runningBubble`), first in the row; null when none does. */
  runningBubble: BubbleKey | null;
  /** The email app's icon, for the Thunderbird bubble; null without one. */
  emailAppIcon: string | null;
  /** The chat window's conversation while it is open, over the pill. */
  chat: AgentChat | null;
  /** Where the chat window shows while it is open (`chatWindowFrame`). */
  chatPlacement: ChatPlacement | null;
}

export interface ChatPlacement {
  /** Logical canvas edges relative to the actual on-screen surface after native bounds constraints. */
  frameOffset?: { x: number; top: number; bottom: number };
  /** Chat content width when the available placement region is narrower than its usual width. */
  width?: number;
  /** Under the pill and its bubbles (`chatSide`), or over them. */
  below: boolean;
  /** How tall the chat grows before it scrolls: at most `chatMaxHeight`, less where the screen has less
   * room (`chatSide`). */
  maxHeight: number;
  /** The bubbles are under the pill, or over it (`bubblesFitUnder`, where the pill opened). */
  bubblesUnder: boolean;
  /** The pill's center, across the window. */
  pillX: number;
}

export interface EmailAppChoice {
  bundleIdentifier: string;
  name: string;
}

export type GnomeIntegrationState = "checking" | "ready" | "available" | "restart" | "unsupported" | "unavailable";

export interface SettingsState {
  availableHotkeys: readonly DictationHotkey[];
  email: string | null;
  hotkey: DictationHotkey;
  readsScreen: boolean;
  /** Null: the default email app. */
  emailClient: string | null;
  systemEmailApp: EmailAppChoice | null;
  installedEmailApps: EmailAppChoice[];
  hasTabMail: boolean;
  /** Whether the default email app takes mail requests (`EmailClient.resolve`). */
  defaultEmailAppIsSupported: boolean;
  /** Agent mode's tools switched on. */
  enabledTools: AgentToolID[];
  /** The apps the Answer tool can reach on this computer (none but on macOS), and those switched on. */
  connectors: ConnectorID[];
  enabledConnectors: ConnectorID[];
  /** The user's name as stored (`AppSettings.userName`): null when never set. */
  userName: string | null;
  /** The computer account's name (`suggestedUserName`), shown where no name is set. */
  suggestedName: string;
  /** The user's dictionary (ADR-DESK-038), and whether corrections are learned into it: only where
   * the field can be read (`canLearnWords`, macOS). */
  dictionary: DictionaryEntry[];
  learnsWords: boolean;
  canLearnWords: boolean;
  /** Smart dictation: the AI cleanup of each dictation. */
  smartDictation: boolean;
  /** Opt Out of AI (`AppSettings.optsOutOfAI`). */
  optsOutOfAI: boolean;
  /** Device Sync's switch (`AppSettings.syncsDevices`), and whether the texts were too large to send
   * (`DeviceSync.tooLarge`). */
  syncsDevices: boolean;
  deviceSyncTooLarge: boolean;
  /** Whether a click elsewhere or another app in front closes the idle chat window. */
  closesChatElsewhere: boolean;
  /** How long a new event lasts when no end is given (minutes; `AppSettings.eventDuration`). */
  eventDuration: number;
  /** The apps the user excludes from screen reading, besides the built-in ones
   * (`config.builtInExcludedApps`); shown only where the screen is read (`canExcludeApps`, macOS). */
  excludedApps: ExcludedApp[];
  /** The websites the user excludes from screen reading, by host, beside the built-in web vaults
   * (`config.builtInExcludedSites`). */
  excludedSites: string[];
  canExcludeApps: boolean;
  builtInExcludedApps: readonly ExcludedApp[];
  microphoneGranted: boolean;
  accessibilityTrusted: boolean;
  vscodeFix: VSCodeFix;
  /** Platform-specific wording for the permission needed to type into other apps. */
  keyboardPermission?: { title: string; description: string; button: string; instructions: string; agentShortcut?: string };
  gnomeIntegration?: GnomeIntegrationState;
  /** Ubuntu: the Shell couldn't hold Right Alt, which is AltGr on this keyboard layout. */
  hotkeyUnavailable?: boolean;
  openAtLogin: boolean;
  /** Whether this account may switch debug mode on (`DebugAccess`). */
  debugAllowed: boolean;
  debugMode: boolean;
  /** The app's version (`app.getVersion()`), shown in Settings › General. */
  version: string;
  /** Where an update is, for Settings › General's update button; null where the app doesn't update
   * itself (a debug build). */
  update: UpdateState | null;
  /** Settings › Memory: past agent-mode requests (ADR-DESK-061). */
  memory: MemoryPageState;
  /** Settings › Personalization: the writing style, the knowledge base and their history
   * (ADR-DESK-063). */
  personalization: PersonalizationState;
  /** The app's files that couldn't be read at launch: Settings says so above every section. */
  fileProblems: StoredFile[];
}

/** Whether VS Code's settings hide the caret from TabMail Voice (`vscodeHidesCaret`), so the
 * welcome wizard's Accessibility step and Settings › Permissions offer to change them; "done" once
 * one has, this session. */
export type VSCodeFix = "notNeeded" | "needed" | "done";

export interface WelcomeState {
  step: WelcomeStep;
  index: number;
  categoryIndex: number;
  isFirstStep: boolean;
  isLastStep: boolean;
  canAdvance: boolean;
  hasConsented: boolean;
  /** Whether the native helper supports local correction learning. */
  canLearnWords: boolean;
  readsScreen: boolean;
  /** Agent mode's tools switched on. */
  enabledTools: AgentToolID[];
  /** The apps the Answer tool can reach on this computer (none but on macOS), and those switched on. */
  connectors: ConnectorID[];
  enabledConnectors: ConnectorID[];
  /** The user's name as stored: null when never set, and the name step then offers `suggestedName`. */
  userName: string | null;
  suggestedName: string;
  microphoneGranted: boolean;
  accessibilityTrusted: boolean;
  vscodeFix: VSCodeFix;
  /** Platform-specific wording for the permission needed to type into other apps. */
  keyboardPermission?: { title: string; description: string; button: string; instructions: string; agentShortcut?: string };
}

/** The paste history a triple tap shows (ADR-DESK-043), the newest first. */
export interface HistoryState {
  entries: PasteEntry[];
}

export interface ContextDebugState {
  context: ScreenContext | null;
}

export interface WindowStates {
  overlay: OverlayState;
  settings: SettingsState;
  welcome: WelcomeState;
  contextDebug: ContextDebugState;
  history: HistoryState;
}

export type WindowName = keyof WindowStates;

/** What a window asks the main process to do. */
export type Command =
  | { type: "sendCode"; email: string }
  | { type: "verify"; email: string; code: string }
  | { type: "signOut" }
  | { type: "setHotkey"; hotkey: DictationHotkey }
  | { type: "setReadsScreen"; value: boolean }
  | { type: "setUserName"; value: string }
  | { type: "addDictionaryWord"; word: string }
  | { type: "removeDictionaryWord"; word: string }
  | { type: "setLearnsWords"; value: boolean }
  | { type: "setSmartDictation"; value: boolean }
  | { type: "setOptsOutOfAI"; value: boolean }
  | { type: "setSyncsDevices"; value: boolean }
  | { type: "setClosesChatElsewhere"; value: boolean }
  | { type: "setEventDuration"; value: number }
  /** Asks the user to pick an app, and excludes it from screen reading. */
  | { type: "excludeApp" }
  | { type: "removeExcludedApp"; bundleIdentifier: string }
  /** Excludes a website from screen reading: `site` is its host or its address, as typed. */
  | { type: "excludeSite"; site: string }
  | { type: "removeExcludedSite"; host: string }
  | { type: "setEmailClient"; bundleIdentifier: string | null }
  | { type: "setAgentToolEnabled"; tool: AgentToolID; value: boolean }
  | { type: "setConnectorEnabled"; connector: ConnectorID; value: boolean }
  | { type: "setOpenAtLogin"; value: boolean }
  | { type: "setDebugMode"; value: boolean }
  /** Settings › Memory: read it afresh (the page shows), search it (`query` empty: the newest),
   * choose its size limit, remove one exchange, or all. */
  | { type: "loadMemory" }
  | { type: "searchMemory"; query: string }
  | { type: "setMemorySizeLimit"; value: number }
  | { type: "removeMemory"; memId: string }
  /** Removes every exchange older than `days` days (#247). */
  | { type: "removeOldMemory"; days: number }
  | { type: "clearMemory" }
  /** Settings › Personalization: a writing style section's or the knowledge base's bullets edited,
   * from those the page showed (`shown`); either text reset to its default; the texts put back as a
   * history entry holds them. */
  | { type: "editWritingStyle"; section: string; shown: ShownBullet[]; bullets: string[] }
  | { type: "editKnowledgeBase"; shown: ShownBullet[]; bullets: string[] }
  | { type: "resetWritingStyle" }
  | { type: "resetKnowledgeBase" }
  | { type: "restorePromptHistory"; id: string }
  | { type: "setConsent"; value: boolean }
  | { type: "requestMicrophone" }
  | { type: "requestAccessibility" }
  | { type: "enableGnomeIntegration" }
  | { type: "checkForUpdates" }
  | { type: "installUpdate" }
  | { type: "welcomeNext" }
  | { type: "welcomeBack" }
  | { type: "welcomeGoTo"; index: number }
  | { type: "fixVSCodeSettings" }
  | { type: "openURL"; url: string }
  /** The chat window: the user touched it (a hover, click or scroll), closed it, opened a reply's
   * link, confirmed or declined its question, it measured its height, or the pointer moved over it,
   * or over the note for a text not pasted, or off it (`ChatHitTest`). */
  | { type: "keepChatOpen" }
  | { type: "closeChat" }
  | { type: "openChatLink"; url: string }
  | { type: "answerConfirmation"; confirmed: boolean }
  | { type: "chatHeight"; height: number }
  | { type: "pointerOver"; over: boolean }
  /** The overlay page drew the state of its showing `reveal` (`OverlayState.reveal`). */
  | { type: "overlayDrawn"; reveal: number }
  /** The chat window is dragged, its pill and bubbles with it: the drag started, and how far it has
   * gone since (points, across and down). */
  | { type: "chatDragStart" }
  | { type: "dragChat"; dx: number; dy: number }
  /** The note for a text not pasted: clicked, to copy the text; its x, to dismiss it. */
  | { type: "copyNotPasted" }
  | { type: "dismissNotPasted" }
  /** The paste history: an entry clicked, to copy; closed (Escape); its list measured. */
  | { type: "copyHistoryEntry"; id: number }
  | { type: "closeHistory" }
  | { type: "historyHeight"; height: number };

/** A command's outcome: an error message to show, or none. */
export interface CommandResult {
  error: string | null;
}

/** What the main process tells the microphone: `voice-macos` on macOS, the hidden audio window elsewhere. */
export type AudioCommand = { type: "prepare" } | { type: "start"; session: number } | { type: "stop"; session: number };

/** The microphone's reports, for one `start`'s `session`. */
export type AudioReport =
  | { type: "started"; session: number }
  | { type: "failed"; session: number; error: string }
  | { type: "chunk"; session: number; samples: Float32Array };

export interface VoiceBridge {
  /** Calls `listener` with the window's state now and on every change, until the returned
   * function is called. */
  onState<Name extends WindowName>(window: Name, listener: (state: WindowStates[Name]) => void): () => void;
  send(command: Command): Promise<CommandResult>;
  onAudioCommand(listener: (command: AudioCommand) => void): void;
  reportAudio(report: AudioReport): void;
}

export const channels = {
  state: "voice:state",
  getState: "voice:get-state",
  command: "voice:command",
  audioCommand: "voice:audio-command",
  audioReport: "voice:audio-report",
} as const;

const windowNames: readonly WindowName[] = ["overlay", "settings", "welcome", "contextDebug", "history"];

export function isWindowName(value: unknown): value is WindowName {
  return windowNames.includes(value as WindowName);
}

/** Whether `value`, as received over IPC, is a well-formed `Command`. */
export function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "signOut":
    case "requestMicrophone":
    case "requestAccessibility":
    case "enableGnomeIntegration":
    case "checkForUpdates":
    case "installUpdate":
    case "welcomeNext":
    case "welcomeBack":
    case "fixVSCodeSettings":
    case "keepChatOpen":
    case "closeChat":
    case "chatDragStart":
    case "closeHistory":
    case "excludeApp":
    case "copyNotPasted":
    case "dismissNotPasted":
    case "loadMemory":
    case "clearMemory":
    case "resetWritingStyle":
    case "resetKnowledgeBase":
      return true;
    case "editWritingStyle":
      return typeof command.section === "string" && displayedSections("composition").includes(command.section) && isShownList(command.shown) && isBulletList(command.bullets);
    case "editKnowledgeBase":
      return isShownList(command.shown) && isBulletList(command.bullets);
    case "restorePromptHistory":
      return typeof command.id === "string" && command.id.length <= config.promptHistoryIDMaxLength;
    case "searchMemory":
      return typeof command.query === "string" && command.query.length <= config.memorySearchMaxLength;
    case "setMemorySizeLimit":
      return typeof command.value === "number" && config.memorySizeLimitChoices.includes(command.value);
    case "setEventDuration":
      return typeof command.value === "number" && isEventDuration(command.value);
    case "removeMemory":
      return typeof command.memId === "string" && command.memId.length <= config.memoryIDMaxLength;
    case "removeOldMemory":
      return typeof command.days === "number" && Number.isInteger(command.days) && command.days >= 1 && command.days <= config.memoryRemoveOldDaysMax;
    case "removeExcludedApp":
      return typeof command.bundleIdentifier === "string" && command.bundleIdentifier.length <= config.bundleIdentifierMaxLength;
    case "excludeSite":
      return typeof command.site === "string" && command.site.length <= config.excludedSiteInputMaxLength;
    case "removeExcludedSite":
      return typeof command.host === "string" && command.host.length <= config.hostMaxLength;
    case "copyHistoryEntry":
      return Number.isInteger(command.id);
    case "sendCode":
      return typeof command.email === "string";
    case "verify":
      return typeof command.email === "string" && typeof command.code === "string";
    case "setHotkey":
      return isDictationHotkey(command.hotkey);
    case "setReadsScreen":
    case "setLearnsWords":
    case "setSmartDictation":
    case "setOptsOutOfAI":
    case "setSyncsDevices":
    case "setClosesChatElsewhere":
    case "setOpenAtLogin":
    case "setDebugMode":
    case "setConsent":
      return typeof command.value === "boolean";
    case "setUserName":
      return typeof command.value === "string" && command.value.length <= config.userNameMaxLength;
    case "addDictionaryWord":
    case "removeDictionaryWord":
      return typeof command.word === "string" && command.word.length <= config.dictionaryWordMaxChars;
    case "setEmailClient":
      return command.bundleIdentifier === null || typeof command.bundleIdentifier === "string";
    case "welcomeGoTo":
      return Number.isInteger(command.index);
    case "openURL":
    case "openChatLink":
      return typeof command.url === "string";
    case "answerConfirmation":
      return typeof command.confirmed === "boolean";
    case "setAgentToolEnabled":
      // Answer has no switch.
      return (switchableAgentToolIDs as readonly unknown[]).includes(command.tool) && typeof command.value === "boolean";
    case "setConnectorEnabled":
      return isConnectorID(command.connector) && typeof command.value === "boolean";
    case "pointerOver":
      return typeof command.over === "boolean";
    case "overlayDrawn":
      return typeof command.reveal === "number" && Number.isSafeInteger(command.reveal) && command.reveal >= 0;
    case "dragChat":
      return typeof command.dx === "number" && Number.isFinite(command.dx) && typeof command.dy === "number" && Number.isFinite(command.dy);
    case "chatHeight":
    case "historyHeight":
      return typeof command.height === "number" && Number.isFinite(command.height) && command.height > 0;
    default:
      return false;
  }
}

/** Whether `value` is a list of bullets. Neither their number nor their length is capped: the knowledge
 * base's other writer (`kb_add`) isn't, and an edit carries every bullet shown, so a cap
 * here would refuse every edit of a knowledge base holding one bullet past it (the Settings fields
 * keep a typed bullet within `personalizationBulletMaxLength`). */
function isBulletList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((bullet) => typeof bullet === "string");
}

/** Bullets as Settings showed them, each with its labels (`ShownBullet`). */
function isShownList(value: unknown): value is ShownBullet[] {
  return (
    Array.isArray(value) &&
    value.every((bullet: unknown) => {
      if (!bullet || typeof bullet !== "object") return false;
      const { text, labels } = bullet as Record<string, unknown>;
      return typeof text === "string" && Array.isArray(labels) && labels.every((label: unknown) => Array.isArray(label) && label.length === 2 && isName(label[0]) && Number.isSafeInteger(label[1]) && (label[1] as number) >= 1);
    })
  );
}

/** Whether `value`, as received over IPC, is a well-formed `AudioReport`. */
export function isAudioReport(value: unknown): value is AudioReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  if (!Number.isInteger(report.session)) return false;
  switch (report.type) {
    case "started":
      return true;
    case "failed":
      return typeof report.error === "string";
    case "chunk":
      return report.samples instanceof Float32Array;
    default:
      return false;
  }
}
