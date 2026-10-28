// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { DebugAccess } from "./backend/account.js";
import { type ConnectorID, connectorIDs, isConnectorID } from "./agent/connectors/index.js";
import { isEventDuration } from "./agent/connectors/settings.js";
import { type AgentToolID, isAgentToolID, switchableAgentToolIDs } from "./agent/tools.js";
import * as config from "./config.js";
import { type ExcludedApp, excludedApp, isBuiltInExcludedApp, isSameApp, storedExcludedApps } from "./dictation/excludedApps.js";
import { excludedSite, isBuiltInExcludedSite, storedExcludedSites } from "./dictation/excludedSites.js";
import { type DictionaryEntry, type DictionaryWords, dictionaryWord, dictionaryWords, isSameWord, leastRecentlyUsedLearned, nextUse, storedDictionary } from "./dictionary/entries.js";
import { type DictationHotkey, defaultHotkey, isDictationHotkey } from "./hotkey/bindings.js";
import { log } from "./log.js";
import { aiOffLine } from "./ui/fileProblems.js";
import { type KeyValueStore, type StoreProblem, storedBool, storedInteger, storedString } from "./util/keyValueStore.js";
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
  memorySizeLimit: "memorySizeLimit",
  eventDuration: "eventDurationMinutes",
  closesChatElsewhere: "closesChatElsewhere",
  optsOutOfAI: "optsOutOfAI",
  deviceSync: "deviceSync",
} as const;

/** Why a dictation is refused while the user opted out of AI (`AppSettings.optsOutOfAI`). */
export const optedOutOfAILine = "AI features are off. To dictate, turn off Opt Out of AI in Settings";

/** Why Settings › Memory refuses a search or a size limit while the user opted out of AI (owner,
 * 2026-10-28). */
export const optedOutOfAIMemoryLine = "AI features are off. Turn off Opt Out of AI in Settings to use memory";

/** The settings one dictation uses, read as the first thing it does when it starts and fixed for
 * the rest of it: a change in Settings meanwhile applies from the next dictation (owner,
 * 2026-09-26). */
