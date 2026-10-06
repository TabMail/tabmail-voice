// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { DebugAccess } from "./backend/account.js";
import { type ConnectorID, connectorIDs, isConnectorID } from "./agent/connectors/index.js";
import { type AgentToolID, isAgentToolID, offeredAgentToolIDs } from "./agent/tools.js";
import * as config from "./config.js";
import { type ExcludedApp, excludedApp, isBuiltInExcludedApp, isSameApp, storedExcludedApps } from "./dictation/excludedApps.js";
import { excludedSite, isBuiltInExcludedSite, storedExcludedSites } from "./dictation/excludedSites.js";
import { type DictionaryEntry, dictionaryWord, isSameWord, leastRecentlyUsedLearned, nextUse, storedDictionary } from "./dictionary/entries.js";
import { type DictationHotkey, defaultHotkey, isDictationHotkey } from "./hotkey/bindings.js";
import { log } from "./log.js";
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
  smartDictation: "smartDictation",
  excludedApps: "excludedApps",
  excludedSites: "excludedSites",
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
  /** The bundle identifiers of the apps the screen is never read in: the built-in password managers
   * and those the user excludes (`ExcludedApp`). */
  excludedApps: string[];
  /** The hosts of the websites the screen is never read on: the built-in web vaults and those the
   * user excludes. A host covers its subdomains. */
  excludedSites: string[];
  /** Agent mode's tools the user has on. */
  enabledTools: AgentToolID[];
  /** The apps the Answer tool's tools may reach (`ConnectorTool.connector`) the user has on. */
  enabledConnectors: ConnectorID[];
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
  /** Whether the dictation asks for the backend's cleanup (and a long dictation for its final polish);
   * off, the transcript is pasted as heard. */
  smartDictation: boolean;
}

/** What adding a word to the dictionary did: `invalid` for a word the backend refuses, `full` at
 * `config.dictionaryMaxTypedWords` typed words (a learned word typed again would be one more). A word
 * already there is `added`, spelled as typed now (and typed, if it was learned). */
export type AddWordResult = "added" | "invalid" | "full";

/** What excluding an app did: `invalid` for one without a bundle identifier or name, `full` at
 * `config.exclusionsMax`. One already excluded, built in or by the user, is `added`. `unsaved`
 * when the list could not be written to disk: the app is not excluded, the list being what is
 * saved (owner, 2026-10-01), and the user must be told. */
export type ExcludeAppResult = "added" | "invalid" | "full" | "unsaved";

/** What excluding a website did: `invalid` for text that is no host name, `full` at
 * `config.exclusionsMax`. One already excluded, built in or by the user, is `added`; `unsaved` as
 * for an app. */
