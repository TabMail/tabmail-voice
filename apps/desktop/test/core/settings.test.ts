// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DebugAccess } from "../../src/core/backend/account.js";
import { agentToolIDs, offeredAgentToolIDs } from "../../src/core/agent/tools.js";
import { connectorIDs } from "../../src/core/agent/connectors/index.js";
import * as config from "../../src/core/config.js";
import { MemoryStore } from "../../src/core/util/keyValueStore.js";
import { AppSettings } from "../../src/core/settings.js";
import { JSONFileStore } from "../../src/main/storage/jsonFileStore.js";

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

  test("platform hotkeys reject a migrated Mac preference and unsupported changes", () => {
    const store = new MemoryStore({ dictationHotkey: "function" });
    const app = new AppSettings(store, () => false, ["rightControl"]);
    const heard: string[] = [];
    app.onHotkeyChange = (hotkey) => heard.push(hotkey);
    expect(app.hotkey).toBe("rightControl");
    app.hotkey = "rightOption";
    expect(store.get("dictationHotkey")).toBe("function");
    expect(heard).toEqual([]);
    app.hotkey = "rightControl";
    expect(new AppSettings(store, () => false, ["rightControl"]).hotkey).toBe("rightControl");
    expect(heard).toEqual(["rightControl"]);
  });

  test("Windows defaults to right Alt, retains a selected right Control, and excludes Mac Fn", () => {
    const store = new MemoryStore();
    const windows = () => new AppSettings(store, () => false, ["rightAlt", "rightControl"]);
    expect(windows().hotkey).toBe("rightAlt");
    windows().hotkey = "rightControl";
    expect(windows().hotkey).toBe("rightControl");
    windows().hotkey = "rightAlt";
    expect(windows().dictation(null).hotkey).toBe("rightAlt");
    windows().hotkey = "function";
    expect(windows().hotkey).toBe("rightAlt");
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
    app.userName = "Alex Example";
    app.addWord("Xyvora");
    app.learnsWords = false;
    app.excludeApp({ bundleIdentifier: "org.example.bank", name: "Example Bank" });
    app.excludeSite("example.com");

    expect(snapshot).toEqual({
      hasConsented: true,
      hotkey: "rightOption",
      backendURL: config.productionBackendURL,
      readsScreen: true,
      excludedApps: config.builtInExcludedApps.map((excluded) => excluded.bundleIdentifier),
      excludedSites: [...config.builtInExcludedSites],
      enabledTools: [...offeredAgentToolIDs],
      enabledConnectors: [...connectorIDs],
      emailClient: null,
      hasTabMail: true,
      userName: "",
      dictionary: [],
      learnsWords: true,
    });
    expect(app.dictation(null)).toMatchObject({ dictionary: ["Xyvora"], learnsWords: false });
    expect(app.dictation(null).excludedApps).toContain("org.example.bank");
    expect(app.dictation(null).excludedSites).toContain("example.com");
  });
});

/** A store whose file can't be written: values are held, and reported unsaved. */
class UnsavedStore extends MemoryStore {
  override set(key: string, value: unknown): boolean {
    super.set(key, value);
    return false;
  }
}

/** An exclusion is a privacy choice that must last: one held only until the app quits is reported,
 * so Settings can say so. */
