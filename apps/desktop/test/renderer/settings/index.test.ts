// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { brandBlue, brandGradient, brandTextGradient } from "../../../src/renderer/shared/brand.js";
import type { Command, CommandResult, SettingsState } from "../../../src/shared/ipc.js";

const signedIn: SettingsState = {
  email: "person@example.com",
  hotkey: "rightOption",
  availableHotkeys: ["rightOption", "function"],
  readsScreen: true,
  enabledTools: ["edit", "compose", "thunderbird", "answer"],
  connectors: [],
  enabledConnectors: [],
  userName: "Alex Example",
  suggestedName: "Alex Example",
  dictionary: [],
  learnsWords: true,
  canLearnWords: true,
  excludedApps: [],
  excludedSites: [],
  canExcludeApps: true,
  builtInExcludedApps: config.builtInExcludedApps,
  emailClient: null,
  systemEmailApp: null,
  installedEmailApps: [],
  hasTabMail: false,
  defaultEmailAppIsSupported: false,
  microphoneGranted: true,
  accessibilityTrusted: true,
  vscodeFix: "notNeeded",
  openAtLogin: false,
  debugAllowed: false,
  debugMode: false,
  version: "1.2.3",
  update: { kind: "idle" },
};

/** The Settings page, mounted afresh against a stand-in main process that shows `initial`, answers
 * each command with `reply` and then pushes `after` (as the main process pushes the new state). */
async function settingsPage(reply: CommandResult, after: SettingsState, initial = signedIn): Promise<{ commands: Command[] }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const commands: Command[] = [];
  let listener: ((state: SettingsState) => void) | null = null;
  vi.stubGlobal("voice", {
    onState: (_name: string, next: (state: SettingsState) => void) => {
      listener = next;
      return () => {};
    },
    send: async (command: Command) => {
      commands.push(command);
      listener?.(after);
      return reply;
    },
  });
  vi.resetModules();
  await act(async () => {
    await import("../../../src/renderer/settings/index.js");
  });
  await act(async () => listener?.(initial));
  return { commands };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** The switch labeled `label`: the input its label names. */
