// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AgentChat } from "../core/agent/agentChat.js";
import type { BubbleKey } from "../core/agent/bubbleOrder.js";
import { type Connector, isConnector } from "../core/agent/connectors.js";
import { type AgentTool, isAgentTool } from "../core/agent/tools.js";
import type { Phase } from "../core/dictationController.js";
import { type DictationHotkey, type DictationMode, isDictationHotkey } from "../core/hotkey.js";
import * as config from "../core/config.js";
import type { DictionaryEntry } from "../core/dictionary.js";
import type { UpdateState } from "../core/menuModel.js";
import type { PasteEntry } from "../core/pasteHistory.js";
import type { ScreenContext } from "../core/screenContext.js";
import type { DictationTip } from "../core/tips.js";
import type { WelcomeStep } from "../core/welcomeWizard.js";

/** Between the main process, which owns every model, and the windows, which draw its state and send
 * back what the user did. The preload script exposes `VoiceBridge` as `window.voice`. */

/** What the overlay draws. */
export interface OverlayState {
  phase: Phase;
  mode: DictationMode;
  level: number;
  isHearing: boolean;
  language: string | null;
  tip: DictationTip | null;
  /** The overlay opened above the caret's line, so a tip that stays up goes over the pill
   * (`tipGoesAbove`). */
  opensUpward: boolean;
  /** Agent mode's row of bubbles fits under the pill (`bubblesFitUnder`); else it goes over it. */
  bubblesFitUnder: boolean;
  hotkey: DictationHotkey;
  tools: AgentTool[];
  /** The apps whose bubbles show beside the tools' (`DictationController.connectors`). */
  connectors: Connector[];
  /** The bubbles whose tools ran, the most recent first, which the row is ordered by (`bubbleOrder`). */
  recentBubbles: BubbleKey[];
  /** The apps whose tools run now, whose bubbles run too. */
  runningConnectors: Connector[];
  /** The email app's icon, for the Thunderbird bubble; null without one. */
  emailAppIcon: string | null;
  /** The chat window's conversation while it is open, over the pill. */
  chat: AgentChat | null;
  /** Where the chat window shows while it is open (`chatWindowFrame`). */
  chatPlacement: ChatPlacement | null;
}

export interface ChatPlacement {
  /** Under the pill and its bubbles (`chatSide`), or over them. */
  below: boolean;
  /** How tall the chat grows before it scrolls: at most `chatMaxHeight`, less where the screen has less
   * room (`chatSide`). */
  maxHeight: number;
  /** The bubbles are under the pill, or over it (`bubblesFitUnder`, where the pill opened). */
  bubblesUnder: boolean;
  /** The pill's centre, across the window. */
  pillX: number;
}

export interface EmailAppChoice {
  bundleIdentifier: string;
  name: string;
}

export interface SettingsState {
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
  enabledTools: AgentTool[];
  /** The apps the Answer tool can reach on this computer (none but on macOS), and those switched on. */
  connectors: Connector[];
  enabledConnectors: Connector[];
  /** The user's name as stored (`AppSettings.userName`): null when never set. */
  userName: string | null;
  /** The computer account's name (`suggestedUserName`), shown where no name is set. */
  suggestedName: string;
  /** The user's dictionary (ADR-DESK-038), and whether corrections are learned into it: only where
   * the field can be read (`canLearnWords`, macOS). */
  dictionary: DictionaryEntry[];
  learnsWords: boolean;
  canLearnWords: boolean;
  microphoneGranted: boolean;
  accessibilityTrusted: boolean;
  vscodeFix: VSCodeFix;
  openAtLogin: boolean;
  /** Whether this account may switch debug mode on (`DebugAccess`). */
  debugAllowed: boolean;
  debugMode: boolean;
  /** The app's version (`app.getVersion()`), shown in Settings › General. */
  version: string;
  /** Where an update is, for Settings › General's update button; null where the app doesn't update
   * itself (a debug build). */
  update: UpdateState | null;
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
  readsScreen: boolean;
  /** Agent mode's tools switched on. */
  enabledTools: AgentTool[];
  /** The apps the Answer tool can reach on this computer (none but on macOS), and those switched on. */
  connectors: Connector[];
  enabledConnectors: Connector[];
  /** The user's name as stored: null when never set, and the name step then offers `suggestedName`. */
  userName: string | null;
  suggestedName: string;
  microphoneGranted: boolean;
  accessibilityTrusted: boolean;
  vscodeFix: VSCodeFix;
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
  | { type: "setEmailClient"; bundleIdentifier: string | null }
  | { type: "setAgentToolEnabled"; tool: AgentTool; value: boolean }
  | { type: "setConnectorEnabled"; connector: Connector; value: boolean }
  | { type: "setOpenAtLogin"; value: boolean }
  | { type: "setDebugMode"; value: boolean }
  | { type: "setConsent"; value: boolean }
  | { type: "requestMicrophone" }
  | { type: "requestAccessibility" }
  | { type: "checkForUpdates" }
  | { type: "restartToUpdate" }
  | { type: "welcomeNext" }
  | { type: "welcomeBack" }
  | { type: "welcomeGoTo"; index: number }
  | { type: "fixVSCodeSettings" }
  | { type: "openURL"; url: string }
  /** The chat window: the user touched it (a hover, click or scroll), closed it, opened a reply's
   * link, confirmed or declined its question, or it measured its height. */
  | { type: "keepChatOpen" }
  | { type: "closeChat" }
  | { type: "openChatLink"; url: string }
  | { type: "answerConfirmation"; confirmed: boolean }
  | { type: "chatHeight"; height: number }
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
  | { type: "chunk"; session: number; samples: Float32Array }
  /** The microphone stopped by itself mid-session (its input's format changed). */
  | { type: "lost"; session: number };

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
    case "checkForUpdates":
    case "restartToUpdate":
    case "welcomeNext":
    case "welcomeBack":
    case "fixVSCodeSettings":
    case "keepChatOpen":
    case "closeChat":
    case "closeHistory":
      return true;
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
      return isAgentTool(command.tool) && typeof command.value === "boolean";
    case "setConnectorEnabled":
      return isConnector(command.connector) && typeof command.value === "boolean";
    case "chatHeight":
    case "historyHeight":
      return typeof command.height === "number" && Number.isFinite(command.height) && command.height > 0;
    default:
      return false;
  }
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
    case "lost":
      return true;
    default:
      return false;
  }
}
