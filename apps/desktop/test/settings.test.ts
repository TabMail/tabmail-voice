// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { DebugAccess } from "../src/core/account.js";
import * as config from "../src/core/config.js";
import { MemoryStore } from "../src/core/keyValueStore.js";
import { AppSettings } from "../src/core/settings.js";

function settings(store = new MemoryStore(), hasTabMail = false): AppSettings {
  return new AppSettings(store, () => hasTabMail);
}

describe("debug mode", () => {
  /** Accounts on the TabMail domain, in any case, are allowed; lookalike domains, subdomains,
   * other domains and no account are not. */
  test.each([
    ["tester@tabmail.ai", true],
    ["Tester@TabMail.AI", true],
    ["tester@nottabmail.ai", false],
    ["tester@mail.tabmail.ai", false],
    ["tester@tabmail.ai.example.com", false],
    ["tester@example.com", false],
    ["tabmail.ai", false],
    ["", false],
  ])("%s may use debug mode: %s", (email, allowed) => {
    expect(DebugAccess.allows(email)).toBe(allowed);
  });

  /** The named account outside the domain (TabMail's own, as on iOS) is allowed, in any case, and
   * gets the development server; another account on its mail domain is not. */
  test("the named account may use debug mode", () => {
    const app = settings();
    app.debugMode = true;

    for (const email of ["tabmail.ai@gmail.com", "TABMAIL.AI@GMAIL.COM"]) {
      expect(DebugAccess.allows(email)).toBe(true);
      expect(app.dictation(email).backendURL).toBe(config.developmentBackendURL);
    }
    expect(DebugAccess.allows("someone@gmail.com")).toBe(false);
    expect(app.dictation("someone@gmail.com").backendURL).toBe(config.productionBackendURL);
  });

  test("no account may use debug mode", () => {
    expect(DebugAccess.allows(null)).toBe(false);
  });

  /** Debug mode, and with it the development server, is on only when the switch is on AND the
   * account signed in is allowed: a switch left on does nothing for another account or signed out. */
  test.each([
    [true, "tester@tabmail.ai", true],
    [false, "tester@tabmail.ai", false],
    [true, "tester@example.com", false],
    [true, null, false],
  ])("switch %s, account %s: debug mode %s", (switchOn, email, isOn) => {
    const app = settings();
    app.debugMode = switchOn;

    expect(app.isDebugMode(email)).toBe(isOn);
    expect(app.dictation(email).backendURL).toBe(isOn ? config.developmentBackendURL : config.productionBackendURL);
  });

  /** The switch is kept across launches, on and then off again, and starts off. */
  test("the switch is stored and starts off", () => {
    const store = new MemoryStore();
    expect(settings(store).debugMode).toBe(false);

    settings(store).debugMode = true;
    expect(settings(store).isDebugMode("tester@tabmail.ai")).toBe(true);

    settings(store).debugMode = false;
    const relaunched = settings(store);
    expect(relaunched.isDebugMode("tester@tabmail.ai")).toBe(false);
    expect(relaunched.dictation("tester@tabmail.ai").backendURL).toBe(config.productionBackendURL);
  });
});

describe("AppSettings", () => {
  test("defaults: right Option, screen reading on, no consent, wizard not finished, default email app", () => {
    const app = settings();
    expect(app.hotkey).toBe("rightOption");
    expect(app.readsScreen).toBe(true);
    expect(app.hasConsented).toBe(false);
    expect(app.hasFinishedWelcome).toBe(false);
    expect(app.emailClient).toBeNull();
  });

  /** Every setting survives a relaunch; the email app choice is forgotten when set back to the
   * default. */
  test("every setting is persisted", () => {
    const store = new MemoryStore();
    const app = settings(store);
    app.hotkey = "function";
    app.readsScreen = false;
    app.hasConsented = true;
    app.hasFinishedWelcome = true;
    app.emailClient = "org.mozilla.thunderbirdbeta";

    const relaunched = settings(store);
    expect([relaunched.hotkey, relaunched.readsScreen, relaunched.hasConsented, relaunched.hasFinishedWelcome, relaunched.emailClient])
      .toEqual(["function", false, true, true, "org.mozilla.thunderbirdbeta"]);

    app.emailClient = null;
    expect(settings(store).emailClient).toBeNull();
  });

  /** A stored value of the wrong type, or an unknown hotkey, reads as the default. */
  test("an unreadable stored value reads as its default", () => {
    const app = settings(new MemoryStore({ dictationHotkey: "capsLock", readsScreen: "yes", hasConsentedToDictationData: 1, emailClient: 7 }));
    expect([app.hotkey, app.readsScreen, app.hasConsented, app.emailClient]).toEqual(["rightOption", true, false, null]);
  });

  test("a hotkey change is announced", () => {
    const app = settings();
    const heard: string[] = [];
    app.onHotkeyChange = (hotkey) => heard.push(hotkey);
    let changes = 0;
    app.observe(() => {
      changes += 1;
    });

    app.hotkey = "function";

    expect(heard).toEqual(["function"]);
    expect(changes).toBe(1);
  });

  /** A dictation's settings are one snapshot: changing a setting afterwards leaves it as it was. */
  test("a dictation's settings are a snapshot", () => {
    const app = settings(new MemoryStore({ hasConsentedToDictationData: true }), true);
    const snapshot = app.dictation("person@example.com");

    app.readsScreen = false;
    app.hotkey = "function";
    app.emailClient = "org.mozilla.thunderbirdbeta";

    expect(snapshot).toEqual({
      hasConsented: true,
      hotkey: "rightOption",
      backendURL: config.productionBackendURL,
      readsScreen: true,
      emailClient: null,
      hasTabMail: true,
    });
  });
});