function toggle(label: string): HTMLInputElement {
  const found = [...document.querySelectorAll("label")].find((element) => element.textContent === label);
  const input = found && document.getElementById(found.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no ${label} switch`);
  return input;
}

/** The text of the visible section's rows and notes. */
function visibleText(): string {
  return [...document.querySelectorAll("main > div:not([hidden])")].map((pane) => pane.textContent ?? "").join("\n");
}

/** Types `text` into `input` as the user would, so React sees the change. */
function type(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The menu in the row titled `title`. */
function menu(title: string): HTMLSelectElement {
  const found = [...document.querySelectorAll(".row")].find((row) => row.firstElementChild?.textContent === title)?.querySelector("select");
  if (!found) throw new Error(`no ${title} menu`);
  return found;
}

/** Picks `value` in `select` as the user would. */
function pick(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The Allow… button in the permission row titled `title`. */
function allow(title: string): HTMLButtonElement {
  const found = [...document.querySelectorAll(".row")].find((row) => row.firstElementChild?.textContent === title)?.querySelector("button");
  if (!found) throw new Error(`no Allow… for ${title}`);
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Settings page", () => {
  /** Settings › Dictionary (ADR-DESK-038). */
  describe("the dictionary", () => {
    const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Word or name"]') as HTMLInputElement;
    const words = (): string[] => [...document.querySelectorAll('ul[aria-label="Dictionary"] li')].map((item) => item.textContent ?? "");

    async function open(initial: SettingsState): Promise<{ commands: Command[] }> {
      const page = await settingsPage({ error: null }, initial, initial);
      await act(async () => button("Dictionary").click());
      return page;
    }

    test("adds the word typed, tidied, and empties the field", async () => {
      const page = await open(signedIn);
      expect(button("Add").disabled).toBe(true);

      await act(async () => type(field(), "  Kaelthorne   Draszek "));
      expect(button("Add").disabled).toBe(false);
      await act(async () => button("Add").click());

      expect(page.commands).toEqual([{ type: "addDictionaryWord", word: "Kaelthorne Draszek" }]);
      expect(field().value).toBe("");
      expect(field().maxLength).toBe(config.dictionaryWordMaxChars);
    });

    test.each(["Xy<vora", "one two three four five six seven"])("refuses %j, saying why", async (word) => {
      const page = await open(signedIn);
      await act(async () => type(field(), word));
      expect(button("Add").disabled).toBe(true);
      expect(document.querySelector(".error")?.textContent).toContain(`up to ${config.dictionaryWordMaxWords} words`);
      await act(async () => field().form?.requestSubmit());
      expect(page.commands).toEqual([]);
    });

    /** The typed words on top, then the learned ones, each alphabetically whatever the case (owner,
     * 2026-10-02), neither in the order added nor by last use. */
    test("lists the words, typed first, the learned ones tagged, each with a remove button", async () => {
      const page = await open({
        ...signedIn,
        dictionary: [
          { word: "TabMail", learned: true, lastUsed: 4 },
          { word: "Xyvora", learned: false, lastUsed: 5 },
          { word: "Brevalle", learned: true, lastUsed: 2 },
          { word: "Kaelthorne Draszek", learned: false, lastUsed: 7 },
          { word: "ostrava", learned: true, lastUsed: 3 },
          { word: "zivora", learned: false, lastUsed: 1 },
          { word: "Aldrin", learned: false, lastUsed: 6 },
        ],
      });
      expect(words()).toEqual(["AldrinRemove", "Kaelthorne DraszekRemove", "XyvoraRemove", "zivoraRemove", "Brevalle LearnedRemove", "ostrava LearnedRemove", "TabMail LearnedRemove"]);
      expect(visibleText()).not.toContain("No words yet.");

      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove TabMail"]')?.click());

      expect(page.commands).toEqual([{ type: "removeDictionaryWord", word: "TabMail" }]);
    });

    /** A full dictionary of `typed` typed words, then learned ones. */
    const full = (typed: number) =>
      Array.from({ length: config.dictionaryMaxEntries }, (_, index) =>
        index < typed ? { word: `word${index}`, learned: false, lastUsed: index + 1 } : { word: `learned${index}`, learned: true, lastUsed: index + 1 },
      );

    /** At the typed cap a new word is refused with the reason, and so is a learned word typed again
     * (`AppSettings.addWord`); a typed word can still be typed again. */
    test("typed words at their cap take no new word", async () => {
      const page = await open({ ...signedIn, dictionary: full(config.dictionaryMaxTypedWords) });

      for (const word of ["Xyvora", `LEARNED${config.dictionaryMaxTypedWords}`]) {
        await act(async () => type(field(), word));
        expect(button("Add").disabled).toBe(true);
        expect(document.querySelector(".error")?.textContent).toBe(`You can add up to ${config.dictionaryMaxTypedWords} words. Remove one to add another.`);
        await act(async () => field().form?.requestSubmit());
        expect(page.commands).toEqual([]);
        expect(field().value).toBe(word);
      }

      await act(async () => type(field(), "WORD3"));
      expect(button("Add").disabled).toBe(false);
      expect(document.querySelector(".error")).toBeNull();
      await act(async () => button("Add").click());
      expect(page.commands).toEqual([{ type: "addDictionaryWord", word: "WORD3" }]);
    });

    /** Below the typed cap a learned word makes room for a typed one: a full dictionary takes a new
     * word, and a learned word typed again. */
    test("a full dictionary below the typed cap takes a new word", async () => {
      const page = await open({ ...signedIn, dictionary: full(config.dictionaryMaxTypedWords - 1) });

      for (const word of ["Xyvora", `LEARNED${config.dictionaryMaxTypedWords}`]) {
        await act(async () => type(field(), word));
        expect(button("Add").disabled).toBe(false);
        expect(document.querySelector(".error")).toBeNull();
        await act(async () => button("Add").click());
      }
      expect(page.commands).toEqual([
        { type: "addDictionaryWord", word: "Xyvora" },
        { type: "addDictionaryWord", word: `LEARNED${config.dictionaryMaxTypedWords}` },
      ]);
    });

    test("the learning switch sends the choice, and shows only where corrections can be learned", async () => {
      const page = await open(signedIn);
      expect(toggle("Learn from my corrections").checked).toBe(true);
      expect(visibleText()).toContain(`For ${config.correctionWatchDuration / 1000} seconds after a dictation`);
      await act(async () => toggle("Learn from my corrections").click());
      expect(page.commands).toEqual([{ type: "setLearnsWords", value: false }]);

      await open({ ...signedIn, canLearnWords: false });
      expect(visibleText()).not.toContain("Learn from my corrections");
    });
  });

  /** Settings › Privacy: the apps the screen is never read in (owner, 2026-09-30). */
  describe("privacy", () => {
    const apps = (): string[] => [...document.querySelectorAll('ul[aria-label="Excluded apps"] li')].map((item) => item.textContent ?? "");
    const excluded = [{ bundleIdentifier: "org.example.bank", name: "Example Bank" }, { bundleIdentifier: "org.example.notes", name: "Example Notes" }];

    async function open(initial: SettingsState, reply: CommandResult = { error: null }): Promise<{ commands: Command[] }> {
      const page = await settingsPage(reply, initial, initial);
      await act(async () => button("Privacy").click());
      return page;
    }

    test("names every built-in password manager, and says what excluding does", async () => {
      await open(signedIn);
      const text = visibleText();
      for (const app of config.builtInExcludedApps) expect(text).toContain(app.name);
      expect(text).toContain("never reads the screen");
      expect(text).toContain("Dictation still works there.");
      expect(text).toContain("No apps added yet.");
    });

    test("names only the password managers supported by this platform", async () => {
      await open({ ...signedIn, builtInExcludedApps: config.windowsBuiltInExcludedApps });
      for (const name of ["1Password", "Bitwarden", "KeePassXC", "NordPass"]) expect(visibleText()).toContain(name);
      expect(visibleText()).not.toContain("Keychain Access");
      expect(visibleText()).not.toContain("1Password 7");
    });

    test("lists the apps the user added, each with a remove button that sends its identifier", async () => {
      const page = await open({ ...signedIn, excludedApps: excluded });
      expect(apps()).toEqual(["Example BankRemove", "Example NotesRemove"]);
      expect(visibleText()).not.toContain("No apps added yet.");

      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove Example Notes"]')?.click());

      expect(page.commands).toEqual([{ type: "removeExcludedApp", bundleIdentifier: "org.example.notes" }]);
    });

    test("Add App… asks the main process to pick one, and shows why it couldn't be added", async () => {
      const page = await open(signedIn);
      await act(async () => button("Add App…").click());
      expect(page.commands).toEqual([{ type: "excludeApp" }]);
      expect(document.querySelector(".error")).toBeNull();

      await open(signedIn, { error: "That app can't be excluded." });
      await act(async () => button("Add App…").click());
      expect(document.querySelector("main > div:not([hidden]) .error")?.textContent).toBe("That app can't be excluded.");
    });

    /** A list at its bound is refused by the main process, with the reason: the pane keeps asking,
     * and lists every app (owner, 2026-10-01). */
    test("a full list of apps still asks for an app, and shows why it was refused", async () => {
      const full = Array.from({ length: config.exclusionsMax }, (_, index) => ({ bundleIdentifier: `org.example.app${index}`, name: `App ${index}` }));
      const page = await open({ ...signedIn, excludedApps: full }, { error: "Remove one to add another." });
      expect(apps()).toHaveLength(config.exclusionsMax);
      expect(visibleText()).not.toContain("At most");
      expect(button("Add App…").disabled).toBe(false);
      await act(async () => button("Add App…").click());
      expect(page.commands).toEqual([{ type: "excludeApp" }]);
      expect(document.querySelector("main > div:not([hidden]) .error")?.textContent).toBe("Remove one to add another.");
    });

    /** The warning goes once the app is saved, by picking it again. */
    test("an app's warning is gone once a later try is saved", async () => {
      const reply = { error: "This couldn't be saved, so it is not excluded." as string | null };
      const page = await open({ ...signedIn, excludedApps: excluded }, reply);
      const warning = () => document.querySelector("main > div:not([hidden]) .error")?.textContent ?? null;
      await act(async () => button("Add App…").click());
      expect(warning()).toBe("This couldn't be saved, so it is not excluded.");

      reply.error = null;
      await act(async () => button("Add App…").click());
      expect(page.commands).toEqual([{ type: "excludeApp" }, { type: "excludeApp" }]);
      expect(warning()).toBeNull();
      expect(visibleText()).toContain("Example Bank");
    });

    test("a removal that could not be saved shows why", async () => {
      await open({ ...signedIn, excludedApps: excluded }, { error: "This couldn't be saved, so it is still excluded." });
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove Example Notes"]')?.click());
      expect(document.querySelector("main > div:not([hidden]) .error")?.textContent).toBe("This couldn't be saved, so it is still excluded.");
    });

    /** The websites the screen is never read on (ADR-DESK-047). */
    describe("websites", () => {
      const sites = (): string[] => [...document.querySelectorAll('ul[aria-label="Excluded websites"] li')].map((item) => item.textContent ?? "");
      const field = (): HTMLInputElement => document.querySelector<HTMLInputElement>('input[aria-label="Website"]') as HTMLInputElement;
      const add = (): HTMLButtonElement => field().form?.querySelector<HTMLButtonElement>('button[type="submit"]') as HTMLButtonElement;
      const problems = (): string[] => [...(field().closest(".group, section, div")?.parentElement?.querySelectorAll(".error") ?? [])].map((error) => error.textContent ?? "");
      const problem = (): string | null => problems()[0] ?? null;

      test("names every built-in web vault, and says what excluding does", async () => {
        await open(signedIn);
        const text = visibleText();
        for (const site of config.builtInExcludedSites) expect(text).toContain(site);
        expect(text).toContain("On these websites, and their subdomains, TabMail Voice never reads the screen");
        expect(text).toContain("No websites added yet.");
        expect(add().disabled).toBe(true);
        expect(field().maxLength).toBe(config.excludedSiteInputMaxLength);
      });

      test("adds the host of what was typed, and clears the field", async () => {
        const page = await open(signedIn);
        await act(async () => type(field(), "https://Mail.Example.com/inbox"));
        expect(add().disabled).toBe(false);
        await act(async () => field().form?.requestSubmit());
        expect(page.commands).toEqual([{ type: "excludeSite", site: "mail.example.com" }]);
        expect(field().value).toBe("");
      });

      test("shows why a website could not be added or removed, until the next try, beside what is wrong with what is typed", async () => {
        const reply = { error: "This couldn't be saved, so it is not excluded." as string | null };
        await open({ ...signedIn, excludedSites: ["mail.example.org"] }, reply);
        expect(problem()).toBeNull();
        await act(async () => type(field(), "example.com"));
        await act(async () => field().form?.requestSubmit());
        expect(problem()).toBe("This couldn't be saved, so it is not excluded.");
        expect(field().value).toBe("");

        await act(async () => type(field(), "not a site"));
        expect(problems()).toEqual(["A website’s address, like example.com.", "This couldn't be saved, so it is not excluded."]);

        reply.error = "This couldn't be saved, so it is still excluded.";
        await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove mail.example.org"]')?.click());
        expect(problems()).toEqual(["A website’s address, like example.com.", "This couldn't be saved, so it is still excluded."]);
        await act(async () => type(field(), ""));
        expect(problems()).toEqual(["This couldn't be saved, so it is still excluded."]);

        reply.error = null;
        await act(async () => type(field(), "example.com"));
        await act(async () => field().form?.requestSubmit());
        expect(problem()).toBeNull();
      });

      test.each(["not a site", "localhost"])("refuses %j, saying why", async (typed) => {
        const page = await open(signedIn);
        await act(async () => type(field(), typed));
        expect(add().disabled).toBe(true);
        expect(problem()).toBe("A website’s address, like example.com.");
        await act(async () => field().form?.requestSubmit());
        expect(page.commands).toEqual([]);
        expect(field().value).toBe(typed);
      });

      test("lists the sites the user added, each with a remove button that sends its host", async () => {
        const page = await open({ ...signedIn, excludedSites: ["example.com", "mail.example.org"] });
        expect(sites()).toEqual(["example.comRemove", "mail.example.orgRemove"]);
        expect(visibleText()).not.toContain("No websites added yet.");

        await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove mail.example.org"]')?.click());

        expect(page.commands).toEqual([{ type: "removeExcludedSite", host: "mail.example.org" }]);
      });

      /** As for apps: the main process refuses at the bound, and the pane shows why. */
      test("a full list of websites still sends a website, and shows why it was refused", async () => {
        const full = Array.from({ length: config.exclusionsMax }, (_, index) => `site${index}.example.com`);
        const page = await open({ ...signedIn, excludedSites: full }, { error: "Remove one to add another." });
        await act(async () => type(field(), "example.org"));
        expect(add().disabled).toBe(false);
        expect(problem()).toBeNull();
        await act(async () => field().form?.requestSubmit());
        expect(page.commands).toEqual([{ type: "excludeSite", site: "example.org" }]);
        expect(problems()).toEqual(["Remove one to add another."]);
      });
    });

    test("the section shows only where apps can be excluded", async () => {
      await settingsPage({ error: null }, signedIn, { ...signedIn, canExcludeApps: false });
      expect([...document.querySelectorAll("button.nav")].map((nav) => nav.textContent)).not.toContain("Privacy");
      expect(document.body.textContent).not.toContain("Excluded apps");

      await settingsPage({ error: null }, signedIn, signedIn);
      expect([...document.querySelectorAll("button.nav")].map((nav) => nav.textContent)).toContain("Privacy");
    });
  });

  /** A sign-out the credential store only half did is said, not swallowed (owner, 2026-09-27). */
  test("Sign Out shows what the sign-out reply says", async () => {
    const warning = "Signed out, but your saved sign-in couldn't be removed.";
    const page = await settingsPage({ error: warning }, { ...signedIn, email: null });

    await act(async () => button("Sign Out").click());

    expect(page.commands).toEqual([{ type: "signOut" }]);
    expect(document.querySelector(".error")?.textContent).toBe(warning);
  });

  test("a sign-out that worked shows nothing more", async () => {
    await settingsPage({ error: null }, { ...signedIn, email: null });

    await act(async () => button("Sign Out").click());

    expect(document.querySelector(".error")).toBeNull();
    expect(button("Email Me a Code")).toBeDefined();
  });

  /** The sidebar shows one section at a time, Account first: each section shows its own settings
   * and none of another's, and every setting is in one of them. */
  test("each section in the sidebar shows its own settings", async () => {
    const own: Record<string, string[]> = {
      Account: ["Sign Out"],
      Dictation: ["Hold to dictate", "Read the screen while dictating"],
      Dictionary: ["No words yet.", "Learn from my corrections"],
      "Agent mode": ["Your name", "Edit", "Compose", "Answer"],
      Privacy: ["Excluded apps", "No apps added yet.", "Password managers are always excluded", "Excluded websites", "No websites added yet.", "Password managers’ websites are always excluded"],
      Permissions: ["Microphone", "Accessibility"],
      General: ["Open at login", "Debug mode", "Version", "1.2.3", "Check for Updates…"],
    };
    const shown = { ...signedIn, debugAllowed: true };
    await settingsPage({ error: null }, shown, shown);
    expect(document.querySelector("h1")?.textContent).toBe("Account");
    expect([...document.querySelectorAll("button.nav.selected")]).toEqual([button("Account")]);

    for (const [section, settings] of Object.entries(own)) {
      await act(async () => button(section).click());
      expect(document.querySelector("h1")?.textContent).toBe(section);
      expect(button(section).getAttribute("aria-current")).toBe("page");
      expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      // Highlighted, not only announced: the one `.selected` section is this one.
      expect([...document.querySelectorAll("button.nav.selected")]).toEqual([button(section)]);
      const visible = visibleText();
      for (const setting of settings) expect(visible, `${section} shows ${setting}`).toContain(setting);
      for (const [other, theirs] of Object.entries(own)) {
        if (other === section) continue;
        for (const setting of theirs) expect(visible, `${section} hides ${other}'s ${setting}`).not.toContain(setting);
      }
    }
  });

  /** A section with something to do (signed out, a permission missing, VS Code's settings hiding the
   * caret) is marked in the sidebar,
   * with a mark a screen reader announces (an image with a label, not a bare dot). */
  test("the sidebar marks the sections that need the user", async () => {
    const marked = () => [...document.querySelectorAll("button.nav")].filter((nav) => nav.querySelector('[role="img"][aria-label="Needs attention"]')).map((nav) => nav.textContent);

    await settingsPage({ error: null }, signedIn);
    expect(marked()).toEqual([]);

    await settingsPage({ error: null }, signedIn, { ...signedIn, email: null, microphoneGranted: false });
    expect(marked()).toEqual(["Account", "Permissions"]);

    await settingsPage({ error: null }, signedIn, { ...signedIn, accessibilityTrusted: false });
    expect(marked()).toEqual(["Permissions"]);

    await settingsPage({ error: null }, signedIn, { ...signedIn, vscodeFix: "needed" });
    expect(marked()).toEqual(["Permissions"]);

    await settingsPage({ error: null }, signedIn, { ...signedIn, vscodeFix: "done" });
    expect(marked()).toEqual([]);

    // No name for agent mode: never set, cleared, or blank.
    for (const userName of [null, "", "  "]) {
      await settingsPage({ error: null }, signedIn, { ...signedIn, userName });
      expect(marked()).toEqual(["Agent mode"]);
    }
  });

  /** Agent mode's name field shows the stored name, or, with none, is empty with the computer
   * account's name as its placeholder and a note inviting one; typing sends it as typed. */
  test("agent mode's name field shows the name and sends what the user types", async () => {
    const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Your name"]') as HTMLInputElement;
    const set = "Sent to TabMail with agent mode’s requests, so it knows which messages on screen are yours. TabMail doesn’t keep it.";
    const invite = "Add your name so agent mode knows which messages on screen are yours, and a reply goes to the other person, not back to you. It’s sent to TabMail with agent mode’s requests, and TabMail doesn’t keep it.";

    await settingsPage({ error: null }, signedIn);
    await act(async () => button("Agent mode").click());
    expect(field().value).toBe("Alex Example");
    expect(visibleText()).toContain(set);
    expect(visibleText()).not.toContain(invite);

    const page = await settingsPage({ error: null }, { ...signedIn, userName: "Sam" }, { ...signedIn, userName: null });
    await act(async () => button("Agent mode").click());
    expect(field().value).toBe("");
    expect(field().placeholder).toBe("Alex Example");
    expect(visibleText()).toContain(invite);
    await act(async () => type(field(), "Sam"));
    expect(page.commands).toEqual([{ type: "setUserName", value: "Sam" }]);
    expect(field().value).toBe("Sam");
    expect(visibleText()).toContain(set);

    await settingsPage({ error: null }, signedIn, { ...signedIn, userName: null, suggestedName: "" });
    expect(field().placeholder).toBe("Your name");
  });

  /** When VS Code's settings hide the caret, Permissions (the section marked for it) and no other
   * section has a VS Code row whose Fix Settings sends `fixVSCodeSettings`, and which shows them
   * fixed once they are; otherwise it doesn't mention VS Code. */
  test("Permissions offers to fix VS Code's settings only when they need it", async () => {
    const page = await settingsPage({ error: null }, { ...signedIn, vscodeFix: "done" }, { ...signedIn, vscodeFix: "needed" });
    for (const section of ["Account", "Dictation", "Agent mode", "General"]) {
      await act(async () => button(section).click());
      expect(visibleText()).not.toContain("VS Code");
    }
    await act(async () => button("Permissions").click());
    const row = () => [...document.querySelectorAll("main > div:not([hidden]) .row")].find((candidate) => candidate.firstElementChild?.textContent === "VS Code");
    expect(row()?.querySelector("button")?.textContent).toBe("Fix Settings");
    await act(async () => button("Fix Settings").click());
    expect(page.commands).toEqual([{ type: "fixVSCodeSettings" }]);
    expect(row()?.textContent).toContain("✓ Fixed");
    expect(row()?.querySelector("button")).toBeNull();

    await settingsPage({ error: null }, signedIn);
    expect(document.body.textContent).not.toContain("VS Code");
  });

  /** Each switch sends its own setting with the value it was switched to. */
  test("each switch sends its setting", async () => {
    const shown = { ...signedIn, readsScreen: false, openAtLogin: true, debugAllowed: true, debugMode: false };
    const page = await settingsPage({ error: null }, shown, shown);

    await act(async () => toggle("Read the screen while dictating").click());
    await act(async () => toggle("Open at login").click());
    await act(async () => toggle("Debug mode").click());

    expect(page.commands).toEqual([
      { type: "setReadsScreen", value: true },
      { type: "setOpenAtLogin", value: false },
      { type: "setDebugMode", value: true },
    ]);
  });

  test("the hotkey menu contains only the keys supported on this platform", async () => {
    const shown: SettingsState = { ...signedIn, hotkey: "rightControl", availableHotkeys: ["rightControl"] };
    await settingsPage({ error: null }, shown, shown);
    const choices = [...menu("Hold to dictate").options].map((option) => option.value);
    expect(choices).toEqual(["rightControl"]);
  });

  /** Every other control sends its own command: each menu its choice, each Allow… its own
   * permission's request, and Sign In the email and the code typed. (The email app's menu, hidden
   * with the Thunderbird tool, sent its choice, Default as none: ADR-DESK-037.) */
  test("each menu, Allow… and Sign In sends its command", async () => {
    const shown: SettingsState = {
      ...signedIn,
      email: null,
      systemEmailApp: { bundleIdentifier: "com.example.default", name: "Default Mail" },
      installedEmailApps: [{ bundleIdentifier: "com.example.mail", name: "Example Mail" }],
      microphoneGranted: false,
      accessibilityTrusted: false,
    };
    const page = await settingsPage({ error: null }, shown, shown);

    await act(async () => pick(menu("Hold to dictate"), "function"));
    await act(async () => allow("Accessibility (hotkey and typing)").click());
    await act(async () => allow("Microphone").click());
    const email = document.querySelector<HTMLInputElement>('input[type="email"]');
    if (!email) throw new Error("no email field");
    await act(async () => type(email, "person@example.com"));
    await act(async () => button("Email Me a Code").click());
    const code = document.querySelector<HTMLInputElement>('input[placeholder="Code"]');
    if (!code) throw new Error("no code field");
    await act(async () => type(code, "123456"));
    await act(async () => button("Sign In").click());

    expect(page.commands).toEqual([
      { type: "setHotkey", hotkey: "function" },
      { type: "requestAccessibility" },
      { type: "requestMicrophone" },
      { type: "sendCode", email: "person@example.com" },
      { type: "verify", email: "person@example.com", code: "123456" },
    ]);
  });

  /** Only on macOS, where the window is frosted under inset traffic lights, is the page clear with
   * its sidebar the title bar (`.mac`); elsewhere the page has its own color. */
  test("the page is styled for the Mac only on a Mac", async () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get");
    userAgent.mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron");
    await settingsPage({ error: null }, signedIn);
    expect(document.querySelector(".settings")?.classList.contains("mac")).toBe(true);

    userAgent.mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron");
    await settingsPage({ error: null }, signedIn);
    expect(document.querySelector(".settings")).not.toBeNull();
    expect(document.querySelector(".settings")?.classList.contains("mac")).toBe(false);
  });

  /** Every color `settings/index.css` reads is there: declared by a stylesheet, or set on the page by
   * `settings/index.tsx` from the brand and the config (a missing gradient would leave the chosen
   * section's white label on white). */
  test("the page provides every color its stylesheet reads", async () => {
    const stylesheet = (name: string) => readFileSync(join(import.meta.dirname, "../../../src/renderer", name), "utf8");
    const settingsCSS = stylesheet("settings/index.css");
    const declared = new Set([...(settingsCSS + stylesheet("shared/form.css")).matchAll(/(--[\w-]+)\s*:/g)].map(([, name = ""]) => name));
    const read = new Set([...settingsCSS.matchAll(/var\((--[\w-]+)\)/g)].map(([, name = ""]) => name));
    await settingsPage({ error: null }, signedIn);
    const page = document.querySelector<HTMLElement>(".settings");
    if (!page) throw new Error("no page");
    const provided: Record<string, string> = {
      "--brand-gradient": brandGradient,
      "--brand-text-gradient": brandTextGradient,
      "--brand-blue": brandBlue,
      "--window-light": config.settingsWindowColor.light,
      "--window-dark": config.settingsWindowColor.dark,
    };

    expect(read.size).toBeGreaterThan(0);
    for (const name of read) {
      if (declared.has(name)) continue;
      expect(provided[name], name).toBeDefined();
      expect(page.style.getPropertyValue(name).trim(), name).toBe(provided[name]);
    }
    for (const name of Object.keys(provided)) expect(read.has(name), name).toBe(true);
  });

  /** The sidebar says who is signed in, or that no one is. */
  test("the sidebar names the account", async () => {
    const account = () => document.querySelector(".identity-account")?.textContent;
    await settingsPage({ error: null }, signedIn);
    expect(account()).toBe("person@example.com");

    await settingsPage({ error: null }, signedIn, { ...signedIn, email: null });
    expect(account()).toBe("Not signed in");
  });

  /** A screen reader announces each switch as a switch, by its label. */
  test("the switches are announced as switches", async () => {
    const shown = { ...signedIn, debugAllowed: true };
    await settingsPage({ error: null }, shown, shown);

    for (const label of ["Read the screen while dictating", "Open at login", "Debug mode"]) expect(toggle(label).getAttribute("role")).toBe("switch");
  });

  /** Under the version, the menu's update item as a button: Check for Updates, disabled while a
   * check or download runs, Restart to Update once one is ready; none where the app doesn't update
   * itself. */
  test("the update button checks, waits, and restarts to update", async () => {
    const updateButton = () => [...document.querySelectorAll("main .row")].find((row) => row.firstElementChild?.textContent === "Updates")?.querySelector("button") ?? undefined;
    const cases: [SettingsState["update"], string | null, boolean, Command | null][] = [
      [{ kind: "idle" }, "Check for Updates…", false, { type: "checkForUpdates" }],
      [{ kind: "checking" }, "Checking for Updates…", true, null],
      [{ kind: "downloading", version: "2.0.0" }, "Downloading Version 2.0.0…", true, null],
      [{ kind: "ready", version: "2.0.0" }, "Restart to Update to Version 2.0.0", false, { type: "restartToUpdate" }],
      [null, null, false, null],
    ];
    for (const [update, label, disabled, command] of cases) {
      const shown = { ...signedIn, update };
      const page = await settingsPage({ error: null }, shown, shown);
      await act(async () => button("General").click());
      const shownButton = updateButton();
      if (label === null) {
        expect(shownButton).toBeUndefined();
        expect(visibleText()).not.toContain("Updates");
        continue;
      }
      expect(shownButton?.textContent).toBe(label);
      expect(shownButton?.disabled).toBe(disabled);
      await act(async () => shownButton?.click());
      expect(page.commands).toEqual(command ? [command] : []);
    }
  });

  /** Debug mode is offered, under General, only to an account allowed it. */
  test("Debug mode shows only when allowed", async () => {
    await settingsPage({ error: null }, signedIn, { ...signedIn, debugAllowed: true });
    await act(async () => button("General").click());
    expect(visibleText()).toContain("Debug mode");

    await settingsPage({ error: null }, signedIn);
    await act(async () => button("General").click());
    expect(visibleText()).not.toContain("Debug mode");
  });

  /** Under the hotkey: the Globe note when applicable, direct agent mode, and recording privacy. */
  test("the hotkey's notes", async () => {
    const globe = "While fn is the hotkey";
    const directAgent = "Hold Shift with your dictation key to start agent mode directly. Press Space while dictating to switch modes.";
    const recording = "Your recording is sent to TabMail for transcription and isn’t stored.";
    const notes = () => [...document.querySelectorAll("main > div:not([hidden]) .card-section")].find((card) => card.textContent?.includes("Hold to dictate"))?.querySelectorAll(".group-caption");

    await settingsPage({ error: null }, signedIn, { ...signedIn, hotkey: "function" });
    await act(async () => button("Dictation").click());
    expect([...(notes() ?? [])].map((note) => note.textContent?.slice(0, globe.length))).toEqual([globe, directAgent.slice(0, globe.length), recording.slice(0, globe.length)]);

    await settingsPage({ error: null }, signedIn);
    await act(async () => button("Dictation").click());
    expect([...(notes() ?? [])].map((note) => note.textContent)).toEqual([directAgent, recording]);
  });

  /** A sign-in half done, or a sign-out warning, is still there after a look at another section. */
  test("the account's progress outlives a switch of section", async () => {
    const signedOut = { ...signedIn, email: null };
    await settingsPage({ error: null }, signedOut, signedOut);
    const email = document.querySelector<HTMLInputElement>('input[type="email"]');
    if (!email) throw new Error("no email field");
    await act(async () => type(email, "person@example.com"));
    await act(async () => button("Email Me a Code").click());
    expect(visibleText()).toContain("Enter the code we emailed to person@example.com.");

    await act(async () => button("Permissions").click());
    await act(async () => button("Account").click());
    expect(visibleText()).toContain("Enter the code we emailed to person@example.com.");

    const warning = "Signed out, but your saved sign-in couldn't be removed.";
    await settingsPage({ error: warning }, signedOut);
    await act(async () => button("Sign Out").click());
    await act(async () => button("General").click());
    await act(async () => button("Account").click());
    expect(document.querySelector(".error")?.textContent).toBe(warning);
  });

  /** A switch's note is text to read: clicking (or selecting) it changes nothing. */
  test("clicking a switch's note sends nothing", async () => {
    const shown = { ...signedIn, debugAllowed: true };
    const page = await settingsPage({ error: null }, shown, shown);

    for (const note of document.querySelectorAll<HTMLElement>(".toggle .caption")) await act(async () => note.click());

    // Screen reading, learning the user's corrections, debug mode and the three agent tools.
    expect(document.querySelectorAll(".toggle .caption")).toHaveLength(6);
    expect(page.commands).toEqual([]);
  });

  /** Each agent tool offered has a switch in Agent mode, on as the state says, which turns it on or
   * off. Thunderbird's has none, nor has the email app it sends to, until its native connector
   * (ADR-DESK-037). */
  test("each agent tool has a switch", async () => {
    const shown: SettingsState = { ...signedIn, enabledTools: ["edit", "answer"] };
    const page = await settingsPage({ error: null }, shown, shown);
    await act(async () => button("Agent mode").click());

    const labels = ["Edit", "Compose", "Answer"];
    expect(labels.map((label) => toggle(label).checked)).toEqual([true, false, true]);
    for (const label of labels) await act(async () => toggle(label).click());

    expect(page.commands).toEqual([
      { type: "setAgentToolEnabled", tool: "edit", value: false },
      { type: "setAgentToolEnabled", tool: "compose", value: true },
      { type: "setAgentToolEnabled", tool: "answer", value: false },
    ]);
    expect(document.body.textContent).not.toContain("Thunderbird");
    expect(document.body.textContent).not.toContain("Email app");
  });

  /** On a Mac, each app the Answer tool reaches has a switch among the tools, all in alphabetical
   * order (owner, 2026-09-28), on as the state says, which turns it on or off; elsewhere there are
   * none. */
  test("each app the Answer tool reaches has a switch, in alphabetical order with the tools", async () => {
    const shown: SettingsState = { ...signedIn, connectors: ["calendar", "reminders"], enabledConnectors: ["reminders"] };
    const page = await settingsPage({ error: null }, shown, shown);
    await act(async () => button("Agent mode").click());

    // The switches with an icon: the agent pane's.
    const labels = [...document.querySelectorAll(".toggle")].filter((row) => row.querySelector("svg")).map((row) => row.querySelector("label")?.textContent);
    expect(labels).toEqual(["Answer", "Calendar", "Compose", "Edit", "Reminders"]);
    expect(["Calendar", "Reminders"].map((label) => toggle(label).checked)).toEqual([false, true]);
    for (const label of ["Calendar", "Reminders"]) await act(async () => toggle(label).click());

    expect(page.commands).toEqual([
      { type: "setConnectorEnabled", connector: "calendar", value: true },
      { type: "setConnectorEnabled", connector: "reminders", value: false },
    ]);
  });

  /** The notes are the Swift app's (typographic apostrophes aside) and no others: every state's
   * notes, in each email-app case, with fn the hotkey and debug mode allowed. The redesign once
   * invented notes, one of them untrue. With the Thunderbird tool not offered (ADR-DESK-037), neither
   * its note nor the email app's shows, in any case. */
  test("the notes are the Swift app's", async () => {
    const notes = () => [...document.querySelectorAll("main .caption")].map((note) => note.textContent);
    const always = [
      // Owner-requested direct agent shortcut extends the original Swift UI.
      "Hold Shift with your dictation key to start agent mode directly. Press Space while dictating to switch modes.",
      "While fn is the hotkey, the 🌐 key’s own action in Keyboard settings is set to “Do Nothing”. Your choice comes back when you pick another key or quit.",
      "Your recording is sent to TabMail for transcription and isn’t stored.",
      "Sends the text in the window in front with your dictation, so names and terms are spelled as they appear there. It isn’t stored.",
      "Uses the development server and shows debug items in the menu.",
      "Rewrites the text you selected, as you ask: friendlier, shorter, translated, fixed.",
      "Writes new text where your cursor is: a reply, a message, a note, a command.",
      "Answers you in a chat window beside the app. Hold the key again while it’s open to follow up; your earlier requests and its replies go with the follow-up and aren’t stored.",
      "Sent to TabMail with agent mode’s requests, so it knows which messages on screen are yours. TabMail doesn’t keep it.",
      "Names and terms spelled your way, kept on this computer. They’re sent with each dictation so they come out right, and TabMail doesn’t keep them.",
      "No words yet.",
      `For ${config.correctionWatchDuration / 1000} seconds after a dictation, watches the text field it went into. When you correct how a word or name was spelled, the new spelling is added here. Learned words fill the room your own words leave, up to ${config.dictionaryMaxEntries} in all, and the one used least recently makes way for a new one. The field’s text stays on this computer, and a password field is never read.`,
      // Privacy's, which the Swift app never had (owner, 2026-09-30).
      "In these apps TabMail Voice never reads the screen: nothing in their windows is sent with a dictation or used to learn a spelling. Dictation still works there.",
      `Password managers are always excluded: ${config.builtInExcludedApps.map((app) => app.name).join(", ")}.`,
      "No apps added yet.",
      // The websites', which the Swift app never had either (owner, 2026-10-01).
      "On these websites, and their subdomains, TabMail Voice never reads the screen, whichever browser they are open in.",
      `Password managers’ websites are always excluded: ${config.builtInExcludedSites.join(", ")}.`,
      "No websites added yet.",
    ];
    const cases: [Partial<SettingsState>, string][] = [
      [{ hasTabMail: false }, "TabMail’s add-on isn’t installed in Thunderbird, so mail and calendar requests aren’t offered."],
      [{ hasTabMail: true, emailClient: null, defaultEmailAppIsSupported: false }, "Mail and calendar requests need Thunderbird with TabMail. Choose it here, or make it your default email app."],
      [{ hasTabMail: true, emailClient: null, defaultEmailAppIsSupported: true }, "Mail and calendar requests go to TabMail’s chat in this app."],
    ];
    for (const [emailApp] of cases) {
      await settingsPage({ error: null }, signedIn, { ...signedIn, hotkey: "function", debugAllowed: true, ...emailApp });
      expect(notes().sort()).toEqual([...always].sort());
    }
  });
});