describe("an exclusion that could not be saved", () => {
  const bank = { bundleIdentifier: "org.example.bank", name: "Example Bank" };

  test("is reported unsaved, and holds for this run", () => {
    const store = new UnsavedStore();
    const app = settings(store);
    let changes = 0;
    app.observe(() => (changes += 1));

    expect(app.excludeSite("example.org")).toBe("unsaved");
    expect(app.excludeApp(bank)).toBe("unsaved");
    expect(changes).toBe(2);
    expect(app.dictation(null).excludedSites).toContain("example.org");
    expect(app.dictation(null).excludedApps).toContain(bank.bundleIdentifier);
    // Adding it again is still unsaved, and tells no one of a change: the list is as it was.
    expect(app.excludeSite("example.org")).toBe("unsaved");
    expect(app.excludeApp({ ...bank, bundleIdentifier: "ORG.EXAMPLE.BANK" })).toBe("unsaved");
    expect(changes).toBe(2);
    expect(app.excludedSites).toEqual(["example.org"]);
    expect(app.excludedApps).toEqual([bank]);
    // Nothing is unsaved for one built in or invalid.
    expect(app.excludeSite(config.builtInExcludedSites[0])).toBe("added");
    expect(app.excludeApp(config.builtInExcludedApps[0])).toBe("added");
    expect(app.excludeSite("not a site")).toBe("invalid");
    expect(app.excludeApp({ bundleIdentifier: "", name: "" })).toBe("invalid");

    expect(app.removeExcludedSite("example.org")).toBe(false);
    expect(app.removeExcludedApp(bank.bundleIdentifier)).toBe(false);
    expect(changes).toBe(4);
    expect(app.excludedSites).toEqual([]);
    expect(app.excludedApps).toEqual([]);
    // Nothing is written for one that is not there.
    expect(app.removeExcludedSite("example.org")).toBe(true);
    expect(app.removeExcludedApp(bank.bundleIdentifier)).toBe(true);
  });

  /** The message says to add it again: doing so writes the list held, so it lasts once the file can
   * be written. */
  test("added again once the file can be written, it is saved", () => {
    const folder = mkdtempSync(join(tmpdir(), "voice-settings-"));
    try {
      const path = join(folder, "settings.json");
      const app = settings(new JSONFileStore(path));
      mkdirSync(`${path}.tmp`);
      expect(app.excludeSite("example.org")).toBe("unsaved");
      expect(app.excludeApp(bank)).toBe("unsaved");
      expect(app.excludeSite("example.org")).toBe("unsaved");
      expect(app.excludeApp(bank)).toBe("unsaved");
      expect(settings(new JSONFileStore(path)).excludedSites).toEqual([]);

      rmSync(`${path}.tmp`, { recursive: true });
      expect(app.excludeSite("example.org")).toBe("added");
      expect(settings(new JSONFileStore(path)).excludedSites).toEqual(["example.org"]);
      rmSync(path);
      expect(app.excludeApp(bank)).toBe("added");
      const relaunched = settings(new JSONFileStore(path));
      expect(relaunched.excludedSites).toEqual(["example.org"]);
      expect(relaunched.excludedApps).toEqual([bank]);
    } finally {
      rmSync(folder, { recursive: true });
    }
  });

  /** The last place in a full list is no different: the one held is saved by adding it again, and
   * a new one is still refused. */
  test("the last app of a full list, unsaved, is saved by adding it again", () => {
    const folder = mkdtempSync(join(tmpdir(), "voice-settings-"));
    try {
      const path = join(folder, "settings.json");
      const app = settings(new JSONFileStore(path));
      for (let index = 1; index < config.excludedAppsMax; index += 1) expect(app.excludeApp({ bundleIdentifier: `org.example.app${index}`, name: `App ${index}` })).toBe("added");
      mkdirSync(`${path}.tmp`);
      expect(app.excludeApp(bank)).toBe("unsaved");
      expect(app.excludedApps).toHaveLength(config.excludedAppsMax);
      expect(app.excludeApp(bank)).toBe("unsaved");
      expect(settings(new JSONFileStore(path)).excludedApps).toHaveLength(config.excludedAppsMax - 1);

      rmSync(`${path}.tmp`, { recursive: true });
      expect(app.excludeApp({ bundleIdentifier: "org.example.another", name: "Another" })).toBe("full");
      expect(settings(new JSONFileStore(path)).excludedApps).toHaveLength(config.excludedAppsMax - 1);
      expect(app.excludeApp(bank)).toBe("added");
      const relaunched = settings(new JSONFileStore(path)).excludedApps;
      expect(relaunched).toHaveLength(config.excludedAppsMax);
      expect(relaunched.at(-1)).toEqual(bank);
    } finally {
      rmSync(folder, { recursive: true });
    }
  });

  /** A removal answered as saved is gone from the file, the last one too; one that could not be
   * written is still in it. */
  test("a removal is in the file a relaunch reads, or reported unsaved", () => {
    const folder = mkdtempSync(join(tmpdir(), "voice-settings-"));
    try {
      const path = join(folder, "settings.json");
      const app = settings(new JSONFileStore(path));
      const relaunched = () => settings(new JSONFileStore(path));
      for (const site of ["example.org", "example.net"]) expect(app.excludeSite(site)).toBe("added");
      const notes = { bundleIdentifier: "org.example.notes", name: "Example Notes" };
      for (const one of [bank, notes]) expect(app.excludeApp(one)).toBe("added");

      expect(app.removeExcludedSite("example.org")).toBe(true);
      expect(app.removeExcludedApp(bank.bundleIdentifier)).toBe(true);
      expect(relaunched().excludedSites).toEqual(["example.net"]);
      expect(relaunched().excludedApps).toEqual([notes]);

      mkdirSync(`${path}.tmp`);
      expect(app.removeExcludedSite("example.net")).toBe(false);
      expect(app.removeExcludedApp(notes.bundleIdentifier)).toBe(false);
      expect([app.excludedSites, app.excludedApps]).toEqual([[], []]);
      expect(relaunched().excludedSites).toEqual(["example.net"]);
      expect(relaunched().excludedApps).toEqual([notes]);

      // The last one of each list, removed where the file can be written.
      rmSync(`${path}.tmp`, { recursive: true });
      const next = relaunched();
      expect(next.removeExcludedSite("example.net")).toBe(true);
      expect(relaunched().excludedSites).toEqual([]);
      expect(relaunched().excludedApps).toEqual([notes]);
      expect(next.removeExcludedApp(notes.bundleIdentifier)).toBe(true);
      expect(relaunched().excludedApps).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true });
    }
  });

  test("a saved one is reported added, and removed", () => {
    const app = settings();
    expect(app.excludeSite("example.org")).toBe("added");
    expect(app.excludeApp(bank)).toBe("added");
    expect(app.removeExcludedSite("example.org")).toBe(true);
    expect(app.removeExcludedApp(bank.bundleIdentifier)).toBe(true);
  });
});

