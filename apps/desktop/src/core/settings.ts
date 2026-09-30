// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { DebugAccess } from "./backend/account.js";
import { type Connector, connectors, isConnector } from "./agent/connectors/connectors.js";
import { type AgentTool, isAgentTool, offeredAgentTools } from "./agent/agentTools.js";
import * as config from "./config.js";
import { type DictionaryEntry, dictionaryWord, isSameWord, storedDictionary } from "./dictionary/dictionary.js";
import { type DictationHotkey, defaultHotkey, isDictationHotkey } from "./hotkey/hotkey.js";
import { type KeyValueStore, storedBool, storedString } from "./util/keyValueStore.js";
import { Observable } from "./util/observable.js";

const Key = {
  hotkey: "dictationHotkey",
  debugMode: "debugMode",
  readsScreen: "readsScreen",
  hasConsented: "hasConsentedToDictationData",
  hasFinishedWelcome: "hasFinishedWelcome",
  emailClient: "emailClient",
  disabledAgentTools: "disabledAgentTools",
  disabledConnectors: "disabledConnectors",
  userName: "userName",
  dictionary: "dictionary",
  learnsWords: "learnsWords",
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
  /** The apps the Answer tool's tools may reach (`LoopTool.connector`) the user has on. */
  enabledConnectors: Connector[];
  /** The email app chosen in Settings; null for the user's default email app. With the system's
   * default, asked as agent mode needs it, it resolves to the app mail and calendar requests go to
   * (`EmailClient.resolve`). */
  emailClient: string | null;
  /** Whether a Thunderbird profile had TabMail's add-on as the dictation started. */
  hasTabMail: boolean;
  /** The user's name, sent with agent mode's requests so the backend can tell the user's own messages
   * on screen from other people's; empty when not set. */
  userName: string;
  /** The user's dictionary words (ADR-DESK-038), sent with the transcription and the cleanup. */
  dictionary: string[];
  /** Whether the dictation's paste is watched to learn the user's corrections. */
  learnsWords: boolean;
}

/** What adding a word to the dictionary did: `invalid` for a word the backend refuses, `full` at
 * `config.dictionaryMaxEntries`. A word already there is `added`, spelled as typed now (and typed, if it was learned). */
export type AddWordResult = "added" | "invalid" | "full";

/** The name the welcome wizard offers (owner, 2026-09-28: "the macOS full name or the username"): the
 * computer account's full name, else its short name. */
export function suggestedUserName(fullName: string, accountName: string): string {
  const name = fullName.trim();
  return name === "" ? accountName.trim() : name;
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

  /** The user's name as entered in the welcome wizard or Settings; null until either stores one (the
   * wizard then offers `suggestedUserName`), empty when the user cleared it. */
  get userName(): string | null {
    return storedString(this.store, Key.userName);
  }

  set userName(value: string | null) {
    if (value === null) this.store.remove(Key.userName);
    else this.store.set(Key.userName, value);
    this.changed();
  }

  /** The name agent mode sends, trimmed; empty when none is set. */
  get sentUserName(): string {
    return (this.userName ?? "").trim();
  }

  /** The user's dictionary, in the order the words were added (ADR-DESK-038). */
  get dictionary(): DictionaryEntry[] {
    return storedDictionary(this.store.get(Key.dictionary));
  }

  /** Adds a word the user typed. One already there takes the spelling typed, the user's latest; one
   * learned becomes typed, so it shows as the user's own. */
  addWord(raw: string): AddWordResult {
    const word = dictionaryWord(raw);
    if (word === null) return "invalid";
    const entries = this.dictionary;
    const existing = entries.findIndex((entry) => isSameWord(entry.word, word));
    if (existing === -1 && entries.length >= config.dictionaryMaxEntries) return "full";
    if (existing === -1) entries.push({ word, learned: false });
    else entries[existing] = { word, learned: false };
    this.writeDictionary(entries);
    return "added";
  }

  /** Adds words learned from the user's corrections, those not already there, while there is room;
   * returns those added. */
  learnWords(words: readonly string[]): string[] {
    const entries = this.dictionary;
    const added: string[] = [];
    for (const raw of words) {
      const word = dictionaryWord(raw);
      if (word === null || entries.length >= config.dictionaryMaxEntries || entries.some((entry) => isSameWord(entry.word, word))) continue;
      entries.push({ word, learned: true });
      added.push(word);
    }
    if (added.length > 0) this.writeDictionary(entries);
    return added;
  }

  removeWord(word: string): void {
    const entries = this.dictionary;
    const kept = entries.filter((entry) => entry.word !== word);
    if (kept.length !== entries.length) this.writeDictionary(kept);
  }

  /** Learn words from the user's corrections of a dictation. On unless the user switches it off. */
  get learnsWords(): boolean {
    return storedBool(this.store, Key.learnsWords) ?? true;
  }

  set learnsWords(value: boolean) {
    this.write(Key.learnsWords, value);
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

  /** Agent mode's offered tools the user has on, in the registry's order. */
  get enabledTools(): AgentTool[] {
    return offeredAgentTools.filter((tool) => this.isEnabled(tool));
  }

  /** The apps the Answer tool reaches that the user switched off, stored by name so one added later
   * starts on. */
  private get disabledConnectors(): Connector[] {
    const stored = this.store.get(Key.disabledConnectors);
    return Array.isArray(stored) ? stored.filter(isConnector) : [];
  }

  /** Whether the Answer tool may reach `connector`'s app. Every one is on unless switched off (owner,
   * 2026-09-26). */
  isConnectorEnabled(connector: Connector): boolean {
    return !this.disabledConnectors.includes(connector);
  }

  setConnectorEnabled(connector: Connector, enabled: boolean): void {
    const others = this.disabledConnectors.filter((disabled) => disabled !== connector);
    this.store.set(Key.disabledConnectors, (enabled ? others : [...others, connector]).sort());
    this.changed();
  }

  /** The apps the Answer tool reaches that the user has on, in the registry's order. */
  get enabledConnectors(): Connector[] {
    return connectors.filter((connector) => this.isConnectorEnabled(connector));
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
      enabledConnectors: this.enabledConnectors,
      emailClient: this.emailClient,
      hasTabMail: this.hasTabMail(),
      userName: this.sentUserName,
      dictionary: this.dictionary.map((entry) => entry.word),
      learnsWords: this.learnsWords,
    };
  }

  private writeDictionary(entries: DictionaryEntry[]): void {
    this.store.set(Key.dictionary, entries);
    this.changed();
  }

  private write(key: string, value: boolean): void {
    this.store.set(key, value);
    this.changed();
  }
}
