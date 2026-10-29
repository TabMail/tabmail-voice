// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as config from "../../src/core/config.js";
import { channels, isAudioReport, isCommand, isWindowName } from "../../src/shared/ipc.js";

const compositionSections = ["general", "language", "links"];
const shown = (text: string) => ({ text, labels: [["0000000100000001", 1]] });

/** The channel names the preload script writes out, read from its source: a sandboxed preload
 * can't import them. */
function preloadChannels(): Record<string, string> {
  const source = readFileSync(join(__dirname, "../../src/preload/index.ts"), "utf8");
  const literal = /const channels = \{([^}]*)\};/.exec(source)?.[1];
  if (literal === undefined) throw new Error("no channels in preload/index.ts");
  return Object.fromEntries([...literal.matchAll(/(\w+): "([^"]+)"/g)].map((match) => [match[1], match[2]]));
}

describe("IPC", () => {
  test("the preload script uses the same channels as the main process", () => {
    expect(preloadChannels()).toEqual(channels);
  });

  test("well-formed commands are accepted", () => {
    for (const command of [
      { type: "sendCode", email: "user@example.com" },
      { type: "verify", email: "user@example.com", code: "123456" },
      { type: "signOut" },
      { type: "setHotkey", hotkey: "function" },
      { type: "setReadsScreen", value: false },
      { type: "setSmartDictation", value: true },
      { type: "setOptsOutOfAI", value: true },
      { type: "setUserName", value: "Alex Example" },
      { type: "setUserName", value: "" },
      { type: "setUserName", value: "x".repeat(config.userNameMaxLength) },
      { type: "addDictionaryWord", word: "Xyvora" },
      { type: "addDictionaryWord", word: "x".repeat(config.dictionaryWordMaxChars) },
      { type: "removeDictionaryWord", word: "Xyvora" },
      { type: "setLearnsWords", value: false },
      { type: "excludeApp" },
      { type: "removeExcludedApp", bundleIdentifier: "org.example.vault" },
      { type: "removeExcludedApp", bundleIdentifier: "x".repeat(config.bundleIdentifierMaxLength) },
      { type: "excludeSite", site: "https://example.com/inbox" },
      { type: "excludeSite", site: "x".repeat(config.excludedSiteInputMaxLength) },
      { type: "removeExcludedSite", host: "example.com" },
      { type: "removeExcludedSite", host: "x".repeat(config.hostMaxLength) },
      { type: "setEmailClient", bundleIdentifier: null },
      { type: "setEmailClient", bundleIdentifier: "org.mozilla.thunderbird" },
      { type: "setOpenAtLogin", value: true },
      { type: "setDebugMode", value: true },
      { type: "setConsent", value: true },
      { type: "requestMicrophone" },
      { type: "requestAccessibility" },
      { type: "checkForUpdates" },
      { type: "installUpdate" },
      { type: "welcomeNext" },
      { type: "welcomeBack" },
      { type: "welcomeGoTo", index: 0 },
      { type: "fixVSCodeSettings" },
      { type: "openURL", url: "https://example.com" },
      { type: "answerConfirmation", confirmed: true },
      { type: "setConnectorEnabled", connector: "reminders", value: false },
      { type: "answerConfirmation", confirmed: false },
      { type: "pointerOver", over: true },
      { type: "overlayDrawn", reveal: 0 },
      { type: "overlayDrawn", reveal: 12 },
      { type: "pointerOver", over: false },
      { type: "copyHistoryEntry", id: 3 },
      { type: "closeHistory" },
      { type: "historyHeight", height: 120 },
      { type: "loadMemory" },
      { type: "clearMemory" },
      { type: "searchMemory", query: "" },
      { type: "searchMemory", query: "x".repeat(config.memorySearchMaxLength) },
      ...compositionSections.map((section) => ({ type: "editWritingStyle", section, shown: [], bullets: ["Short sentences."] })),
      { type: "editKnowledgeBase", shown: [shown("a")], bullets: [] },
      { type: "editKnowledgeBase", shown: [{ text: "a", labels: [["default:kb-1", 1], ["0000000100000001", 2]] }, { text: "b", labels: [] }], bullets: [] },
      // A bullet longer than the Settings fields take, as kb_add can store, still lets
      // the knowledge base be edited.
      { type: "editKnowledgeBase", shown: [shown("x".repeat(config.personalizationBulletMaxLength + 1)), shown("a")], bullets: ["a"] },
      { type: "resetWritingStyle" },
      { type: "resetKnowledgeBase" },
      { type: "restorePromptHistory", id: "x".repeat(config.promptHistoryIDMaxLength) },
      ...config.memorySizeLimitChoices.map((value) => ({ type: "setMemorySizeLimit", value })),
      ...config.eventDurationChoices.map((value) => ({ type: "setEventDuration", value })),
      { type: "setEventDuration", value: config.eventDurationMin },
      { type: "setEventDuration", value: config.eventDurationMax },
      { type: "removeMemory", memId: "turn:example" },
      { type: "removeMemory", memId: "x".repeat(config.memoryIDMaxLength) },
      { type: "removeOldMemory", days: 1 },
      { type: "removeOldMemory", days: config.memoryRemoveOldDaysMax },
    ]) {
      expect(isCommand(command), command.type).toBe(true);
    }
  });

  /** A window is untrusted input: anything malformed is refused before the main process acts. */
  test.each<unknown>([
    null,
    "signOut",
    {},
    { type: "unknown" },
    { type: "sendCode" },
    { type: "verify", email: "user@example.com" },
    { type: "setHotkey", hotkey: "leftShift" },
    { type: "setReadsScreen", value: "yes" },
    { type: "setSmartDictation", value: "yes" },
    { type: "setOptsOutOfAI", value: "yes" },
    { type: "setUserName" },
    { type: "setUserName", value: null },
    { type: "setUserName", value: "x".repeat(config.userNameMaxLength + 1) },
    { type: "addDictionaryWord" },
    { type: "addDictionaryWord", word: 1 },
    { type: "addDictionaryWord", word: "x".repeat(config.dictionaryWordMaxChars + 1) },
    { type: "removeDictionaryWord", word: null },
    { type: "removeDictionaryWord", word: "x".repeat(config.dictionaryWordMaxChars + 1) },
    { type: "setLearnsWords", value: "no" },
    { type: "removeExcludedApp" },
    { type: "removeExcludedApp", bundleIdentifier: 1 },
    { type: "removeExcludedApp", bundleIdentifier: "x".repeat(config.bundleIdentifierMaxLength + 1) },
    { type: "excludeSite" },
    { type: "excludeSite", site: 1 },
    { type: "excludeSite", site: "x".repeat(config.excludedSiteInputMaxLength + 1) },
    { type: "removeExcludedSite" },
    { type: "removeExcludedSite", host: 1 },
    { type: "removeExcludedSite", host: "x".repeat(config.hostMaxLength + 1) },
    { type: "setEmailClient" },
    { type: "setEmailClient", bundleIdentifier: 1 },
    { type: "welcomeGoTo", index: 1.5 },
    { type: "openURL", url: 1 },
    { type: "chatHeight", height: -1 },
    { type: "chatHeight", height: Number.POSITIVE_INFINITY },
    { type: "chatHeight", height: Number.NaN },
    { type: "overlayDrawn" },
    { type: "overlayDrawn", reveal: -1 },
    { type: "overlayDrawn", reveal: 1.5 },
    { type: "overlayDrawn", reveal: Number.NaN },
    { type: "overlayDrawn", reveal: "3" },
    { type: "setConnectorEnabled", connector: "retired-app", value: true },
    { type: "setConnectorEnabled", connector: "calendar", value: "no" },
    { type: "answerConfirmation" },
    { type: "answerConfirmation", confirmed: "yes" },
    { type: "pointerOver" },
    { type: "pointerOver", over: 1 },
    { type: "copyHistoryEntry" },
    { type: "copyHistoryEntry", id: 1.5 },
    { type: "historyHeight", height: 0 },
    { type: "historyHeight", height: Number.NaN },
    { type: "searchMemory" },
    { type: "searchMemory", query: 1 },
    { type: "searchMemory", query: "x".repeat(config.memorySearchMaxLength + 1) },
    { type: "editWritingStyle", section: "# Not a section", shown: [], bullets: [] },
    { type: "editWritingStyle", section: "General writing style", shown: [], bullets: [] },
    { type: "editWritingStyle", section: "", shown: [], bullets: [] },
    { type: "editKnowledgeBase", shown: ["a"], bullets: [] },
    { type: "editKnowledgeBase", shown: [{ text: "a" }], bullets: [] },
    { type: "editKnowledgeBase", shown: [{ text: 1, labels: [] }], bullets: [] },
    { type: "editKnowledgeBase", shown: [{ text: "a", labels: [["NAME", 1]] }], bullets: [] },
    { type: "editKnowledgeBase", shown: [{ text: "a", labels: [["0000000100000001", 0]] }], bullets: [] },
    { type: "editKnowledgeBase", shown: [{ text: "a", labels: [["0000000100000001", 1.5]] }], bullets: [] },
    { type: "editKnowledgeBase", shown: [{ text: "a", labels: [["0000000100000001"]] }], bullets: [] },
    { type: "editKnowledgeBase", shown: [null], bullets: [] },
    { type: "editWritingStyle", section: compositionSections[0], shown: [], bullets: "Short sentences." },
    { type: "editWritingStyle", shown: [], bullets: [] },
    { type: "editKnowledgeBase", bullets: [] },
    { type: "editKnowledgeBase", shown: [], bullets: [1] },
    { type: "restorePromptHistory" },
    { type: "restorePromptHistory", id: 1 },
    { type: "restorePromptHistory", id: "x".repeat(config.promptHistoryIDMaxLength + 1) },
    { type: "setMemorySizeLimit" },
    { type: "setMemorySizeLimit", value: "1073741824" },
    { type: "setMemorySizeLimit", value: (config.memorySizeLimitChoices[0] ?? 0) + 1 },
    { type: "setMemorySizeLimit", value: 0 },
    { type: "setEventDuration" },
    { type: "setEventDuration", value: "45" },
    { type: "setEventDuration", value: config.eventDurationMin - 1 },
    { type: "setEventDuration", value: config.eventDurationMax + 1 },
    { type: "setEventDuration", value: 30.5 },
    { type: "setEventDuration", value: Number.NaN },
    { type: "removeMemory" },
    { type: "removeMemory", memId: 1 },
    { type: "removeMemory", memId: "x".repeat(config.memoryIDMaxLength + 1) },
    { type: "removeOldMemory" },
    { type: "removeOldMemory", days: "30" },
    { type: "removeOldMemory", days: 0 },
    { type: "removeOldMemory", days: config.memoryRemoveOldDaysMax + 1 },
    { type: "removeOldMemory", days: 1.5 },
    { type: "removeOldMemory", days: Number.NaN },
  ])("a malformed command is refused (%j)", (command) => {
    expect(isCommand(command)).toBe(false);
  });

  test("audio reports are checked", () => {
    expect(isAudioReport({ type: "started", session: 1 })).toBe(true);
    expect(isAudioReport({ type: "failed", session: 1, error: "NotAllowedError" })).toBe(true);
    expect(isAudioReport({ type: "chunk", session: 1, samples: new Float32Array(4) })).toBe(true);
    expect(isAudioReport({ type: "lost", session: 1 })).toBe(false);
    expect(isAudioReport({ type: "chunk", session: 1, samples: [0, 0] })).toBe(false);
    expect(isAudioReport({ type: "started" })).toBe(false);
    expect(isAudioReport({ type: "failed", session: 1 })).toBe(false);
    expect(isAudioReport({ type: "stopped", session: 1 })).toBe(false);
    expect(isAudioReport(null)).toBe(false);
  });

  test("window names are checked", () => {
    expect(["overlay", "settings", "welcome", "contextDebug", "history"].every(isWindowName)).toBe(true);
    expect(isWindowName("audio")).toBe(false);
    expect(isWindowName(undefined)).toBe(false);
  });
});