/** The websites the screen is never read on (ADR-DESK-047): the built-in web vaults in every
 * installation, and the sites the user adds in Settings › Privacy. */
describe("websites excluded from screen reading", () => {
  const builtIn = [...config.builtInExcludedSites];

  test("the web vaults are excluded from the start, and the user's list is empty", () => {
    const app = settings();
    expect(app.excludedSites).toEqual([]);
    expect(app.dictation(null).excludedSites).toEqual(builtIn);
  });

  test("sites the user adds are kept by host, in order, across a relaunch, and a dictation excludes them too", () => {
    const store = new MemoryStore();
    const app = settings(store);
    let changes = 0;
    app.observe(() => {
      changes += 1;
    });
    expect(app.excludeSite("https://Mail.Example.com/inbox")).toBe("added");
    expect(app.excludeSite("example.org")).toBe("added");
    expect(changes).toBe(2);
    expect(store.get("excludedSites")).toEqual(["mail.example.com", "example.org"]);

    const relaunched = settings(store);
    expect(relaunched.excludedSites).toEqual(["mail.example.com", "example.org"]);
    expect(relaunched.dictation(null).excludedSites).toEqual([...builtIn, "mail.example.com", "example.org"]);
  });

  test("a site already excluded, by the user or built in, is taken without a second entry", () => {
    const app = settings();
    app.excludeSite("example.com");
    let changes = 0;
    app.observe(() => {
      changes += 1;
    });
    expect(app.excludeSite("EXAMPLE.com/")).toBe("added");
    expect(app.excludeSite(`https://my.${builtIn[0] ?? ""}`)).toBe("added");
    expect(app.excludedSites).toEqual(["example.com"]);
    expect(changes).toBe(0);
  });

  test.each([null, 7, "", "localhost", "not a site", {}])("%j is not a website", (value) => {
    const app = settings();
    expect(app.excludeSite(value)).toBe("invalid");
    expect(app.excludedSites).toEqual([]);
  });

  test("at most excludedSitesMax sites, and one already there is still taken when full", () => {
    const app = settings();
    for (let index = 0; index < config.excludedSitesMax; index += 1) expect(app.excludeSite(`site${index}.example.com`)).toBe("added");
    expect(app.excludeSite("example.org")).toBe("full");
    expect(app.excludeSite("site3.example.com")).toBe("added");
    expect(app.excludedSites).toHaveLength(config.excludedSitesMax);
    expect(app.excludedSites).not.toContain("example.org");
  });

  test("removing takes the user's site off the list, whatever the case; a built-in one stays", () => {
    const app = settings();
    app.excludeSite("example.com");
    app.excludeSite("example.org");
    let changes = 0;
    app.observe(() => {
      changes += 1;
    });
    app.removeExcludedSite("EXAMPLE.com");
    expect(app.excludedSites).toEqual(["example.org"]);
    expect(changes).toBe(1);

    app.removeExcludedSite(builtIn[0] ?? "");
    app.removeExcludedSite("example.net");
    expect(changes).toBe(1);
    expect(app.dictation(null).excludedSites).toEqual([...builtIn, "example.org"]);
  });
});

