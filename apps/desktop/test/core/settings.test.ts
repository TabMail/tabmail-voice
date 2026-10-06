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

  /** A GNOME the integration doesn't support can't hold Right Alt: the keys offered narrow to F8 and
   * F9, and the stored choice comes back if Right Alt is offered again. */
  test("narrowing the offered hotkeys moves off a key no longer offered and keeps the stored choice", () => {
    const store = new MemoryStore({ dictationHotkey: "rightAlt" });
    const app = new AppSettings(store, () => false, ["rightAlt", "F8", "F9"]);
    const heard: string[] = [];
    let changes = 0;
    app.onHotkeyChange = (hotkey) => heard.push(hotkey);
    app.observe(() => changes++);
    app.offerHotkeys(["F8", "F9"]);
    expect(app.availableHotkeys).toEqual(["F8", "F9"]);
    expect(app.hotkey).toBe("F8");
    expect(heard).toEqual(["F8"]);
    expect(changes).toBe(1);
    expect(store.get("dictationHotkey")).toBe("rightAlt");
    // The same keys again change nothing.
    app.offerHotkeys(["F8", "F9"]);
    expect(heard).toEqual(["F8"]);
    expect(changes).toBe(1);
    app.offerHotkeys(["rightAlt", "F8", "F9"]);
    expect(app.hotkey).toBe("rightAlt");
    expect(heard).toEqual(["F8", "rightAlt"]);
    // A chosen key that stays offered stays chosen.
    app.hotkey = "F9";
    heard.length = 0;
    app.offerHotkeys(["F8", "F9"]);
    expect(app.hotkey).toBe("F9");
    expect(heard).toEqual([]);
    expect(changes).toBe(4);
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

/** A store whose file can't be written, as `JSONFileStore` is then: a value set is held, and
 * reported unsaved. */
class UnsavedStore extends MemoryStore {
  override set(key: string, value: unknown): boolean {
    super.set(key, value);
    return false;
  }
}

/** What is excluded is what is saved (owner, 2026-10-01): an exclusion or a removal that could not
 * be written did not happen, and is reported so Settings can say so. Nothing is excluded only until
 * the app quits. */
describe("an exclusion that could not be saved", () => {
  const bank = { bundleIdentifier: "org.example.bank", name: "Example Bank" };
  const notes = { bundleIdentifier: "org.example.notes", name: "Example Notes" };

  test("is reported unsaved, and is not excluded", () => {
    const app = settings(new UnsavedStore());
    let changes = 0;
    app.observe(() => (changes += 1));

    expect(app.excludeSite("example.org")).toBe("unsaved");
    expect(app.excludeApp(bank)).toBe("unsaved");
    expect(changes).toBe(0);
    expect(app.excludedSites).toEqual([]);
    expect(app.excludedApps).toEqual([]);
    expect(app.dictation(null).excludedSites).not.toContain("example.org");
    expect(app.dictation(null).excludedApps).not.toContain(bank.bundleIdentifier);
    // Nothing is unsaved for one built in or invalid.
    expect(app.excludeSite(config.builtInExcludedSites[0])).toBe("added");
    expect(app.excludeApp(config.builtInExcludedApps[0])).toBe("added");
    expect(app.excludeSite("not a site")).toBe("invalid");
    expect(app.excludeApp({ bundleIdentifier: "", name: "" })).toBe("invalid");
  });

  test("a removal is reported unsaved, and the list is as it was", () => {
    const store = new UnsavedStore();
    store.set("excludedSites", ["example.org", "example.net"]);
    store.set("excludedApps", [bank, notes]);
    const app = settings(store);
    let changes = 0;
    app.observe(() => (changes += 1));

    expect(app.removeExcludedSite("example.org")).toBe(false);
    expect(app.removeExcludedApp(bank.bundleIdentifier)).toBe(false);
    expect(changes).toBe(0);
    expect(app.excludedSites).toEqual(["example.org", "example.net"]);
    expect(app.excludedApps).toEqual([bank, notes]);
    // One added to a list that is there is not excluded either, and the list is as it was.
    expect(app.excludeSite("example.com")).toBe("unsaved");
    expect(app.excludedSites).toEqual(["example.org", "example.net"]);
    // Nothing is written for one that is not there, or one already there.
    expect(app.removeExcludedSite("example.com")).toBe(true);
    expect(app.removeExcludedApp("org.example.absent")).toBe(true);
    expect(app.excludeSite("example.net")).toBe("added");
    expect(app.excludeApp(notes)).toBe("added");
  });

  /** Over a real preferences file: after a failed write the list in the app and the list a relaunch
   * reads are the same one, and the same try saves once the file can be written. */
  test("the list and the file agree after a failed write, and the next try saves", () => {
    const folder = mkdtempSync(join(tmpdir(), "voice-settings-"));
    try {
      const path = join(folder, "settings.json");
      const app = settings(new JSONFileStore(path));
      const relaunched = () => settings(new JSONFileStore(path));
      const lists = (from: AppSettings) => [from.excludedSites, from.excludedApps];
      expect(app.excludeSite("example.net")).toBe("added");
      expect(app.excludeApp(notes)).toBe("added");

      mkdirSync(`${path}.tmp`);
      expect(app.excludeSite("example.org")).toBe("unsaved");
      expect(app.excludeApp(bank)).toBe("unsaved");
      expect(app.removeExcludedSite("example.net")).toBe(false);
      expect(app.removeExcludedApp(notes.bundleIdentifier)).toBe(false);
      expect(lists(app)).toEqual([["example.net"], [notes]]);
      expect(lists(relaunched())).toEqual([["example.net"], [notes]]);

      rmSync(`${path}.tmp`, { recursive: true });
      expect(app.excludeSite("example.org")).toBe("added");
      expect(app.excludeApp(bank)).toBe("added");
      expect(lists(relaunched())).toEqual([["example.net", "example.org"], [notes, bank]]);
      // A removal answered as saved is gone from the file, the last of a list too.
      for (const site of ["example.net", "example.org"]) expect(app.removeExcludedSite(site)).toBe(true);
      for (const one of [notes, bank]) expect(app.removeExcludedApp(one.bundleIdentifier)).toBe(true);
      expect(lists(relaunched())).toEqual([[], []]);
    } finally {
      rmSync(folder, { recursive: true });
    }
  });

  /** The first exclusion of an installation: there is no list to put back, and none is left. */
  test("a first exclusion that could not be saved leaves no list", () => {
    const store = new UnsavedStore();
    const app = settings(store);
    expect(app.excludeSite("example.org")).toBe("unsaved");
    expect(app.excludeApp(bank)).toBe("unsaved");
    expect(store.get("excludedSites")).toBeUndefined();
    expect(store.get("excludedApps")).toBeUndefined();
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

  test("at most exclusionsMax sites, one already there or built in still answered added", () => {
    const store = new MemoryStore();
    store.set("excludedSites", Array.from({ length: config.exclusionsMax - 1 }, (_, index) => `site${index}.example.com`));
    const app = settings(store);
    expect(app.excludeSite("example.net")).toBe("added");
    expect(app.excludeSite("example.org")).toBe("full");
    expect(app.excludeSite("site3.example.com")).toBe("added");
    expect(app.excludeSite(config.builtInExcludedSites[0])).toBe("added");
    expect(app.excludedSites).toHaveLength(config.exclusionsMax);
    expect(app.excludedSites).not.toContain("example.org");
    expect(app.dictation(null).excludedSites.at(-1)).toBe("example.net");
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
    expect(ids).toEqual(["1Password.exe", "Bitwarden.exe", "KeePassXC.exe", "NordPass.exe"]);
    for (const id of ids) {
      app.excludeApp({ bundleIdentifier: id.toUpperCase(), name: "Renamed" });
      app.removeExcludedApp(id.toLowerCase());
    }
    expect(app.excludedApps).toEqual([]);
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

  test("at most exclusionsMax apps, one already there or built in still answered added", () => {
    const store = new MemoryStore();
    store.set("excludedApps", Array.from({ length: config.exclusionsMax - 1 }, (_, index) => ({ bundleIdentifier: `org.example.app${index}`, name: `App ${index}` })));
    const app = settings(store);
    expect(app.excludeApp(notes)).toBe("added");
    expect(app.excludeApp(bank)).toBe("full");
    expect(app.excludeApp({ bundleIdentifier: "org.example.app3", name: "App 3" })).toBe("added");
    expect(app.excludeApp(config.builtInExcludedApps[0])).toBe("added");
    expect(app.excludedApps).toHaveLength(config.exclusionsMax);
    expect(app.excludedApps.some((excluded) => excluded.bundleIdentifier === bank.bundleIdentifier)).toBe(false);
    expect(app.dictation(null).excludedApps.at(-1)).toBe(notes.bundleIdentifier);
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

  test("only valid apps are read back: none twice, none built in", () => {
    const store = new MemoryStore();
    store.set("excludedApps", [bank, "junk", { bundleIdentifier: "ORG.example.bank", name: "Again" }, { bundleIdentifier: "com.apple.Passwords", name: "Passwords" }, { name: "No identifier" }, notes]);
    expect(settings(store).excludedApps).toEqual([bank, notes]);

    // However many: a list is never cut short on the way back.
    store.set("excludedApps", Array.from({ length: config.exclusionsMax + 5 }, (_, index) => ({ bundleIdentifier: `org.example.app${index}`, name: `App ${index}` })));
    expect(settings(store).excludedApps).toHaveLength(config.exclusionsMax + 5);

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
    expect(relaunched.dictionary).toEqual([{ word: "Xyvora", learned: false, lastUsed: 1 }, { word: "Kaelthorne Draszek", learned: true, lastUsed: 2 }]);
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
    expect(app.dictionary).toEqual([{ word: "TabMail", learned: false, lastUsed: 2 }]);
    app.addWord("XyVora");
    expect(app.addWord("Xyvora")).toBe("added");
    expect(app.dictionary).toEqual([{ word: "TabMail", learned: false, lastUsed: 2 }, { word: "Xyvora", learned: false, lastUsed: 4 }]);
  });

  test("takes a word of the most characters", () => {
    const app = settings();
    expect(app.addWord("x".repeat(config.dictionaryWordMaxChars))).toBe("added");
    expect(app.dictionary.map((entry) => entry.word)).toEqual(["x".repeat(config.dictionaryWordMaxChars)]);
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
    expect(app.dictionary.map((entry) => entry.word)).toEqual(["Kaelthorne Draszek"]);
  });

  /** Learning only words refused changes nothing: no write, no Settings update. */
  test("learning nothing changes nothing", () => {
    const app = settings();
    app.addWord("Xyvora");
    let changes = 0;
    app.observe(() => (changes += 1));
    expect(app.learnWords(["Xy<vora", ""])).toEqual([]);
    expect(changes).toBe(0);
  });

  /** A word learned again, typed or learned, is a use: it adds nothing but is kept over the words not
   * used since. */
  test("learning a word already there marks it used", () => {
    const app = settings();
    app.addWord("Xyvora");
    app.learnWords(["TabMail"]);
    let changes = 0;
    app.observe(() => (changes += 1));
    expect(app.learnWords(["xyvora"])).toEqual([]);
    expect(changes).toBe(1);
    expect(app.dictionary).toEqual([{ word: "Xyvora", learned: false, lastUsed: 3 }, { word: "TabMail", learned: true, lastUsed: 2 }]);
  });

  /** Owner, 2026-10-02: of the 200 words the backend takes with a dictation, the dictionary's come
   * first, at most 150, at most 100 of them typed; learned words fill the rest, all 150 when none is
   * typed; the screen's terms fill what the dictionary leaves. */
  test("holds the words sent beside the screen's, at most 100 typed", () => {
    expect([config.vocabularyMaxTerms, config.dictionaryMaxEntries, config.dictionaryMaxTypedWords]).toEqual([200, 150, 100]);
    const app = settings();
    const learned = Array.from({ length: config.dictionaryMaxEntries }, (_, index) => `learned${index}`);
    expect(app.learnWords(learned)).toHaveLength(config.dictionaryMaxEntries);
    expect(app.learnWords(["Xyvora"])).toEqual(["Xyvora"]);
    expect(app.dictionary).toHaveLength(config.dictionaryMaxEntries);
    for (let index = 0; index < config.dictionaryMaxTypedWords; index += 1) expect(app.addWord(`typed${index}`)).toBe("added");
    expect(app.addWord("TabMail")).toBe("full");
    expect(app.dictionary).toHaveLength(config.dictionaryMaxEntries);
    expect(app.dictionary.filter((entry) => !entry.learned)).toHaveLength(config.dictionaryMaxTypedWords);
    expect(app.dictionary.filter((entry) => entry.learned)).toHaveLength(config.dictionaryMaxEntries - config.dictionaryMaxTypedWords);
  });

  /** At the cap a learned word typed again would be one more typed word: refused, and it stays
   * learned. A typed word typed again adds none: it takes the spelling typed. */
  test("refuses a learned word typed again at the typed cap", () => {
    const app = settings();
    app.learnWords(["Xyvora"]);
    for (let index = 0; index < config.dictionaryMaxTypedWords; index += 1) app.addWord(`typed${index}`);
    expect(app.addWord("XYVORA")).toBe("full");
    expect(app.dictionary[0]).toEqual({ word: "Xyvora", learned: true, lastUsed: 1 });
    expect(app.addWord("TYPED0")).toBe("added");
    expect(app.dictionary[1]).toEqual({ word: "TYPED0", learned: false, lastUsed: config.dictionaryMaxTypedWords + 2 });
    app.removeWord("typed1");
    expect(app.addWord("xyvora")).toBe("added");
    expect(app.dictionary[0]).toEqual({ word: "xyvora", learned: false, lastUsed: config.dictionaryMaxTypedWords + 3 });
  });

  /** Owner, 2026-10-02: a full dictionary keeps learning; each new word, learned or typed (below the
   * typed cap), takes the place of the learned word used least recently (not the one learned first),
   * and a typed word is never dropped. */
  describe("when full", () => {
    /** A dictionary of typed words, then learned ones, each used once, in order. */
    function full(typed: number): AppSettings {
      const app = settings();
      for (let index = 0; index < typed; index += 1) app.addWord(`typed${index}`);
      for (let index = typed; index < config.dictionaryMaxEntries; index += 1) app.learnWords([`learned${index}`]);
      expect(app.dictionary).toHaveLength(config.dictionaryMaxEntries);
      return app;
    }
    const words = (app: AppSettings) => app.dictionary.map((entry) => entry.word);

    test("a learned word takes the place of the learned word used least recently", () => {
      const app = full(10);
      // The oldest learned word, used in a dictation since: the next oldest goes instead.
      app.useWords(["she said learned10 twice"]);
      expect(app.learnWords(["Xyvora"])).toEqual(["Xyvora"]);
      expect(words(app)).toHaveLength(config.dictionaryMaxEntries);
      expect(words(app)).toContain("learned10");
      expect(words(app)).not.toContain("learned11");
      expect(words(app).at(-1)).toBe("Xyvora");
      // Next goes the one after it; learned10 and Xyvora, used later, stay.
      app.learnWords(["Kaelthorne Draszek"]);
      expect(words(app)).not.toContain("learned12");
      expect(words(app)).toEqual(expect.arrayContaining(["learned10", "Xyvora", "Kaelthorne Draszek"]));
    });

    test("a word learned again counts as used", () => {
      const app = full(0);
      app.learnWords(["LEARNED0"]);
      app.learnWords(["Xyvora"]);
      expect(words(app)).toContain("learned0");
      expect(words(app)).not.toContain("learned1");
    });

    test("a typed word takes the place of the learned word used least recently", () => {
      const app = full(10);
      app.useWords(["learned10"]);
      expect(app.addWord("Xyvora")).toBe("added");
      expect(words(app)).toHaveLength(config.dictionaryMaxEntries);
      expect(words(app)).toContain("learned10");
      expect(words(app)).not.toContain("learned11");
      expect(app.dictionary.at(-1)).toEqual({ word: "Xyvora", learned: false, lastUsed: config.dictionaryMaxEntries + 2 });
    });

    /** At the typed cap a typed word is refused; learning goes on in the learned words' room, and
     * however much is learned, no typed word is dropped. */
    test("never drops a typed word", () => {
      const app = full(config.dictionaryMaxTypedWords);
      expect(app.addWord("Xyvora")).toBe("full");
      const learned = Array.from({ length: config.dictionaryMaxEntries }, (_, index) => `later${index}`);
      for (const word of learned) expect(app.learnWords([word])).toEqual([word]);
      expect(words(app)).toHaveLength(config.dictionaryMaxEntries);
      expect(words(app).slice(0, config.dictionaryMaxTypedWords)).toEqual(Array.from({ length: config.dictionaryMaxTypedWords }, (_, index) => `typed${index}`));
      expect(words(app).slice(config.dictionaryMaxTypedWords)).toEqual(learned.slice(-(config.dictionaryMaxEntries - config.dictionaryMaxTypedWords)));
    });

    /** A correction that respells a word already there and a new one: the word already there is used
     * now, so the new one never drops it, whichever comes first in the correction. */
    // With the typed words at their cap: the learned word used least recently, then the next.
    const oldest = `learned${config.dictionaryMaxTypedWords}`;
    const next = `learned${config.dictionaryMaxTypedWords + 1}`;

    test.each([
      ["after", ["Xyvora", oldest]],
      ["before", [oldest, "Xyvora"]],
    ])("keeps a word learned again in the same correction, listed %s the new one", (_order, learned) => {
      // The oldest, used again, stays, and Xyvora takes the next one's place.
      const app = full(config.dictionaryMaxTypedWords);
      expect(app.learnWords(learned)).toEqual(["Xyvora"]);
      expect(words(app)).toContain(oldest);
      expect(words(app)).not.toContain(next);
      expect(app.dictionary.find((entry) => entry.word === oldest)?.lastUsed).toBe(config.dictionaryMaxEntries + 1);
    });

    /** A typed word respelled in a correction counts as used, beside a new word learned. */
    test("marks a typed word used in the same correction as a new word", () => {
      const app = full(config.dictionaryMaxTypedWords);
      expect(app.learnWords(["Xyvora", "typed0"])).toEqual(["Xyvora"]);
      expect(app.dictionary[0]).toEqual({ word: "typed0", learned: false, lastUsed: config.dictionaryMaxEntries + 1 });
    });

    /** Words learned together don't push each other out: once every learned word there is one of
     * them, the next is not learned. */
    test("doesn't drop a word learned in the same correction", () => {
      const app = full(config.dictionaryMaxTypedWords);
      const room = config.dictionaryMaxEntries - config.dictionaryMaxTypedWords;
      const correction = Array.from({ length: room + 1 }, (_, index) => `new${index}`);
      expect(app.learnWords(correction)).toEqual(correction.slice(0, room));
      expect(words(app).slice(config.dictionaryMaxTypedWords)).toEqual(correction.slice(0, room));
    });

    /** Of learned words never used since they were stored (`lastUsed` 0), the earliest goes first. */
    test("drops the earliest of words used as long ago", () => {
      const stored = Array.from({ length: config.dictionaryMaxEntries }, (_, index) => ({ word: `word${index}`, learned: true }));
      const app = settings(new MemoryStore({ dictionary: stored }));
      app.learnWords(["Xyvora"]);
      expect(words(app)[0]).toBe("word1");
      expect(words(app).at(-1)).toBe("Xyvora");
    });
  });

  /** A dictation's text marks the words in it used, typed or learned, whatever their case, a word
   * inside a longer one too (scripts without spaces have no word edge); only a change is written. */
  test("marks the words in a dictation's text used", () => {
    const app = settings();
    app.addWord("Xyvora");
    app.learnWords(["TabMail"]);
    app.learnWords(["탭메일"]);
    let changes = 0;
    app.observe(() => (changes += 1));
    app.useWords(["nothing in the dictionary"]);
    expect(changes).toBe(0);
    app.useWords(["ask about tabmail's roadmap", "Ask about TabMail’s roadmap."]);
    expect(changes).toBe(1);
    app.useWords(["탭메일은 좋아요", "the Xyvoracorp deal"]);
    expect(app.dictionary).toEqual([
      { word: "Xyvora", learned: false, lastUsed: 5 },
      { word: "TabMail", learned: true, lastUsed: 4 },
      { word: "탭메일", learned: true, lastUsed: 5 },
    ]);
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
      { word: "Kaelthorne Draszek", learned: true, lastUsed: 7 },
      { word: "Zivora", learned: true, lastUsed: -1 },
      { word: "Brevalle", learned: true, lastUsed: 1.5 },
      { word: "Ostrava", learned: true, lastUsed: "7" },
      ...Array.from({ length: config.dictionaryMaxEntries }, (_, index) => ({ word: `word${index}`, learned: true })),
    ];
    const dictionary = settings(new MemoryStore({ dictionary: stored })).dictionary;
    // One stored before `lastUsed` was kept, or with an invalid one, reads as never used.
    expect(dictionary.slice(0, 6)).toEqual([
      { word: "Xyvora", learned: false, lastUsed: 0 },
      { word: "Kaelthorne Draszek", learned: true, lastUsed: 7 },
      { word: "Zivora", learned: true, lastUsed: 0 },
      { word: "Brevalle", learned: true, lastUsed: 0 },
      { word: "Ostrava", learned: true, lastUsed: 0 },
      { word: "word0", learned: true, lastUsed: 0 },
    ]);
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