export interface DictationSettings {
  /** Why AI features are off (`AppSettings.aiOffLine`), and no dictation starts; null while they're
   * on. */
  aiOffLine: string | null;
  hasConsented: boolean;
  /** The key held to dictate, which the double-tap tip names. */
  hotkey: DictationHotkey;
  backendURL: string;
  /** Whether debug mode was on (`isDebugMode`): the dictation's audio is kept for Play Last Recording
   * only then (ADR-DESK-018). */
  keepsRecording: boolean;
  readsScreen: boolean;
  /** The bundle identifiers of the apps the screen is never read in: the built-in password managers
   * and those the user excludes (`ExcludedApp`). */
  excludedApps: string[];
  /** The hosts of the websites the screen is never read on: the built-in web vaults and those the
   * user excludes. A host covers its subdomains. */
  excludedSites: string[];
  /** Agent mode's switchable tools the user has on; Answer, always on, is not among them. */
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
  /** The user's dictionary words (ADR-DESK-038), typed and learned, each most recently used first: all
   * of them for the cleanup, the most important for the speech model (`dictationVocabulary`). */
  dictionary: DictionaryWords;
  /** Whether the dictation's paste is watched to learn the user's corrections. */
  learnsWords: boolean;
  /** Whether the dictation asks for the backend's cleanup (and a long dictation for its final polish);
   * off, the transcript is pasted as heard. */
  smartDictation: boolean;
  /** The most memory may take (bytes; `AppSettings.memorySizeLimit`): the request is kept within it.
   * Null while the user's limit is unknown, so the request isn't kept, as keeping it within the
   * default would remove what a larger limit kept (ADR-DESK-063). */
  memorySizeLimit: number | null;
  /** How long a new event lasts when the user gave no end (minutes; `eventDuration`). */
  eventDuration: number;
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
    private offered: readonly [DictationHotkey, ...DictationHotkey[]] = [defaultHotkey, "function"],
    readonly builtInExcludedApps: readonly ExcludedApp[] = config.builtInExcludedApps,
  ) {
    super();
  }

  /** Why the settings file couldn't be read at launch, until it is fixed or the user resets it: nothing
   * is saved to it meanwhile. */
  get fileProblem(): StoreProblem | undefined {
    return this.store.problem;
  }

  /** The user's factory reset of the settings file (`moveAside`, which throws, changing nothing, when
   * the file can't be moved): every setting reads its default from here on, but for the values in
   * `kept`, and memory's size limit, which is unknown, "Not set" (`unsetMemorySizeLimit`). Both are
   * in one write: the new file has the limit not set, or there is no file, which the next launch
   * reads as removed by hand. */
  resetFile(moveAside: () => void, kept: Readonly<Record<string, unknown>> = {}): void {
    const before = this.hotkey;
    moveAside();
    this.store.setAll({ ...kept, [Key.memorySizeLimit]: null });
    this.changed();
    if (this.hotkey !== before) this.onHotkeyChange?.(this.hotkey);
  }

  /** The keys Settings offers; the first is the default. */
  get availableHotkeys(): readonly [DictationHotkey, ...DictationHotkey[]] {
    return this.offered;
  }

  /** Offers other keys, as when GNOME integration turns out not to support this GNOME. The stored
   * choice is kept: if it isn't offered now, the first key is used until it is offered again. */
  offerHotkeys(keys: readonly [DictationHotkey, ...DictationHotkey[]]): void {
    if (keys.length === this.offered.length && keys.every((key, index) => key === this.offered[index])) return;
    const before = this.hotkey;
    this.offered = keys;
    this.changed();
    if (this.hotkey !== before) this.onHotkeyChange?.(this.hotkey);
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

  /** The welcome wizard was finished; until then it opens at every launch, unless this file can't be
   * read (then the file's fix dialog shows instead). */
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

  /** Close the chat window on a click elsewhere or a switch to another app, while it is idle
   * (ADR-DESK-022). On unless the user switches it off (owner, 2026-10-25). */
  get closesChatElsewhere(): boolean {
    return storedBool(this.store, Key.closesChatElsewhere) ?? true;
  }

  set closesChatElsewhere(value: boolean) {
    this.write(Key.closesChatElsewhere, value);
  }

  /** Opt Out of AI (owner, 2026-10-28; Thunderbird's and iOS's `privacy_opt_out_all_ai`): while on,
   * nothing of the user's goes to the backend or a model. No dictation or agent hold starts, so nothing
   * is recorded, transcribed, cleaned up, read from the screen, a field or another app, or learned,
   * and Settings › Memory neither searches nor sets the size limit. Signing in, updates and Settings
   * work as ever, and memory can still be listed and deleted. Kept on this
   * computer only. Off unless the user switches it on. */
  get optsOutOfAI(): boolean {
    return storedBool(this.store, Key.optsOutOfAI) ?? false;
  }

  /** Keeps the user's choice; false, the choice as it was, when it couldn't be saved: what applies is
   * what is saved, and the switch shows it (owner, 2026-10-28). */
  setOptsOutOfAI(value: boolean): boolean {
    return this.saveOrPutBack(Key.optsOutOfAI, value);
  }

  /** Device Sync of the writing style and the knowledge base with the user's other devices (root
   * ADR-021). On unless the user switches it off. Opt Out of AI leaves it as it is: it sends nothing to
   * a model, and Opt Out of AI itself is never synced. */
  get syncsDevices(): boolean {
    return storedBool(this.store, Key.deviceSync) ?? true;
  }

  /** Keeps the user's choice; false, the choice as it was, when it couldn't be saved. */
  setSyncsDevices(value: boolean): boolean {
    return this.saveOrPutBack(Key.deviceSync, value);
  }

  /** Whether Device Sync may run: the file read (its switch is in it), the user's consent given, and
   * the switch on. */
  get deviceSyncAllowed(): boolean {
    return this.store.problem === undefined && this.hasConsented && this.syncsDevices;
  }

  /** Why AI features are off, said when a dictation or an agent hold is refused;
   * null while they're on. A settings file that can't be read comes first (owner, 2026-10-27): whether
   * the user opted out is in it, and fixing it is what they do. */
  get aiOffLine(): string | null {
    if (this.store.problem !== undefined) return aiOffLine;
    return this.optsOutOfAI ? optedOutOfAILine : null;
  }

  /** Why Settings › Memory refuses a search or a size limit, as `aiOffLine`, but naming memory when
   * the user opted out. */
  get memoryOffLine(): string | null {
    if (this.store.problem !== undefined) return aiOffLine;
    return this.optsOutOfAI ? optedOutOfAIMemoryLine : null;
  }

  /** Smart dictation: the AI cleanup of each dictation, which adds a second or more. On unless the
   * user switches it off (owner, 2026-10-29, #313; off by default from 2026-10-05): a choice the user
   * saved, on or off, is kept. Opt Out of AI starts no dictation, so no cleanup runs while it is on. */
  get smartDictation(): boolean {
    return storedBool(this.store, Key.smartDictation) ?? true;
  }

  set smartDictation(value: boolean) {
    this.write(Key.smartDictation, value);
  }

  /** The most memory may take on this computer (bytes): one of `config.memorySizeLimitChoices`,
   * `config.memorySizeLimitDefault` until the user picks another. When memory reaches it, the oldest
   * exchanges are removed first (ADR-DESK-061). Null, "Not set", while the user's limit is unknown:
   * the settings file couldn't be read, or was reset or removed by hand (stored as null; see
   * `unsetMemorySizeLimit`), until the user picks one. */
  get memorySizeLimit(): number | null {
    if (this.store.problem !== undefined || this.store.get(Key.memorySizeLimit) === null) return null;
    const stored = storedInteger(this.store, Key.memorySizeLimit);
    return stored !== null && config.memorySizeLimitChoices.includes(stored) ? stored : config.memorySizeLimitDefault;
  }

  /** The size limit the user chose was in a settings file that is gone (removed by hand; the reset
   * stores the same in its one write): unknown, "Not set", so memory is never trimmed to a guess
   * until the user picks one (owner, 2026-10-28). */
  unsetMemorySizeLimit(): void {
    this.store.set(Key.memorySizeLimit, null);
  }

  /** Stores `value` if Settings offers it; false (nothing stored) otherwise. */
  setMemorySizeLimit(value: number): boolean {
    return config.memorySizeLimitChoices.includes(value) && this.saveOrPutBack(Key.memorySizeLimit, value);
  }

  /** How long an event the user gave no end or duration for lasts (minutes): whole minutes from
   * `config.eventDurationMin` to `config.eventDurationMax`, `config.eventDurationDefault` until the
   * user or the agent picks another. */
  get eventDuration(): number {
    const stored = storedInteger(this.store, Key.eventDuration);
    return stored !== null && isEventDuration(stored) ? stored : config.eventDurationDefault;
  }

  /** Stores `minutes` if it is in range; false (nothing stored) otherwise or when it couldn't be saved. */
  setEventDuration(minutes: number): boolean {
    return isEventDuration(minutes) && this.saveOrPutBack(Key.eventDuration, minutes);
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
    return this.saveOrPutBack(Key.excludedApps, [...apps, app]) ? "added" : "unsaved";
  }

  /** Lets the screen be read in an app the user excluded again. A built-in one stays excluded.
   * False when the list could not be written to disk: the app is still excluded. */
  removeExcludedApp(bundleIdentifier: string): boolean {
    const apps = this.excludedApps;
    const kept = apps.filter((app) => !isSameApp(app.bundleIdentifier, bundleIdentifier));
    return kept.length === apps.length || this.saveOrPutBack(Key.excludedApps, kept);
  }

  /** Writes a setting and tells of the change. When the file could not be written the setting is put
   * back as it was and false is returned: what applies is what is saved, so nothing is excluded only
   * until the app quits (owner, 2026-10-01), and memory isn't trimmed to a limit that a relaunch
   * forgets. */
  private saveOrPutBack(key: string, value: unknown): boolean {
    const before = this.store.get(key);
    if (this.store.set(key, value)) {
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
    return this.saveOrPutBack(Key.excludedSites, [...sites, site]) ? "added" : "unsaved";
  }

  /** Lets the screen be read on a website the user excluded again. A built-in one stays excluded.
   * False as for an app. */
  removeExcludedSite(host: string): boolean {
    const sites = this.excludedSites;
    const kept = sites.filter((site) => site !== host.toLowerCase());
    return kept.length === sites.length || this.saveOrPutBack(Key.excludedSites, kept);
  }

  /** Agent mode's tools the user switched off, stored by name so a tool added later starts on. */
  private get disabledAgentTools(): AgentToolID[] {
    const stored = this.store.get(Key.disabledAgentTools);
    return Array.isArray(stored) ? stored.filter(isAgentToolID) : [];
  }

  /** Whether `tool`'s switch is on. Every switch is on unless switched off (owner, 2026-09-26); Answer,
   * which has none, is offered whatever this says (owner, 2026-10-27). */
  isEnabled(tool: AgentToolID): boolean {
    return !this.disabledAgentTools.includes(tool);
  }

  setEnabled(tool: AgentToolID, enabled: boolean): void {
    const others = this.disabledAgentTools.filter((disabled) => disabled !== tool);
    this.store.set(Key.disabledAgentTools, (enabled ? others : [...others, tool]).sort());
    this.changed();
  }

  /** Agent mode's switchable tools the user has on, in the registry's order. Answer, always on, isn't
   * among them, so an "answer" an earlier version stored switched off is never read (owner,
   * 2026-10-27). */
  get enabledTools(): AgentToolID[] {
    return switchableAgentToolIDs.filter((tool) => this.isEnabled(tool));
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
    // While the file can't be read, the user's own exclusions and switched-off apps, which it holds,
    // are unknown: nothing of theirs is read then, not the screen, not the field pasted into (word
    // learning), not the apps the Answer tool reaches.
    const readable = this.store.problem === undefined;
    return {
      aiOffLine: this.aiOffLine,
      hasConsented: this.hasConsented,
      hotkey: this.hotkey,
      backendURL: this.backendURL(email),
      keepsRecording: this.isDebugMode(email),
      readsScreen: readable && this.readsScreen,
      excludedApps: [...this.builtInExcludedApps, ...this.excludedApps].map((app) => app.bundleIdentifier),
      excludedSites: [...config.builtInExcludedSites, ...this.excludedSites],
      enabledTools: this.enabledTools,
      enabledConnectors: readable ? this.enabledConnectors : [],
      emailClient: this.emailClient,
      hasTabMail: this.hasTabMail(),
      userName: this.sentUserName,
      dictionary: dictionaryWords(this.dictionary),
      learnsWords: readable && this.learnsWords,
      smartDictation: this.smartDictation,
      memorySizeLimit: this.memorySizeLimit,
      eventDuration: this.eventDuration,
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