export type ExcludeSiteResult = "added" | "invalid" | "full" | "unsaved";

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
    readonly availableHotkeys: readonly [DictationHotkey, ...DictationHotkey[]] = [defaultHotkey, "function"],
    readonly builtInExcludedApps: readonly ExcludedApp[] = config.builtInExcludedApps,
  ) {
    super();
  }

  get hotkey(): DictationHotkey {
    const stored = storedString(this.store, Key.hotkey);
    return isDictationHotkey(stored) && this.availableHotkeys.includes(stored) ? stored : this.availableHotkeys[0];
  }

  set hotkey(value: DictationHotkey) {
    if (!this.availableHotkeys.includes(value)) return;
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

  /** The user's dictionary, in the order the words were added (ADR-DESK-038): at most
   * `config.dictionaryMaxEntries` words, `config.dictionaryMaxTypedWords` of them typed. */
  get dictionary(): DictionaryEntry[] {
    return storedDictionary(this.store.get(Key.dictionary));
  }

  /** Adds a word the user typed, refused at `config.dictionaryMaxTypedWords` typed words. One already
   * there takes the spelling typed, the user's latest; one learned becomes typed, so it shows as the
   * user's own. A full dictionary drops the learned word used least recently for it. */
  addWord(raw: string): AddWordResult {
    const word = dictionaryWord(raw);
    if (word === null) return "invalid";
    const entries = this.dictionary;
    const use = nextUse(entries);
    const existing = entries.find((entry) => isSameWord(entry.word, word));
    const typedFull = entries.filter((entry) => !entry.learned).length >= config.dictionaryMaxTypedWords;
    if (existing) {
      if (existing.learned && typedFull) return "full";
      Object.assign(existing, { word, learned: false, lastUsed: use });
    } else {
      if (typedFull || !this.makeRoom(entries, use)) return "full";
      entries.push({ word, learned: false, lastUsed: use });
    }
    this.writeDictionary(entries);
    return "added";
  }

  /** Adds words learned from the user's corrections, those not already there; a full dictionary drops
   * the learned word used least recently for each, never one learned in the same call. One already
   * there counts as used, marked before any is added so that no new word drops it, wherever it comes
   * in `words`. Returns those added. */
  learnWords(words: readonly string[]): string[] {
    const entries = this.dictionary;
    const use = nextUse(entries);
    const fresh: string[] = [];
    let changed = false;
    for (const raw of words) {
      const word = dictionaryWord(raw);
      if (word === null) continue;
      const existing = entries.find((entry) => isSameWord(entry.word, word));
      if (!existing) fresh.push(word);
      else if (existing.lastUsed !== use) {
        existing.lastUsed = use;
        changed = true;
      }
    }
    const added: string[] = [];
    for (const word of fresh) {
      if (entries.some((entry) => isSameWord(entry.word, word)) || !this.makeRoom(entries, use)) continue;
      entries.push({ word, learned: true, lastUsed: use });
      added.push(word);
    }
    if (changed || added.length > 0) this.writeDictionary(entries);
    return added;
  }

  /** Marks the dictionary's words found in a dictation's `texts` (the transcript, and the text pasted)
   * as used now, whatever their case, so a full dictionary keeps them over the learned words not used
   * since. A word inside a longer one counts ("TabMail" in "TabMail's"): the scripts without spaces
   * between words have no edge to look for. */
  useWords(texts: readonly string[]): void {
    const entries = this.dictionary;
    const said = texts.join("\n").toLowerCase();
    const use = nextUse(entries);
    let changed = false;
    for (const entry of entries) {
      if (!said.includes(entry.word.toLowerCase())) continue;
      entry.lastUsed = use;
      changed = true;
    }
    if (changed) this.writeDictionary(entries);
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

  /** Smart dictation: the AI cleanup of each dictation, which adds a second or more. Off unless the
   * user switches it on (owner, 2026-10-05). */
  get smartDictation(): boolean {
    return storedBool(this.store, Key.smartDictation) ?? false;
  }

  set smartDictation(value: boolean) {
    this.write(Key.smartDictation, value);
  }

  /** The apps the user excludes from screen reading, in the order they were added; the built-in ones
   * (`config.builtInExcludedApps`) are not among them. */
  get excludedApps(): ExcludedApp[] {
    return storedExcludedApps(this.store.get(Key.excludedApps), this.builtInExcludedApps);
  }

  /** Excludes an app from screen reading. */
  excludeApp(value: unknown): ExcludeAppResult {
    const app = excludedApp(value);
    if (app === null) return "invalid";
    const apps = this.excludedApps;
    if (isBuiltInExcludedApp(app.bundleIdentifier, this.builtInExcludedApps) || apps.some((other) => isSameApp(other.bundleIdentifier, app.bundleIdentifier))) return "added";
    if (apps.length >= config.exclusionsMax) return "full";
    return this.saveExclusions(Key.excludedApps, [...apps, app]) ? "added" : "unsaved";
  }

  /** Lets the screen be read in an app the user excluded again. A built-in one stays excluded.
   * False when the list could not be written to disk: the app is still excluded. */
  removeExcludedApp(bundleIdentifier: string): boolean {
    const apps = this.excludedApps;
    const kept = apps.filter((app) => !isSameApp(app.bundleIdentifier, bundleIdentifier));
    return kept.length === apps.length || this.saveExclusions(Key.excludedApps, kept);
  }

  /** Writes a list of exclusions and tells of the change. When the file could not be written the
   * list is put back as it was and false is returned: what is excluded is what is saved, so nothing
   * is excluded only until the app quits (owner, 2026-10-01). */
  private saveExclusions(key: string, list: unknown[]): boolean {
    const before = this.store.get(key);
    if (this.store.set(key, list)) {
      this.changed();
      return true;
    }
    if (before === undefined) this.store.remove(key);
    else this.store.set(key, before);
    return false;
  }

  /** The websites the user excludes from screen reading, by host, in the order they were added; the
   * built-in ones (`config.builtInExcludedSites`) are not among them. */
  get excludedSites(): string[] {
    return storedExcludedSites(this.store.get(Key.excludedSites));
  }

  /** Excludes a website from screen reading: `value` is its host, or its address. */
  excludeSite(value: unknown): ExcludeSiteResult {
    const site = excludedSite(value);
    if (site === null) return "invalid";
    const sites = this.excludedSites;
    if (isBuiltInExcludedSite(site) || sites.includes(site)) return "added";
    if (sites.length >= config.exclusionsMax) return "full";
    return this.saveExclusions(Key.excludedSites, [...sites, site]) ? "added" : "unsaved";
  }

  /** Lets the screen be read on a website the user excluded again. A built-in one stays excluded.
   * False as for an app. */
  removeExcludedSite(host: string): boolean {
    const sites = this.excludedSites;
    const kept = sites.filter((site) => site !== host.toLowerCase());
    return kept.length === sites.length || this.saveExclusions(Key.excludedSites, kept);
  }

  /** Agent mode's tools the user switched off, stored by name so a tool added later starts on. */
  private get disabledAgentTools(): AgentToolID[] {
    const stored = this.store.get(Key.disabledAgentTools);
    return Array.isArray(stored) ? stored.filter(isAgentToolID) : [];
  }

  /** Whether agent mode may use `tool`. Every tool is on unless switched off (owner, 2026-09-26). */
  isEnabled(tool: AgentToolID): boolean {
    return !this.disabledAgentTools.includes(tool);
  }

  setEnabled(tool: AgentToolID, enabled: boolean): void {
    const others = this.disabledAgentTools.filter((disabled) => disabled !== tool);
    this.store.set(Key.disabledAgentTools, (enabled ? others : [...others, tool]).sort());
    this.changed();
  }

  /** Agent mode's offered tools the user has on, in the registry's order. */
  get enabledTools(): AgentToolID[] {
    return offeredAgentToolIDs.filter((tool) => this.isEnabled(tool));
  }

  /** The apps the Answer tool reaches that the user switched off, stored by name so one added later
   * starts on. */
  private get disabledConnectors(): ConnectorID[] {
    const stored = this.store.get(Key.disabledConnectors);
    return Array.isArray(stored) ? stored.filter(isConnectorID) : [];
  }

  /** Whether the Answer tool may reach `connector`'s app. Every one is on unless switched off (owner,
   * 2026-09-26). */
  isConnectorEnabled(connector: ConnectorID): boolean {
    return !this.disabledConnectors.includes(connector);
  }

  setConnectorEnabled(connector: ConnectorID, enabled: boolean): void {
    const others = this.disabledConnectors.filter((disabled) => disabled !== connector);
    this.store.set(Key.disabledConnectors, (enabled ? others : [...others, connector]).sort());
    this.changed();
  }

  /** The apps the Answer tool reaches that the user has on, in the registry's order. */
  get enabledConnectors(): ConnectorID[] {
    return connectorIDs.filter((connector) => this.isConnectorEnabled(connector));
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
      excludedApps: [...this.builtInExcludedApps, ...this.excludedApps].map((app) => app.bundleIdentifier),
      excludedSites: [...config.builtInExcludedSites, ...this.excludedSites],
      enabledTools: this.enabledTools,
      enabledConnectors: this.enabledConnectors,
      emailClient: this.emailClient,
      hasTabMail: this.hasTabMail(),
      userName: this.sentUserName,
      dictionary: this.dictionary.map((entry) => entry.word),
      learnsWords: this.learnsWords,
      smartDictation: this.smartDictation,
    };
  }

  /** Makes room in `entries` for one more word: true when there was room, or after dropping the learned
   * word used least recently before `use`; false when there is none to drop. */
  private makeRoom(entries: DictionaryEntry[], use: number): boolean {
    if (entries.length < config.dictionaryMaxEntries) return true;
    const dropped = leastRecentlyUsedLearned(entries, use);
    if (dropped === -1) return false;
    const [entry] = entries.splice(dropped, 1);
    log.content("AppSettings: dictionary full; dropped the learned word used least recently", entry?.word ?? "");
    return true;
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