/** The apps the screen is never read in (owner, 2026-09-30): the built-in password managers in every
 * installation, and the apps the user adds in Settings › Privacy. */
describe("apps excluded from screen reading", () => {
  const builtIn = config.builtInExcludedApps.map((app) => app.bundleIdentifier);
  const bank = { bundleIdentifier: "org.example.bank", name: "Example Bank" };
  const notes = { bundleIdentifier: "org.example.notes", name: "Example Notes" };

  test("Windows uses its native built-ins in storage and key-down policy", () => {
    const store = new MemoryStore();
    const app = new AppSettings(store, () => false, ["rightAlt", "rightControl"], config.windowsBuiltInExcludedApps);
    const ids = config.windowsBuiltInExcludedApps.map((entry) => entry.bundleIdentifier);
    expect(app.dictation(null).excludedApps).toEqual(ids);
    expect(app.excludeApp({ bundleIdentifier: "KEEPASSXC.EXE", name: "Renamed display" })).toBe("added");
    expect(app.excludedApps).toEqual([]);
    app.removeExcludedApp("KeePassXC.exe");
    expect(app.dictation(null).excludedApps).toContain("KeePassXC.exe");
    app.excludeApp({ bundleIdentifier: "Example.exe", name: "Example" });
    const snapshot = app.dictation(null);
    app.removeExcludedApp("Example.exe");
    expect(snapshot.excludedApps).toEqual([...ids, "Example.exe"]);
    expect(app.dictation(null).excludedApps).toEqual(ids);
    expect(app.dictation(null).excludedApps).not.toContain("com.apple.Passwords");
  });

  test("the password managers are excluded from the start, and the user's list is empty", () => {
    const app = settings();
    expect(app.excludedApps).toEqual([]);
    expect(builtIn).toEqual(expect.arrayContaining(["com.apple.Passwords", "com.apple.keychainaccess", "com.1password.1password", "com.bitwarden.desktop"]));
    expect(app.dictation(null).excludedApps).toEqual(builtIn);
  });

  test("apps the user adds are kept in order across a relaunch, and a dictation excludes them too", () => {
    const store = new MemoryStore();
    const app = settings(store);
    let changes = 0;
    app.observe(() => (changes += 1));
    expect(app.excludeApp(bank)).toBe("added");
    expect(app.excludeApp(notes)).toBe("added");
    expect(changes).toBe(2);

    const relaunched = settings(store);
    expect(relaunched.excludedApps).toEqual([bank, notes]);
    expect(relaunched.dictation(null).excludedApps).toEqual([...builtIn, bank.bundleIdentifier, notes.bundleIdentifier]);
  });

  test("an app already excluded, by the user or built in, is not added twice, whatever its case", () => {
    const app = settings();
    app.excludeApp(bank);
    let changes = 0;
    app.observe(() => (changes += 1));
    expect(app.excludeApp({ bundleIdentifier: "ORG.EXAMPLE.BANK", name: "Bank" })).toBe("added");
    expect(app.excludeApp({ bundleIdentifier: "com.apple.passwords", name: "Passwords" })).toBe("added");
    expect(app.excludedApps).toEqual([bank]);
    expect(changes).toBe(0);
  });

  test.each([null, "org.example.bank", {}, { bundleIdentifier: "", name: "Bank" }, { bundleIdentifier: "org.example.bank", name: "" }, { bundleIdentifier: 1, name: "Bank" }, { bundleIdentifier: "org.example.bank" }, { bundleIdentifier: "x".repeat(config.bundleIdentifierMaxLength + 1), name: "Bank" }, { bundleIdentifier: "org.example.bank", name: "x".repeat(config.excludedAppNameMaxLength + 1) }])("refuses %j", (value) => {
    const app = settings();
    expect(app.excludeApp(value)).toBe("invalid");
    expect(app.excludedApps).toEqual([]);
  });

  test("an identifier and a name of exactly the most characters are taken", () => {
    const app = settings();
    const longest = { bundleIdentifier: "x".repeat(config.bundleIdentifierMaxLength), name: "y".repeat(config.excludedAppNameMaxLength) };
    expect(app.excludeApp(longest)).toBe("added");
    expect(app.excludedApps).toEqual([longest]);
  });

  test("at most excludedAppsMax apps, and one already there is still taken when full", () => {
    const app = settings();
    for (let index = 0; index < config.excludedAppsMax; index += 1) expect(app.excludeApp({ bundleIdentifier: `org.example.app${index}`, name: `App ${index}` })).toBe("added");
    expect(app.excludeApp(bank)).toBe("full");
    expect(app.excludeApp({ bundleIdentifier: "org.example.app3", name: "App 3" })).toBe("added");
    expect(app.excludedApps).toHaveLength(config.excludedAppsMax);
    expect(app.excludedApps.some((excluded) => excluded.bundleIdentifier === bank.bundleIdentifier)).toBe(false);
  });

  test("an app is removed by its identifier, whatever its case; a built-in one stays excluded", () => {
    const app = settings();
    app.excludeApp(bank);
    app.excludeApp(notes);
    let changes = 0;
    app.observe(() => (changes += 1));
    app.removeExcludedApp("ORG.EXAMPLE.BANK");
    expect(app.excludedApps).toEqual([notes]);
    expect(changes).toBe(1);

    app.removeExcludedApp("com.apple.Passwords");
    app.removeExcludedApp("org.example.absent");
    expect(changes).toBe(1);
    expect(app.dictation(null).excludedApps).toEqual([...builtIn, notes.bundleIdentifier]);
  });

  test("only valid apps are read back: none twice, none built in, at most excludedAppsMax", () => {
    const store = new MemoryStore();
    store.set("excludedApps", [bank, "junk", { bundleIdentifier: "ORG.example.bank", name: "Again" }, { bundleIdentifier: "com.apple.Passwords", name: "Passwords" }, { name: "No identifier" }, notes]);
    expect(settings(store).excludedApps).toEqual([bank, notes]);

    store.set("excludedApps", Array.from({ length: config.excludedAppsMax + 5 }, (_, index) => ({ bundleIdentifier: `org.example.app${index}`, name: `App ${index}` })));
    expect(settings(store).excludedApps).toHaveLength(config.excludedAppsMax);

    store.set("excludedApps", "junk");
    expect(settings(store).excludedApps).toEqual([]);
  });
});

