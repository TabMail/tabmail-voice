// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AgentTool } from "../core/agent/tools.js";
import type { Phase } from "../core/dictationController.js";
import { type DictationHotkey, type DictationMode, isDictationHotkey } from "../core/hotkey.js";
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
  hotkey: DictationHotkey;
  tools: AgentTool[];
  /** The email app's icon, for the Thunderbird bubble; null without one. */
  emailAppIcon: string | null;
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
  microphoneGranted: boolean;
  accessibilityTrusted: boolean;
  openAtLogin: boolean;
  /** Whether this account may switch debug mode on (`DebugAccess`). */
  debugAllowed: boolean;
  debugMode: boolean;
}

export interface WelcomeState {
  step: WelcomeStep;
  index: number;
  categoryIndex: number;
  isFirstStep: boolean;
  isLastStep: boolean;
  canAdvance: boolean;
  hasConsented: boolean;
  readsScreen: boolean;
  microphoneGranted: boolean;
  accessibilityTrusted: boolean;
}

export interface ContextDebugState {
  context: ScreenContext | null;
}

export interface WindowStates {
  overlay: OverlayState;
  settings: SettingsState;
  welcome: WelcomeState;
  contextDebug: ContextDebugState;
}

export type WindowName = keyof WindowStates;

/** What a window asks the main process to do. */
export type Command =
  | { type: "sendCode"; email: string }
  | { type: "verify"; email: string; code: string }
  | { type: "signOut" }
  | { type: "setHotkey"; hotkey: DictationHotkey }
  | { type: "setReadsScreen"; value: boolean }
  | { type: "setEmailClient"; bundleIdentifier: string | null }
  | { type: "setOpenAtLogin"; value: boolean }
  | { type: "setDebugMode"; value: boolean }
  | { type: "setConsent"; value: boolean }
  | { type: "requestMicrophone" }
  | { type: "requestAccessibility" }
  | { type: "welcomeNext" }
  | { type: "welcomeBack" }
  | { type: "welcomeGoTo"; index: number }
  | { type: "openURL"; url: string };

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

const windowNames: readonly WindowName[] = ["overlay", "settings", "welcome", "contextDebug"];

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
    case "welcomeNext":
    case "welcomeBack":
      return true;
    case "sendCode":
      return typeof command.email === "string";
    case "verify":
      return typeof command.email === "string" && typeof command.code === "string";
    case "setHotkey":
      return isDictationHotkey(command.hotkey);
    case "setReadsScreen":
    case "setOpenAtLogin":
    case "setDebugMode":
    case "setConsent":
      return typeof command.value === "boolean";
    case "setEmailClient":
      return command.bundleIdentifier === null || typeof command.bundleIdentifier === "string";
    case "welcomeGoTo":
      return Number.isInteger(command.index);
    case "openURL":
      return typeof command.url === "string";
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
