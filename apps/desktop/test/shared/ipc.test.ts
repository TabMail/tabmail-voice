// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as config from "../../src/core/config.js";
import { channels, isAudioReport, isCommand, isWindowName } from "../../src/shared/ipc.js";

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
      { type: "chatPointer", over: true },
      { type: "chatPointer", over: false },
      { type: "copyHistoryEntry", id: 3 },
      { type: "closeHistory" },
      { type: "historyHeight", height: 120 },
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
    { type: "setConnectorEnabled", connector: "retired-app", value: true },
    { type: "setConnectorEnabled", connector: "calendar", value: "no" },
    { type: "answerConfirmation" },
    { type: "answerConfirmation", confirmed: "yes" },
    { type: "chatPointer" },
    { type: "chatPointer", over: 1 },
    { type: "copyHistoryEntry" },
    { type: "copyHistoryEntry", id: 1.5 },
    { type: "historyHeight", height: 0 },
    { type: "historyHeight", height: Number.NaN },
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