/** The user's dictionary (ADR-DESK-038): words typed in Settings, and words learned from the user's
 * corrections, kept on this computer in the order added. */
describe("dictionary", () => {
  test("is empty, and learns words, by default", () => {
    const app = settings();
    expect(app.dictionary).toEqual([]);
    expect(app.learnsWords).toBe(true);
    expect(app.dictation(null)).toMatchObject({ dictionary: [], learnsWords: true });
  });

  test("keeps typed and learned words, in order, across a relaunch", () => {
    const store = new MemoryStore();
    const app = settings(store);
    let changes = 0;
    app.observe(() => (changes += 1));
    expect(app.addWord("  Xyvora ")).toBe("added");
    expect(app.learnWords(["Kaelthorne Draszek"])).toEqual(["Kaelthorne Draszek"]);
    app.learnsWords = false;
    expect(changes).toBe(3);

    const relaunched = settings(store);
    expect(relaunched.dictionary).toEqual([{ word: "Xyvora", learned: false }, { word: "Kaelthorne Draszek", learned: true }]);
    expect(relaunched.learnsWords).toBe(false);
    expect(relaunched.dictation(null).dictionary).toEqual(["Xyvora", "Kaelthorne Draszek"]);
  });

  test("a word already there isn't added twice, whatever its case", () => {
    const app = settings();
    app.addWord("Xyvora");
    expect(app.addWord("XYVORA")).toBe("added");
    expect(app.learnWords(["xyvora", "Xyvora", "TabMail", "tabmail"])).toEqual(["TabMail"]);
    expect(app.dictionary.map((entry) => entry.word)).toEqual(["XYVORA", "TabMail"]);
  });

  /** Typing a word already there, in another spelling, is the user's latest word for it: it takes
   * that spelling, and one learned no longer shows as learned. */
  test("typing a word already there takes the spelling typed", () => {
    const app = settings();
    app.learnWords(["Tabmail"]);
    expect(app.addWord("TabMail")).toBe("added");
    expect(app.dictionary).toEqual([{ word: "TabMail", learned: false }]);
    app.addWord("XyVora");
    expect(app.addWord("Xyvora")).toBe("added");
    expect(app.dictionary).toEqual([{ word: "TabMail", learned: false }, { word: "Xyvora", learned: false }]);
  });

  test("takes a word of the most characters", () => {
    const app = settings();
    expect(app.addWord("x".repeat(config.dictionaryWordMaxChars))).toBe("added");
    expect(app.dictionary).toEqual([{ word: "x".repeat(config.dictionaryWordMaxChars), learned: false }]);
  });

  test.each(["", "   ", "x".repeat(config.dictionaryWordMaxChars + 1), "one two three four five six seven", "Xy<vora", "Xy\u0007vora", "Xy\u007fvora", "Xy\u0085vora"])("refuses %j", (word) => {
    const app = settings();
    expect(app.addWord(word)).toBe("invalid");
    expect(app.learnWords([word])).toEqual([]);
    expect(app.dictionary).toEqual([]);
  });

  test("collapses a word's spaces", () => {
    const app = settings();
    app.addWord("Kaelthorne \t  Draszek");
    expect(app.dictionary).toEqual([{ word: "Kaelthorne Draszek", learned: false }]);
  });

  /** Learning only words already there, or refused, changes nothing: no write, no Settings update. */
  test("learning nothing new changes nothing", () => {
    const app = settings();
    app.addWord("Xyvora");
    let changes = 0;
    app.observe(() => (changes += 1));
    expect(app.learnWords(["xyvora", "Xy<vora"])).toEqual([]);
    expect(changes).toBe(0);
  });

  /** At `config.dictionaryMaxEntries`, half the words the backend takes with a dictation (the other
   * half are the screen's terms): a typed word is refused, learning stops. */
  test("holds at most its half of the words sent", () => {
    const app = settings();
    const words = Array.from({ length: config.dictionaryMaxEntries }, (_, index) => `word${index}`);
    expect(app.learnWords(words)).toHaveLength(config.dictionaryMaxEntries);
    expect(app.addWord("Xyvora")).toBe("full");
    expect(app.learnWords(["Xyvora"])).toEqual([]);
    expect(app.addWord("WORD0")).toBe("added");
    expect(app.dictionary).toHaveLength(config.dictionaryMaxEntries);
    app.removeWord("word1");
    expect(app.addWord("Xyvora")).toBe("added");
    expect(app.dictionary.at(-1)).toEqual({ word: "Xyvora", learned: false });    expect(config.dictionaryMaxEntries + config.contextTermsMax).toBe(200);
  });

  test("removes a word by its spelling", () => {
    const app = settings();
    app.addWord("Xyvora");
    app.addWord("TabMail");
    let changes = 0;
    app.observe(() => (changes += 1));
    app.removeWord("xyvora");
    expect(changes).toBe(0);
    app.removeWord("Xyvora");
    expect(changes).toBe(1);
    expect(app.dictionary.map((entry) => entry.word)).toEqual(["TabMail"]);
  });

  /** The store is a file the user could edit: only valid, distinct entries are read back, at most the
   * limit. */
  test("reads back only valid entries", () => {
    const stored = [
      { word: "Xyvora", learned: false },
      { word: "xyvora", learned: true },
      { word: "Bad<word", learned: false },
      { word: " Padded", learned: false },
      { word: "TabMail" },
      "Loose",
      null,
      { word: "Kaelthorne Draszek", learned: true },
      ...Array.from({ length: config.dictionaryMaxEntries }, (_, index) => ({ word: `word${index}`, learned: true })),
    ];
    const dictionary = settings(new MemoryStore({ dictionary: stored })).dictionary;
    expect(dictionary.slice(0, 3)).toEqual([{ word: "Xyvora", learned: false }, { word: "Kaelthorne Draszek", learned: true }, { word: "word0", learned: true }]);
    expect(dictionary).toHaveLength(config.dictionaryMaxEntries);
    expect(settings(new MemoryStore({ dictionary: "Xyvora" })).dictionary).toEqual([]);
  });
});