describe("GNOME integration", () => {
  test("Enable sends its command, then explains Space and Escape when ready", async () => {
    const initial: SettingsState = { ...signedIn, gnomeIntegration: "available" };
    const ready: SettingsState = { ...signedIn, gnomeIntegration: "ready" };
    const page = await settingsPage({ error: null }, ready, initial);
    await act(async () => button("Permissions").click());
    expect(visibleText()).toContain("Space to switch mode");
    await act(async () => button("Enable").click());
    expect(page.commands).toContainEqual({ type: "enableGnomeIntegration" });
    expect(visibleText()).toContain("Press Space while dictating");
    expect(visibleText()).toContain("Escape to cancel");
    expect(visibleText()).toContain("✓ Enabled");
    expect(visibleText()).not.toContain("Shift");
  });

  test.each(["restart", "unavailable", "unsupported", "checking"] as const)("%s does not report the integration enabled", async (state) => {
    const initial: SettingsState = { ...signedIn, gnomeIntegration: state };
    await settingsPage({ error: null }, initial, initial);
    await act(async () => button("Permissions").click());
    expect(visibleText()).toContain("GNOME integration");
    expect(visibleText()).not.toContain("✓ Enabled");
    expect(button("Enable").disabled).toBe(state === "unsupported" || state === "checking");
    if (state === "restart") expect(visibleText()).toContain("Log out of Ubuntu and back in");
    if (state === "unavailable") expect(visibleText()).toContain("could not be enabled");
  });
});
