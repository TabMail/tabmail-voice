// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { DebugAccess } from "./account.js";
import { type AgentTool, agentTools, isAgentTool } from "./agent/tools.js";
import * as config from "./config.js";
import { type DictationHotkey, defaultHotkey, isDictationHotkey } from "./hotkey.js";
import { type KeyValueStore, storedBool, storedString } from "./keyValueStore.js";
import { Observable } from "./observable.js";

const Key = {
  hotkey: "dictationHotkey",
  debugMode: "debugMode",
  readsScreen: "readsScreen",
  hasConsented: "hasConsentedToDictationData",
  hasFinishedWelcome: "hasFinishedWelcome",
  emailClient: "emailClient",
  disabledAgentTools: "disabledAgentTools",
} as const;

/** The settings one dictation uses, read as the first thing it does when it starts and fixed for
 * the rest of it: a change in Settings meanwhile applies from the next dictation (owner,
 * 2026-09-26). */
export interface DictationSettings {
  hasConsented: boolean;
  /** The key held to dictate, which the double-tap tip names. */
  hotkey: DictationHotkey;
  backendURL: string;
  readsScreen: boolean;
  /** Agent mode's tools the user has on. */
  enabledTools: AgentTool[];
  /** The email app chosen in Settings; null for the user's default email app. With the system's
   * default, asked as agent mode needs it, it resolves to the app mail and calendar requests go to
   * (`EmailClient.resolve`). */
  emailClient: string | null;
  /** Whether a Thunderbird profile had TabMail's add-on as the dictation started. */
  hasTabMail: boolean;
}

/** User preferences, persisted in the app's store. */
export class AppSettings extends Observable {
  /** Called when the hotkey changes. */
  onHotkeyChange: ((hotkey: DictationHotkey) => void) | undefined;

  constructor(
    private readonly store: KeyValueStore,
    /** Whether a Thunderbird profile has TabMail's add-on (`EmailClient.hasTabMail`). */
    private readonly hasTabMail: () => boolean,
  ) {
    super();
  }

  get hotkey(): DictationHotkey {
    const stored = storedString(this.store, Key.hotkey);
    return isDictationHotkey(stored) ? stored : defaultHotkey;
  }

  set hotkey(value: DictationHotkey) {
    this.store.set(Key.hotkey, value);
    this.changed();
    this.onHotkeyChange?.(value);
  }

  /** The debug-mode switch as stored. Only `isDebugMode` says whether debug mode is on. */
  get debugMode(): boolean {
    return storedBool(this.store, Key.debugMode) ?? false;
  }

  set debugMode(value: boolean) {
    this.write(Key.debugMode, value);
  }

  /** Read the text of the window in front when a dictation starts and send it with the transcript
   * for the cleanup (ADR-DESK-008). On unless the user switches it off. */
  get readsScreen(): boolean {
    return storedBool(this.store, Key.readsScreen) ?? true;
  }

  set readsScreen(value: boolean) {
    this.write(Key.readsScreen, value);
  }

  /** The user agreed, in the welcome wizard, to what dictation sends. No dictation without it. */
  get hasConsented(): boolean {
    return storedBool(this.store, Key.hasConsented) ?? false;
  }

  set hasConsented(value: boolean) {
    this.write(Key.hasConsented, value);
  }

  /** The welcome wizard was finished; until then it opens at every launch. */
  get hasFinishedWelcome(): boolean {
    return storedBool(this.store, Key.hasFinishedWelcome) ?? false;
  }

  set hasFinishedWelcome(value: boolean) {
    this.write(Key.hasFinishedWelcome, value);
  }

  /** The bundle identifier of the email app that mail and calendar requests go to; null for the
   * user's default email app (`EmailClient`). */
  get emailClient(): string | null {
    return storedString(this.store, Key.emailClient);
  }

  set emailClient(value: string | null) {
    if (value === null) this.store.remove(Key.emailClient);
    else this.store.set(Key.emailClient, value);
    this.changed();
  }

  /** Agent mode's tools the user switched off, stored by name so a tool added later starts on. */
  private get disabledAgentTools(): AgentTool[] {
    const stored = this.store.get(Key.disabledAgentTools);
    return Array.isArray(stored) ? stored.filter(isAgentTool) : [];
  }

  /** Whether agent mode may use `tool`. Every tool is on unless switched off (owner, 2026-09-26). */
  isEnabled(tool: AgentTool): boolean {
    return !this.disabledAgentTools.includes(tool);
  }

  setEnabled(tool: AgentTool, enabled: boolean): void {
    const others = this.disabledAgentTools.filter((disabled) => disabled !== tool);
    this.store.set(Key.disabledAgentTools, (enabled ? others : [...others, tool]).sort());
    this.changed();
  }

  /** Agent mode's tools the user has on, in the registry's order. */
  get enabledTools(): AgentTool[] {
    return agentTools.filter((tool) => this.isEnabled(tool));
  }

  /** Debug mode: dictation goes to dev.tabmail.ai (the development server) instead of
   * api.tabmail.ai, and the menu shows its debug items. On only while the account signed in
   * (`email`) is one `DebugAccess` allows, so a switch left on by an allowed account does nothing
   * for any other. */
  isDebugMode(email: string | null): boolean {
    return this.debugMode && DebugAccess.allows(email);
  }

  backendURL(email: string | null): string {
    return this.isDebugMode(email) ? config.developmentBackendURL : config.productionBackendURL;
  }

  /** What a dictation by the account signed in (`email`) uses, read once as it starts. */
  dictation(email: string | null): DictationSettings {
    return {
      hasConsented: this.hasConsented,
      hotkey: this.hotkey,
      backendURL: this.backendURL(email),
      readsScreen: this.readsScreen,
      enabledTools: this.enabledTools,
      emailClient: this.emailClient,
      hasTabMail: this.hasTabMail(),
    };
  }

  private write(key: string, value: boolean): void {
    this.store.set(key, value);
    this.changed();
  }
}