/** The apps the Answer tool reaches, each switched on and off in Settings and the welcome wizard. */
describe("connectors", () => {
  /** Every app is on until the user turns it off. */
  test("every app is on by default", () => {
    const app = settings();

    for (const connector of connectorIDs) expect(app.isConnectorEnabled(connector)).toBe(true);
    expect(app.dictation(null).enabledConnectors).toEqual(connectorIDs);
  });

  /** An app turned off is left out of every dictation from then on, and stays off after a relaunch;
   * turned back on, it is reached again. */
  test.each(connectorIDs)("%s turned off stays off", (connector) => {
    const store = new MemoryStore();
    const changes: number[] = [];
    const app = settings(store);
    app.observe(() => changes.push(changes.length));
    app.setConnectorEnabled(connector, false);
    expect(changes).toHaveLength(1);

    const relaunched = settings(store);
    expect(relaunched.isConnectorEnabled(connector)).toBe(false);
    expect(relaunched.dictation(null).enabledConnectors).toEqual(connectorIDs.filter((other) => other !== connector));

    relaunched.setConnectorEnabled(connector, true);
    expect(settings(store).dictation(null).enabledConnectors).toEqual(connectorIDs);
  });

  /** Turning off two apps keeps both off; turning one off twice lists it once. */
  test("apps turned off add up", () => {
    const store = new MemoryStore();
    const app = settings(store);
    app.setConnectorEnabled("reminders", false);
    app.setConnectorEnabled("calendar", false);
    app.setConnectorEnabled("calendar", false);

    expect(store.get("disabledConnectors")).toEqual(["calendar", "reminders"]);
    expect(app.enabledConnectors).toEqual(["contacts", "files", "email", "notes", "messages", "web"]);
  });

  /** A stored name no longer an app, or a stored value of another type, is ignored rather than
   * turning anything off; a switch changed after that stores only apps. */
  test.each<[unknown, string[]]>([
    [["calendar", "retired-app"], ["reminders", "contacts", "files", "email", "notes", "messages", "web"]],
    ["calendar", ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"]],
    // Shortcuts, retired before the first release: a user who switched it off turns nothing else off.
    [["shortcuts"], ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"]],
    [[7, null], ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"]],
  ])("a stored %j turns off only known apps", (stored, enabled) => {
    const store = new MemoryStore({ disabledConnectors: stored });
    expect(settings(store).dictation(null).enabledConnectors).toEqual(enabled);

    settings(store).setConnectorEnabled("reminders", true);
    expect(store.get("disabledConnectors")).toEqual(connectorIDs.filter((connector) => !enabled.includes(connector)));
  });
});

/** The agent tools the user switches on and off in Settings and the welcome wizard. */
describe("agent tools", () => {
  /** Every tool is on until the user turns it off. */
  test("every tool is on by default", () => {
    const app = settings();

    for (const tool of agentToolIDs) expect(app.isEnabled(tool)).toBe(true);
    expect(app.dictation(null).enabledTools).toEqual(["edit", "compose", "answer"]);
  });

  /** Thunderbird's tool is offered to no dictation until its native connector (ADR-DESK-037), on or
   * off; a switch stored for it is kept for then, whatever other switches change meanwhile. */
  test("Thunderbird's tool is not offered, and its stored switch is kept", () => {
    const store = new MemoryStore();
    const app = settings(store);
    expect(offeredAgentToolIDs).not.toContain("thunderbird");
    expect(app.enabledTools).not.toContain("thunderbird");

    app.setEnabled("thunderbird", false);
    app.setEnabled("answer", false);
    app.setEnabled("answer", true);
    expect(store.get("disabledAgentTools")).toEqual(["thunderbird"]);
    expect(settings(store).isEnabled("thunderbird")).toBe(false);
    expect(settings(store).dictation(null).enabledTools).toEqual(["edit", "compose", "answer"]);
  });

  /** A tool turned off is left out of every dictation from then on, and stays off after a relaunch;
   * turned back on, it is offered again. */
  test.each(offeredAgentToolIDs)("%s turned off stays off", (tool) => {
    const store = new MemoryStore();
    const changes: number[] = [];
    const app = settings(store);
    app.observe(() => changes.push(changes.length));
    app.setEnabled(tool, false);
    expect(changes).toHaveLength(1);

    const relaunched = settings(store);
    expect(relaunched.isEnabled(tool)).toBe(false);
    expect(relaunched.dictation(null).enabledTools).toEqual(offeredAgentToolIDs.filter((other) => other !== tool));

    relaunched.setEnabled(tool, true);
    expect(settings(store).dictation(null).enabledTools).toEqual(offeredAgentToolIDs);
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
    [["answer", "retired-tool"], ["edit", "compose"]],
    ["answer", ["edit", "compose", "answer"]],
    [[7, null], ["edit", "compose", "answer"]],
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
