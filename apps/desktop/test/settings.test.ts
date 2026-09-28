// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { DebugAccess } from "../src/core/account.js";
import { agentTools } from "../src/core/agent/tools.js";
import { connectors } from "../src/core/agent/connectors.js";
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
    app.setEnabled("answer", false);
    app.setConnectorEnabled("calendar", false);

    expect(snapshot).toEqual({
      hasConsented: true,
      hotkey: "rightOption",
      backendURL: config.productionBackendURL,
      readsScreen: true,
      enabledTools: [...agentTools],
      enabledConnectors: [...connectors],
      emailClient: null,
      hasTabMail: true,
    });
  });
});

/** The apps the Answer tool reaches, each switched on and off in Settings and the welcome wizard. */
describe("connectors", () => {
  /** Every app is on until the user turns it off. */
  test("every app is on by default", () => {
    const app = settings();

    for (const connector of connectors) expect(app.isConnectorEnabled(connector)).toBe(true);
    expect(app.dictation(null).enabledConnectors).toEqual(connectors);
  });

  /** An app turned off is left out of every dictation from then on, and stays off after a relaunch;
   * turned back on, it is reached again. */
  test.each(connectors)("%s turned off stays off", (connector) => {
    const store = new MemoryStore();
    const changes: number[] = [];
    const app = settings(store);
    app.observe(() => changes.push(changes.length));
    app.setConnectorEnabled(connector, false);
    expect(changes).toHaveLength(1);

    const relaunched = settings(store);
    expect(relaunched.isConnectorEnabled(connector)).toBe(false);
    expect(relaunched.dictation(null).enabledConnectors).toEqual(connectors.filter((other) => other !== connector));

    relaunched.setConnectorEnabled(connector, true);
    expect(settings(store).dictation(null).enabledConnectors).toEqual(connectors);
  });

  /** Turning off two apps keeps both off; turning one off twice lists it once. */
  test("apps turned off add up", () => {
    const store = new MemoryStore();
    const app = settings(store);
    app.setConnectorEnabled("reminders", false);
    app.setConnectorEnabled("calendar", false);
    app.setConnectorEnabled("calendar", false);

    expect(store.get("disabledConnectors")).toEqual(["calendar", "reminders"]);
    expect(app.enabledConnectors).toEqual([]);
  });

  /** A stored name no longer an app, or a stored value of another type, is ignored rather than
   * turning anything off; a switch changed after that stores only apps. */
  test.each<[unknown, string[]]>([
    [["calendar", "retired-app"], ["reminders"]],
    ["calendar", ["calendar", "reminders"]],
    [[7, null], ["calendar", "reminders"]],
  ])("a stored %j turns off only known apps", (stored, enabled) => {
    const store = new MemoryStore({ disabledConnectors: stored });
    expect(settings(store).dictation(null).enabledConnectors).toEqual(enabled);

    settings(store).setConnectorEnabled("reminders", true);
    expect(store.get("disabledConnectors")).toEqual(connectors.filter((connector) => !enabled.includes(connector)));
  });
});

/** The agent tools the user switches on and off in Settings and the welcome wizard. */
describe("agent tools", () => {
  /** Every tool is on until the user turns it off. */
  test("every tool is on by default", () => {
    const app = settings();

    for (const tool of agentTools) expect(app.isEnabled(tool)).toBe(true);
    expect(app.dictation(null).enabledTools).toEqual(agentTools);
  });

  /** A tool turned off is left out of every dictation from then on, and stays off after a relaunch;
   * turned back on, it is offered again. */
  test.each(agentTools)("%s turned off stays off", (tool) => {
    const store = new MemoryStore();
    const changes: number[] = [];
    const app = settings(store);
    app.observe(() => changes.push(changes.length));
    app.setEnabled(tool, false);
    expect(changes).toHaveLength(1);

    const relaunched = settings(store);
    expect(relaunched.isEnabled(tool)).toBe(false);
    expect(relaunched.dictation(null).enabledTools).toEqual(agentTools.filter((other) => other !== tool));

    relaunched.setEnabled(tool, true);
    expect(settings(store).dictation(null).enabledTools).toEqual(agentTools);
  });

  /** Turning off two tools keeps both off; turning one off twice lists it once. */
  test("tools turned off add up", () => {
    const store = new MemoryStore();
    const app = settings(store);
    app.setEnabled("thunderbird", false);
    app.setEnabled("answer", false);
    app.setEnabled("answer", false);

    expect(store.get("disabledAgentTools")).toEqual(["answer", "thunderbird"]);
    expect(app.enabledTools).toEqual(["edit", "compose"]);
  });

  /** A stored name no longer an agent tool, or a stored value of another type, is ignored rather
   * than turning anything off. */
  test.each<[unknown, string[]]>([
    [["answer", "retired-tool"], ["edit", "compose", "thunderbird"]],
    ["answer", ["edit", "compose", "thunderbird", "answer"]],
    [[7, null], ["edit", "compose", "thunderbird", "answer"]],
  ])("a stored %j turns off only known tools", (stored, enabled) => {
    expect(settings(new MemoryStore({ disabledAgentTools: stored })).dictation(null).enabledTools).toEqual(enabled);
  });

  /** A switch changed after that stores only tools: a name no longer a tool is dropped. */
  test("a switch changed stores only tools", () => {
    const store = new MemoryStore({ disabledAgentTools: ["answer", "retired-tool", 7] });
    settings(store).setEnabled("edit", false);

    expect(store.get("disabledAgentTools")).toEqual(["answer", "edit"]);
  });
});
