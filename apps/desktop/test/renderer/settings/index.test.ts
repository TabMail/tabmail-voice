// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { palette } from "../../../src/core/palette.js";
import { brandBlue, brandTextGradient } from "../../../src/renderer/shared/brand.js";
import { personalizationState } from "../../../src/core/personalization/page.js";
import { UserPrompts } from "../../../src/core/personalization/prompts.js";
import { formatBytes } from "../../../src/core/memory/page.js";
import { fileProblemLine } from "../../../src/core/ui/fileProblems.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";
import type { Command, CommandResult, SettingsState } from "../../../src/shared/ipc.js";

const signedIn: SettingsState = {
  email: "person@example.com",
  hotkey: "rightOption",
  availableHotkeys: ["rightOption", "function"],
  readsScreen: true,
  enabledTools: ["edit", "compose"],
  connectors: [],
  enabledConnectors: [],
  userName: "Alex Example",
  suggestedName: "Alex Example",
  dictionary: [],
  learnsWords: true,
  smartDictation: false,
  optsOutOfAI: false,
  closesChatElsewhere: true,
  eventDuration: 45,
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
  memory: { sizeLimit: config.memorySizeLimitDefault, usage: { docs: 0, usedBytes: 0 }, unavailable: false, query: "", entries: [], searchFailed: null, status: null },
  personalization: {
    writingStyle: [
      { section: "General writing style", bullets: ["ALWAYS start with a greeting."] },
      { section: "Language", bullets: ["I write in English Only."] },
      { section: "Useful links to personal website and other resources", bullets: [] },
    ],
    knowledgeBase: ["Prefers morning meetings.", "Works with Sam."],
    history: [],
  },
  fileProblems: [],
};

/** A file that couldn't be read at launch is said above every section, with how to fix it; none is
 * said while both read (ADR-DESK-063). */
test("a file that couldn't be read is said above every section", async () => {
  await settingsPage({ error: null }, signedIn, signedIn);
  expect(document.querySelectorAll(".file-problem")).toHaveLength(0);
  await settingsPage({ error: null }, signedIn, { ...signedIn, fileProblems: ["settings", "knowledgeBase"] });
  expect([...document.querySelectorAll(".file-problem")].map((line) => line.textContent)).toEqual([fileProblemLine("settings"), fileProblemLine("knowledgeBase")]);
});

/** What the stand-in main process answers: one reply for every command, or one per command. */
type Reply = CommandResult | Promise<CommandResult> | ((command: Command) => CommandResult | Promise<CommandResult>);

/** The Settings page, mounted afresh against a stand-in main process that shows `initial`, answers
 * each command with `reply` and then pushes `after` (as the main process pushes the new state), or
 * what `after` gives at that moment. */
async function settingsPage(reply: Reply, after: SettingsState | (() => SettingsState), initial = signedIn): Promise<{ commands: Command[]; push: (state: SettingsState) => Promise<void> }> {
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
      listener?.(typeof after === "function" ? after() : after);
      return typeof reply === "function" ? reply(command) : reply;
    },
  });
  vi.resetModules();
  await act(async () => {
    await import("../../../src/renderer/settings/index.js");
  });
  await act(async () => listener?.(initial));
  // A state the main process pushes on its own (a change made elsewhere).
  const push = (state: SettingsState) => act(async () => listener?.(state));
  return { commands, push };
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

    test("agent mode's switch for closing the chat on a click elsewhere sends the choice", async () => {
      const page = await open(signedIn);
      expect(toggle("Close the chat when I click elsewhere").checked).toBe(true);
      await act(async () => toggle("Close the chat when I click elsewhere").click());
      expect(page.commands).toEqual([{ type: "setClosesChatElsewhere", value: false }]);
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

  /** Settings › Personalization (ADR-DESK-063): the writing style's sections and the knowledge base
   * as editable lists, Reset, and the history. */
  describe("personalization", () => {
    const language = "Language";
    const field = (label: string) => document.querySelector<HTMLInputElement>(`:is(input, textarea)[aria-label="${label}"]`) as HTMLInputElement;

    async function open(initial: SettingsState = signedIn, reply: Reply = { error: null }): Promise<{ commands: Command[]; push: (state: SettingsState) => Promise<void> }> {
      const page = await settingsPage(reply, initial, initial);
      await act(async () => button("Personalization").click());
      return page;
    }

    /** Each section is shown by its name. */
    test("shows the writing style's sections by name and the knowledge base's items", async () => {
      await open();
      const lists = [...document.querySelectorAll("ul.dictionary")].map((list) => list.getAttribute("aria-label"));
      expect(lists).toEqual(["General writing style", "Language", "Useful links to personal website and other resources", "Knowledge base"]);
      expect(field("Knowledge base, item 2").value).toBe("Works with Sam.");
    });

    const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Personalization"] > [role="tab"]')];
    const tab = (name: string) => tabs().find((element) => element.textContent === name) as HTMLButtonElement;
    /** The panels on show: each tab's panel, named as its tab, hidden unless its tab is chosen. */
    const shownPanels = () => [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter((panel) => !panel.hidden).map((panel) => panel.getAttribute("aria-label"));

    /** Each block is a tab (owner, 2026-10-28: the page was too long): Writing style first and
     * chosen, and only the chosen tab's panel shows, the one its tab names. */
    test("the writing style, knowledge base and history are tabs, one shown at a time", async () => {
      await open();
      expect(tabs().map((element) => element.textContent)).toEqual(["Writing style", "Knowledge base", "History"]);
      for (const name of ["Writing style", "Knowledge base", "History", "Writing style"]) {
        await act(async () => tab(name).click());
        expect(tabs().filter((element) => element.getAttribute("aria-selected") === "true")).toEqual([tab(name)]);
        expect(tabs().map((element) => element.tabIndex)).toEqual(tabs().map((element) => (element === tab(name) ? 0 : -1)));
        expect(shownPanels()).toEqual([name]);
        // Drawn as chosen, not only announced.
        expect([...document.querySelectorAll(".tabs button.tab.selected")]).toEqual([tab(name)]);
        // The tab names its panel by one id (a space would make it a list of two that name nothing).
        const controls = tab(name).getAttribute("aria-controls") ?? "";
        expect(controls).toMatch(/^\S+$/);
        expect(document.getElementById(controls)).toBe(document.querySelector(`[role="tabpanel"][aria-label="${name}"]`));
      }
    });

    /** Each tab keeps what it holds: its captions, and Reset for the writing style and the knowledge
     * base; each writing style section is headed by its name, not by a caption. */
    test("each tab holds its own block, the writing style's sections under headings", async () => {
      await open();
      const panel = (name: string) => document.querySelector(`[role="tabpanel"][aria-label="${name}"]`) as HTMLElement;
      const resets = (name: string) => [...panel(name).querySelectorAll("button")].filter((element) => element.textContent === "Reset…");
      expect([...panel("Writing style").querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["General writing style", "Language", "Useful links to personal website and other resources"]);
      expect(panel("Writing style").textContent).toContain("How agent mode writes for you");
      expect(panel("Knowledge base").textContent).toContain("What agent mode knows and remembers about you");
      expect(panel("Knowledge base").querySelector('ul[aria-label="Knowledge base"]')).not.toBeNull();
      expect(panel("History").textContent).toContain(`Your last ${config.promptHistoryMax} changes`);
      expect(panel("History").textContent).toContain("No changes yet.");
      expect([resets("Writing style").length, resets("Knowledge base").length, resets("History").length]).toEqual([1, 1, 0]);
      const { commands } = await open();
      await act(async () => tab("Knowledge base").click());
      await act(async () => resets("Knowledge base")[0]?.click());
      await act(async () => button("Reset").click());
      expect(commands).toEqual([{ type: "resetKnowledgeBase" }]);
    });

    /** The arrow keys choose the next or previous tab, round the ends, and focus it. */
    test("the arrow keys move between the tabs", async () => {
      await open();
      const press = (key: string) => (document.activeElement ?? tab("Writing style")).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      tab("Writing style").focus();
      for (const [key, chosen] of [["ArrowRight", "Knowledge base"], ["ArrowRight", "History"], ["ArrowRight", "Writing style"], ["ArrowLeft", "History"], ["ArrowLeft", "Knowledge base"]] as const) {
        await act(async () => press(key));
        expect(shownPanels()).toEqual([chosen]);
        expect(document.activeElement).toBe(tab(chosen));
      }
      await act(async () => press("ArrowDown"));
      expect(shownPanels()).toEqual(["Knowledge base"]);
    });

    /** Tab from the chosen tab reaches its panel even with no control in it (a History with nothing
     * in it): each panel is a stop in the Tab order. The previews press a real Tab key. */
    test("each panel is a stop in the Tab order, an empty History too", async () => {
      await open();
      expect(document.body.textContent).toContain("No changes yet.");
      const panels = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
      expect(panels.map((panel) => [panel.getAttribute("aria-label"), panel.tabIndex])).toEqual([
        ["Writing style", 0],
        ["Knowledge base", 0],
        ["History", 0],
      ]);
    });

    /** A tab left and come back to is as it was: what is being typed in it is still there. */
    test("what is being typed stays through a change of tab", async () => {
      const { commands } = await open();
      await act(async () => type(field("Add to Language"), "I also write in French."));
      await act(async () => tab("History").click());
      await act(async () => tab("Writing style").click());
      expect(field("Add to Language").value).toBe("I also write in French.");
      expect(commands).toEqual([]);
    });

    /** A change that couldn't be saved is said until the next change, whichever tab is chosen: a
     * save as a field is left for another tab can fail as that tab is chosen, and must still be said. */
    test("a failure is still said after a change of tab", async () => {
      await open(signedIn, { error: "This couldn't be saved, so nothing changed." });
      await act(async () => tab("Knowledge base").click());
      await act(async () => (document.querySelector('button[aria-label="Remove Knowledge base, item 1"]') as HTMLButtonElement).click());
      expect(visibleText()).toContain("This couldn't be saved, so nothing changed.");
      for (const name of ["History", "Writing style"]) {
        await act(async () => tab(name).click());
        expect(visibleText(), name).toContain("This couldn't be saved, so nothing changed.");
      }
    });

    /** A bullet the user types is capped, as ADR-DESK-063 says: the boundary takes any length, so
     * these fields are the only cap. */
    test("the Settings fields cap a typed bullet", async () => {
      await open();
      expect(field("Add to Knowledge base").maxLength).toBe(config.personalizationBulletMaxLength);
      expect(field("Knowledge base, item 1").maxLength).toBe(config.personalizationBulletMaxLength);
    });

    /** An edit sends the whole list as edited, with the list it was made on, so the main process can
     * keep what changed meanwhile. */
    test("an item edited and left is saved with the list it was made on", async () => {
      const { commands } = await open();
      const item = field("Knowledge base, item 1");
      await act(async () => type(item, "Prefers afternoon meetings."));
      await act(async () => item.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(commands).toEqual([{ type: "editKnowledgeBase", shown: ["Prefers morning meetings.", "Works with Sam."], bullets: ["Prefers afternoon meetings.", "Works with Sam."] }]);
    });

    /** An item edited, then removed with its own Remove: the press focuses Remove first, and the
     * item is removed, with the main process applying each command to the stored knowledge base and
     * pushing the result (a save as focus left the field replaced the row under the press, and the
     * removal was lost). */
    test("an item edited and then removed is removed", async () => {
      const prompts = new UserPrompts(new MemoryStore({ "user_prompts:user_kb.md": "- Prefers morning meetings.\n- Works with Sam." }));
      // The stand-in main process: the command just sent applied to the store, then its state pushed.
      let sent: Command[] = [];
      const page = await settingsPage({ error: null }, () => {
        const command = sent.at(-1);
        if (command?.type === "editKnowledgeBase") prompts.editKnowledgeBase(command.shown, command.bullets);
        return { ...signedIn, personalization: personalizationState(prompts) };
      });
      sent = page.commands;
      await act(async () => button("Personalization").click());
      const item = field("Knowledge base, item 1");
      await act(async () => type(item, "Prefers afternoon meetings."));
      const remove = document.querySelector<HTMLButtonElement>('button[aria-label="Remove Knowledge base, item 1"]') as HTMLButtonElement;
      // Pressing Remove moves focus to it, then it is clicked.
      await act(async () => item.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: remove })));
      await act(async () => remove.click());
      expect(prompts.knowledgeBase).toBe("- Works with Sam.");
    });

    /** The knowledge base changed elsewhere (`kb_add`, `kb_del`) while Settings shows it:
     * each field shows its own bullet, what is being typed in a later field stays, and is saved with
     * the list shown now, and a field left untouched saves nothing. */
    test("a knowledge base changed elsewhere keeps what is being typed", async () => {
      const withKB = (knowledgeBase: string[]): SettingsState => ({ ...signedIn, personalization: { ...signedIn.personalization, knowledgeBase } });
      const { commands, push } = await open(withKB(["Alpha.", "Beta.", "Gamma."]));
      const item = field("Knowledge base, item 3");
      await act(async () => type(item, "Gamma, edited."));

      // One removed before it, then one added before it.
      await push(withKB(["Beta.", "Gamma."]));
      expect([field("Knowledge base, item 1").value, field("Knowledge base, item 2").value]).toEqual(["Beta.", "Gamma, edited."]);
      expect(field("Knowledge base, item 2")).toBe(item);
      await push(withKB(["Zero.", "Beta.", "Gamma."]));
      expect([field("Knowledge base, item 1").value, field("Knowledge base, item 2").value, field("Knowledge base, item 3").value]).toEqual(["Zero.", "Beta.", "Gamma, edited."]);

      await act(async () => field("Knowledge base, item 2").dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(commands).toEqual([]);
      await act(async () => item.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(commands).toEqual([{ type: "editKnowledgeBase", shown: ["Zero.", "Beta.", "Gamma."], bullets: ["Zero.", "Beta.", "Gamma, edited."] }]);
    });

    /** Equal bullets (an Add of one already there stores it twice) are each a row of their own, and a
     * change made elsewhere around them shows exactly the list pushed. */
    test.each([
      [["Alpha.", "Alpha.", "Beta."], ["Gamma.", "Alpha.", "Beta."]],
      [["Alpha.", "Alpha.", "Beta."], ["Alpha.", "Beta."]],
      [["Alpha.", "Beta.", "Alpha."], ["Beta.", "Alpha."]],
      [["Alpha.", "Alpha."], ["Zero.", "Alpha.", "Alpha."]],
    ])("equal bullets %j, changed elsewhere to %j, show as pushed", async (before, after) => {
      const errors: unknown[] = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args[0]));
      const withKB = (knowledgeBase: string[]): SettingsState => ({ ...signedIn, personalization: { ...signedIn.personalization, knowledgeBase } });
      const rows = () => [...document.querySelectorAll<HTMLTextAreaElement>('ul[aria-label="Knowledge base"] textarea')].map((element) => element.value);
      const { push } = await open(withKB(before));
      expect(rows()).toEqual(before);
      await push(withKB(after));
      expect(rows()).toEqual(after);
      // React reports a key shared by two rows.
      expect(errors).toEqual([]);
    });

    /** A bullet is one line: Enter leaves the field, which saves it, rather than breaking the line. */
    test("Enter in an item takes no line break, and saves it", async () => {
      const { commands } = await open();
      const item = field("Knowledge base, item 1");
      await act(async () => item.focus());
      await act(async () => type(item, "Prefers afternoon meetings."));
      expect(commands).toEqual([]);
      const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      await act(async () => item.dispatchEvent(enter));
      expect(enter.defaultPrevented).toBe(true);
      expect(commands).toEqual([{ type: "editKnowledgeBase", shown: ["Prefers morning meetings.", "Works with Sam."], bullets: ["Prefers afternoon meetings.", "Works with Sam."] }]);
    });

    /** An emptied item is sent empty, and the store leaves empty bullets out (`UserPrompts`' test
     * "a knowledge base cleared in Settings stays empty"). */
    test("an item emptied and left is saved empty", async () => {
      const { commands } = await open();
      const item = field("Knowledge base, item 1");
      await act(async () => type(item, "   "));
      expect(commands).toEqual([]);
      await act(async () => item.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(commands).toEqual([{ type: "editKnowledgeBase", shown: ["Prefers morning meetings.", "Works with Sam."], bullets: ["", "Works with Sam."] }]);
    });

    test("Escape puts an item back as it was, and leaving it then saves nothing", async () => {
      const { commands } = await open();
      const item = field("Knowledge base, item 1");
      await act(async () => type(item, "Something else."));
      await act(async () => item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(item.value).toBe("Prefers morning meetings.");
      await act(async () => item.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(commands).toEqual([]);
    });

    /** A bullet another writer stored with a leading space (Thunderbird or iOS) is
     * shown as stored; leaving it untouched saves nothing. */
    test("an item stored with a leading space and left untouched saves nothing", async () => {
      const { commands } = await open({ ...signedIn, personalization: { ...signedIn.personalization, knowledgeBase: [" Alice.", "Works with Sam."] } });
      const item = field("Knowledge base, item 1");
      expect(item.value).toBe(" Alice.");
      await act(async () => item.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(commands).toEqual([]);
    });

    test("an item is removed, and one added at the end", async () => {
      const { commands } = await open();
      await act(async () => (document.querySelector('button[aria-label="Remove Knowledge base, item 1"]') as HTMLButtonElement).click());
      const add = field("Add to Knowledge base");
      await act(async () => type(add, "  Likes short replies.  "));
      await act(async () => (add.form as HTMLFormElement).requestSubmit());
      expect(commands).toEqual([
        { type: "editKnowledgeBase", shown: ["Prefers morning meetings.", "Works with Sam."], bullets: ["Works with Sam."] },
        { type: "editKnowledgeBase", shown: ["Prefers morning meetings.", "Works with Sam."], bullets: ["Prefers morning meetings.", "Works with Sam.", "Likes short replies."] },
      ]);
    });

    test("a writing-style edit names its section", async () => {
      const { commands } = await open();
      const add = field("Add to Language");
      await act(async () => type(add, "I also write in French."));
      await act(async () => (add.form as HTMLFormElement).requestSubmit());
      expect(commands).toEqual([{ type: "editWritingStyle", section: language, shown: ["I write in English Only."], bullets: ["I write in English Only.", "I also write in French."] }]);
    });

    /** Reset asks first, in place; Cancel sends nothing. */
    test("Reset asks before it resets", async () => {
      const { commands } = await open();
      const resets = () => [...document.querySelectorAll("button")].filter((element) => element.textContent === "Reset…");
      await act(async () => resets()[1]?.click());
      await act(async () => button("Cancel").click());
      expect(commands).toEqual([]);
      await act(async () => resets()[1]?.click());
      expect(visibleText()).toContain("Reset your knowledge base to the default?");
      await act(async () => button("Reset").click());
      await act(async () => resets()[0]?.click());
      await act(async () => button("Reset").click());
      expect(commands).toEqual([{ type: "resetKnowledgeBase" }, { type: "resetWritingStyle" }]);
    });

    test("a change that couldn't be saved says so", async () => {
      await open(signedIn, { error: "This couldn't be saved, so nothing changed." });
      await act(async () => (document.querySelector('button[aria-label="Remove Knowledge base, item 1"]') as HTMLButtonElement).click());
      expect(visibleText()).toContain("This couldn't be saved, so nothing changed.");
    });

    /** Each entry shows, opened, what restoring it brings back and takes away; Restore asks first. */
    test("a history entry shows what restoring it changes, and restores once confirmed", async () => {
      const withHistory: SettingsState = {
        ...signedIn,
        personalization: {
          ...signedIn.personalization,
          history: [
            { id: "now", timestamp: new Date().toISOString(), source: "local_edit", fields: ["kb"], restores: [], removes: [] },
            { id: "then", timestamp: new Date(Date.now() - 86_400_000).toISOString(), source: "reset", fields: ["composition", "kb"], restores: ["Likes short replies."], removes: ["Works with Sam."] },
          ],
        },
      };
      const { commands } = await open(withHistory);
      const items = [...document.querySelectorAll('ul[aria-label="History"] > li')];
      expect(items.map((item) => item.querySelector(".history-heading > span")?.textContent)).toEqual([expect.stringMatching(/^Edit .* · Knowledge base$/), expect.stringMatching(/^Reset .* · Writing style, Knowledge base$/)]);

      const show = (item: Element | undefined) => [...(item?.querySelectorAll("button") ?? [])].find((element) => element.textContent === "Show") as HTMLButtonElement;
      await act(async () => show(items[0]).click());
      // An entry that adds and removes no item can still differ (in order, or an item kept twice):
      // it can be restored too.
      expect(items[0]?.textContent).toContain("No items added or removed.");
      expect(([...(items[0]?.querySelectorAll("button") ?? [])].find((element) => element.textContent === "Restore…") as HTMLButtonElement).disabled).toBe(false);

      await act(async () => show(items[1]).click());
      expect(items[1]?.querySelector(".history-restores")?.textContent).toBe("+ Likes short replies.");
      expect(items[1]?.querySelector(".history-removes")?.textContent).toContain("Works with Sam.");
      const restoreFirst = () => ([...(items[1]?.querySelectorAll("button") ?? [])].find((element) => element.textContent === "Restore…") as HTMLButtonElement).click();
      await act(async () => restoreFirst());
      expect(commands).toEqual([]);
      await act(async () => button("Cancel").click());
      expect(commands).toEqual([]);
      await act(async () => restoreFirst());
      await act(async () => button("Restore").click());
      expect(commands).toEqual([{ type: "restorePromptHistory", id: "then" }]);

      // Hide closes the entry again.
      const toggle = items[1]?.querySelector(".history-heading > button") as HTMLButtonElement;
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      await act(async () => toggle.click());
      expect(items[1]?.querySelector(".history-restores")).toBeNull();
      expect(toggle.textContent).toBe("Show");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });
  });

  /** Settings › Memory (ADR-DESK-061): usage against the limit, the limit, the requests kept
   * (searchable, each removable) and Clear All. */
  describe("memory", () => {
    const MB = 1_024 * 1_024;
    const GB = 1_024 * MB;
    const now = Date.now();
    const kept: SettingsState = {
      ...signedIn,
      memory: {
        ...signedIn.memory,
        usage: { docs: 2, usedBytes: 2 * MB },
        entries: [
          { memId: "turn:2", dateMs: now - 60_000, content: "[USER]: What's on Friday?\n\n[AGENT]: The review at 10:00." },
          { memId: "turn:1", dateMs: now - 86_400_000, content: "[USER]: Make this formal\n\n[AGENT]: Replaced the selection:\nThank you." },
        ],
      },
    };
    const withMemory = (memory: Partial<SettingsState["memory"]>): SettingsState => ({ ...kept, memory: { ...kept.memory, ...memory } });
    const searchField = () => document.querySelector<HTMLInputElement>('input[aria-label="Search past requests"]') as HTMLInputElement;
    const clearAll = () => button("Clear All…");
    const sent = (commands: Command[]) => commands.filter((command) => command.type !== "loadMemory");

    async function open(initial: SettingsState, reply: Reply = { error: null }): Promise<{ commands: Command[] }> {
      const page = await settingsPage(reply, initial, initial);
      await act(async () => button("Memory").click());
      return page;
    }

    test("reads memory when the section shows", async () => {
      const { commands } = await open(kept);
      expect(commands).toEqual([{ type: "loadMemory" }]);
    });

    test.each<[string, number, string, number]>([
      ["nothing", 0, "0%", 0],
      ["a quarter of the limit", 256 * MB, "25%", 256 * MB],
      ["more than the limit", 2 * GB, "100%", GB],
    ])("the usage bar shows %s used", async (_, usedBytes, width, now) => {
      await open(withMemory({ usage: { docs: 1, usedBytes }, sizeLimit: GB }));
      const bar = document.querySelector('[role="progressbar"][aria-label="Memory used"]') as HTMLElement;
      expect(bar.getAttribute("aria-valuemax")).toBe(String(GB));
      expect(bar.getAttribute("aria-valuenow")).toBe(String(now));
      expect((bar.querySelector(".usage-fill") as HTMLElement).style.width).toBe(width);
    });

    test("lists each request with what the agent did, the newest first", async () => {
      await open(kept);
      const items = [...document.querySelectorAll('ul[aria-label="Past requests"] li')];
      expect(items).toHaveLength(2);
      expect(items[0]?.textContent).toContain("What's on Friday?");
      expect(items[0]?.textContent).toContain("The review at 10:00.");
      expect(visibleText()).toContain("Memory used: 2 MB of 1 GB");
      expect(visibleText()).toContain("2 requests kept");
    });

    test("a search sends what was typed, trimmed", async () => {
      const { commands } = await open(kept);
      await act(async () => type(searchField(), "  friday review  "));
      await act(async () => button("Search").click());
      expect(sent(commands)).toEqual([{ type: "searchMemory", query: "friday review" }]);
    });

    test("Remove sends that request's id", async () => {
      const { commands } = await open(kept);
      const remove = [...document.querySelectorAll<HTMLButtonElement>('ul[aria-label="Past requests"] button')];
      expect(remove.map((element) => element.textContent)).toEqual(["Remove", "Remove"]);
      await act(async () => remove[1]?.click());
      expect(sent(commands)).toEqual([{ type: "removeMemory", memId: "turn:1" }]);
    });

    test("Remove shows it is removing that request until the removal answers", async () => {
      let answer: (result: CommandResult) => void = () => {};
      await open(kept, new Promise<CommandResult>((resolve) => (answer = resolve)));
      const removeButtons = () => [...document.querySelectorAll<HTMLButtonElement>('ul[aria-label="Past requests"] button')];
      await act(async () => removeButtons()[1]?.click());
      expect(removeButtons().map((element) => [element.textContent, element.disabled])).toEqual([["Remove", false], ["Removing…", true]]);
      await act(async () => answer({ error: null }));
      expect(removeButtons().map((element) => [element.textContent, element.disabled])).toEqual([["Remove", false], ["Remove", false]]);
    });

    test("each Remove in flight shows until its own removal answers", async () => {
      const answers = new Map<string, (result: CommandResult) => void>();
      await open(kept, (command) => (command.type === "removeMemory" ? new Promise<CommandResult>((resolve) => answers.set(command.memId, resolve)) : { error: null }));
      const removeButtons = () => [...document.querySelectorAll<HTMLButtonElement>('ul[aria-label="Past requests"] button')];
      const shown = () => removeButtons().map((element) => [element.textContent, element.disabled]);
      await act(async () => removeButtons()[0]?.click());
      await act(async () => removeButtons()[1]?.click());
      expect(shown()).toEqual([["Removing…", true], ["Removing…", true]]);
      await act(async () => answers.get("turn:2")?.({ error: null }));
      expect(shown()).toEqual([["Remove", false], ["Removing…", true]]);
      await act(async () => answers.get("turn:1")?.({ error: null }));
      expect(shown()).toEqual([["Remove", false], ["Remove", false]]);
    });

    test("a Remove that fails while an earlier one is in flight can be tried again at once", async () => {
      const answers = new Map<string, (result: CommandResult) => void>();
      await open(kept, (command) => (command.type === "removeMemory" ? new Promise<CommandResult>((resolve) => answers.set(command.memId, resolve)) : { error: null }));
      const removeButtons = () => [...document.querySelectorAll<HTMLButtonElement>('ul[aria-label="Past requests"] button')];
      const shown = () => removeButtons().map((element) => [element.textContent, element.disabled]);
      await act(async () => removeButtons()[0]?.click());
      await act(async () => removeButtons()[1]?.click());
      await act(async () => answers.get("turn:1")?.({ error: "That request couldn’t be removed. Try again." }));
      expect(document.querySelector(".error")?.textContent).toBe("That request couldn’t be removed. Try again.");
      expect(shown()).toEqual([["Removing…", true], ["Remove", false]]);
      await act(async () => answers.get("turn:2")?.({ error: null }));
      expect(shown()).toEqual([["Remove", false], ["Remove", false]]);
    });

    test("a Remove that fails says why, and that request can be removed again", async () => {
      const { commands } = await open(kept, (command) => ({ error: command.type === "removeMemory" ? "That request couldn’t be removed. Try again." : null }));
      const removeButtons = () => [...document.querySelectorAll<HTMLButtonElement>('ul[aria-label="Past requests"] button')];
      await act(async () => removeButtons()[1]?.click());
      expect(document.querySelector(".error")?.textContent).toBe("That request couldn’t be removed. Try again.");
      expect(removeButtons().map((element) => [element.textContent, element.disabled])).toEqual([["Remove", false], ["Remove", false]]);
      await act(async () => removeButtons()[1]?.click());
      expect(sent(commands)).toEqual([{ type: "removeMemory", memId: "turn:1" }, { type: "removeMemory", memId: "turn:1" }]);
    });

    test("Reload shows what memory holds now: a request kept since the section opened, and its usage", async () => {
      const first = kept.memory.entries[1];
      if (!first) throw new Error("no request to start with");
      let current = withMemory({ usage: { docs: 1, usedBytes: MB }, entries: [first] });
      await settingsPage({ error: null }, () => current, current);
      await act(async () => button("Memory").click());
      const requests = () => [...document.querySelectorAll('ul[aria-label="Past requests"] li')].map((item) => item.textContent ?? "");
      expect(requests()).toHaveLength(1);
      expect(visibleText()).toContain("1 request kept");
      current = kept;
      await act(async () => button("Reload").click());
      expect(requests()).toHaveLength(2);
      expect(requests()[0]).toContain("What's on Friday?");
      expect(visibleText()).toContain("Memory used: 2 MB of 1 GB");
      expect(visibleText()).toContain("2 requests kept");
    });

    test("Reload reads memory again and says so once read, until the next command", async () => {
      let answer: (result: CommandResult) => void = () => {};
      let waiting = false;
      const { commands } = await open(kept, (command) => (command.type === "loadMemory" && waiting ? new Promise<CommandResult>((resolve) => (answer = resolve)) : { error: null }));
      waiting = true;
      await act(async () => button("Reload").click());
      waiting = false;
      expect(commands).toEqual([{ type: "loadMemory" }, { type: "loadMemory" }]);
      expect(visibleText()).not.toContain("Memory reloaded.");
      await act(async () => answer({ error: null }));
      expect(visibleText()).toContain("Memory reloaded.");
      await act(async () => button("Search").click());
      expect(visibleText()).not.toContain("Memory reloaded.");
    });

    test("a Reload overtaken by another command does not say it reloaded", async () => {
      let answer: (result: CommandResult) => void = () => {};
      let waiting = false;
      await open(kept, (command) => (command.type === "loadMemory" && waiting ? new Promise<CommandResult>((resolve) => (answer = resolve)) : { error: null }));
      waiting = true;
      await act(async () => button("Reload").click());
      waiting = false;
      await act(async () => button("Search").click());
      await act(async () => answer({ error: null }));
      expect(visibleText()).not.toContain("Memory reloaded.");
    });

    test("a larger size limit applies at once", async () => {
      const { commands } = await open(kept);
      await act(async () => pick(menu("Size limit"), String(2 * GB)));
      expect(sent(commands)).toEqual([{ type: "setMemorySizeLimit", value: 2 * GB }]);
      expect(visibleText()).not.toContain("Lower the limit");
    });

    test("a smaller size limit asks first, sending nothing until confirmed", async () => {
      const { commands } = await open(kept);
      await act(async () => pick(menu("Size limit"), String(100 * MB)));
      expect(visibleText()).toContain("Lower the limit to 100 MB? The oldest requests above it are removed. This can’t be undone.");
      expect(menu("Size limit").value).toBe(String(GB));
      expect(sent(commands)).toEqual([]);

      await act(async () => button("Cancel").click());
      expect(visibleText()).not.toContain("Lower the limit");
      expect(sent(commands)).toEqual([]);

      // Stepping down the list asks for the last choice only.
      await act(async () => pick(menu("Size limit"), String(500 * MB)));
      await act(async () => pick(menu("Size limit"), String(250 * MB)));
      expect(visibleText()).toContain("Lower the limit to 250 MB?");
      expect(sent(commands)).toEqual([]);
      await act(async () => button("Lower Limit").click());
      expect(sent(commands)).toEqual([{ type: "setMemorySizeLimit", value: 250 * MB }]);
      expect(visibleText()).not.toContain("Lower the limit");
    });

    /** After a reset of a settings file that couldn't be read, the limit the user chose is unknown:
     * "Not set", no bar, nothing kept until one is chosen, and any choice asked first, as it can remove
     * requests (owner, 2026-10-28). */
    test("a size limit not set says so, shows no bar, and asks before any choice", async () => {
      const { commands } = await open(withMemory({ usage: { docs: 1, usedBytes: 2 * GB }, sizeLimit: null }));
      expect(visibleText()).toContain("Memory used: 2 GB");
      expect(visibleText()).not.toContain("Memory used: 2 GB of");
      expect(visibleText()).toContain("Size limit not set: agent mode’s requests aren’t kept until you choose one.");
      expect(visibleText()).not.toContain("When memory reaches the limit");
      expect(document.querySelector('[role="progressbar"]')).toBeNull();
      expect([menu("Size limit").value, menu("Size limit").selectedOptions[0]?.textContent]).toEqual(["", "Not set"]);

      const largest = config.memorySizeLimitChoices.at(-1) ?? 0;
      await act(async () => pick(menu("Size limit"), String(largest)));
      expect(visibleText()).toContain(`Set the limit to ${formatBytes(largest)}? If memory holds more, its oldest requests are removed. This can’t be undone.`);
      expect(sent(commands)).toEqual([]);
      await act(async () => button("Set Limit").click());
      expect(sent(commands)).toEqual([{ type: "setMemorySizeLimit", value: largest }]);

      await open(withMemory({ usage: null, unavailable: true, sizeLimit: null }));
      expect(visibleText()).toContain("Memory used: unavailable (limit not set)");
    });

    test("asks before a smaller limit even when usage can't be read", async () => {
      const { commands } = await open(withMemory({ usage: null, unavailable: true, entries: [] }));
      await act(async () => pick(menu("Size limit"), String(100 * MB)));
      expect(visibleText()).toContain("Lower the limit to 100 MB?");
      expect(sent(commands)).toEqual([]);
    });

    test("Clear All asks first; Cancel sends nothing, Clear All clears", async () => {
      const { commands } = await open(kept);
      await act(async () => clearAll().click());
      expect(visibleText()).toContain("Remove every request kept? This can’t be undone.");
      await act(async () => button("Cancel").click());
      expect(sent(commands)).toEqual([]);
      await act(async () => clearAll().click());
      await act(async () => button("Clear All").click());
      expect(sent(commands)).toEqual([{ type: "clearMemory" }]);
    });

    test("Clear All shows why it failed", async () => {
      await open(kept, { error: "Memory couldn't be cleared. Try again." });
      await act(async () => clearAll().click());
      await act(async () => button("Clear All").click());
      expect(document.querySelector(".error")?.textContent).toBe("Memory couldn't be cleared. Try again.");
    });

    // What is kept can always be removed: Clear All needs no reading of memory, and is the way out
    // of memory that can't be read (a damaged file) and of a clear cut short (the database file gone,
    // its write-ahead log still there).
    test.each([
      ["nothing kept", { usage: { docs: 0, usedBytes: 0 }, entries: [] }],
      ["usage unreadable", { usage: null, unavailable: true, entries: [] }],
      ["usage still being read", { usage: null, entries: [] }],
    ])("Clear All works with %s", async (_name, memory) => {
      const { commands } = await open(withMemory(memory));
      expect(clearAll().disabled).toBe(false);
      await act(async () => clearAll().click());
      await act(async () => button("Clear All").click());
      expect(sent(commands)).toEqual([{ type: "clearMemory" }]);
    });

    test("Clear All stays on when only the search failed", async () => {
      await open(withMemory({ query: "re: invoice", entries: [], searchFailed: "refused" }));
      expect(clearAll().disabled).toBe(false);
    });

    test.each([
      ["memory unreadable", { usage: null, unavailable: true, entries: [] }, ["Memory used: unavailable (limit 1 GB)", "Memory can’t be read right now. Try again in a moment.", "Requests kept"]],
      ["memory being read", { usage: null, entries: [] }, ["Memory used: reading…", "Reading…"]],
      ["no match", { query: "invoice", entries: [] }, ["No requests found for “invoice”."]],
      ["a search refused", { query: "re: invoice", entries: [], searchFailed: "refused" as const }, ["Memory used: 2 MB of 1 GB", "Couldn’t search for “re: invoice”. Try other words."]],
      ["a list that failed", { entries: [], searchFailed: "failed" as const }, ["Memory used: 2 MB of 1 GB", "Requests can’t be listed right now. Try again in a moment."]],
      ["a change made", { status: "Size limit set to 100 MB. Removed the oldest request." }, ["Size limit set to 100 MB. Removed the oldest request."]],
    ])("says so with %s", async (_name, memory, texts) => {
      await open(withMemory(memory));
      for (const text of texts) expect(visibleText()).toContain(text);
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
      Dictation: ["Hold to dictate", "Smart dictation", "Read the screen while dictating"],
      Dictionary: ["No words yet.", "Learn from my corrections"],
      "Agent mode": ["Your name", "Edit", "Compose", "Close the chat when I click elsewhere"],
      Privacy: ["Excluded apps", "No apps added yet.", "Password managers are always excluded", "Excluded websites", "No websites added yet.", "Password managers’ websites are always excluded"],
      Personalization: ["Writing style", "General writing style", "Knowledge base", "History", "No changes yet."],
      Memory: ["Memory used: 0 KB of 1 GB", "Size limit", "No requests kept yet.", "0 requests kept", "Clear All…"],
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
    const shown = { ...signedIn, readsScreen: false, openAtLogin: true, debugAllowed: true, debugMode: false, optsOutOfAI: true };
    const page = await settingsPage({ error: null }, shown, shown);

    await act(async () => toggle("Smart dictation").click());
    await act(async () => toggle("Read the screen while dictating").click());
    await act(async () => toggle("Open at login").click());
    await act(async () => toggle("Debug mode").click());
    await act(async () => toggle("Opt Out of AI").click());

    expect(page.commands).toEqual([
      { type: "setSmartDictation", value: true },
      { type: "setReadsScreen", value: true },
      { type: "setOpenAtLogin", value: false },
      { type: "setDebugMode", value: true },
      { type: "setOptsOutOfAI", value: false },
    ]);
  });

  /** What applies is what is saved (owner, 2026-10-28): Opt Out of AI that couldn't be saved says so
   * under the switch, which shows the choice saved, and the next try clears it. */
  test("Opt Out of AI that couldn't be saved says so, and shows what is saved", async () => {
    const unsaved = "This couldn't be saved, so nothing changed. Check the disk and try again.";
    let reply: CommandResult = { error: unsaved };
    let shown: SettingsState = { ...signedIn, optsOutOfAI: false };
    await settingsPage(() => reply, () => shown, shown);
    await act(async () => toggle("Opt Out of AI").click());
    expect(toggle("Opt Out of AI").checked).toBe(false);
    expect(toggle("Opt Out of AI").closest(".row")?.textContent).toContain(unsaved);

    reply = { error: null };
    shown = { ...signedIn, optsOutOfAI: true };
    await act(async () => toggle("Opt Out of AI").click());
    expect(toggle("Opt Out of AI").checked).toBe(true);
    expect(document.body.textContent).not.toContain(unsaved);
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

  /** Every color `settings/index.css` and `form.css` read is there, in light and dark: declared by
   * a stylesheet, or by the palette's stylesheet the page is given (`shared/theme.ts`), with the
   * palette's values (a missing gradient would leave the chosen section's white label on white). */
  test("the page provides every color its stylesheet reads", async () => {
    const stylesheet = (name: string) => readFileSync(join(import.meta.dirname, "../../../src/renderer", name), "utf8");
    const css = stylesheet("settings/index.css") + stylesheet("shared/form.css");
    const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(([, name = ""]) => name));
    const read = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map(([, name = ""]) => name));
    await settingsPage({ error: null }, signedIn);
    expect(document.adoptedStyleSheets).toHaveLength(1);
    const text = document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n");
    const dark = text.indexOf("@media (prefers-color-scheme: dark)");
    expect(dark).toBeGreaterThan(0);
    const [lightColors, darkColors] = [text.slice(0, dark), text.slice(dark)];

    expect(read.size).toBeGreaterThan(0);
    for (const name of read) if (!declared.has(name)) expect(lightColors, name).toContain(`${name}: `);
    for (const variable of [`--brand-text-gradient: ${brandTextGradient};`, `--brand-blue: ${brandBlue};`, `--window: ${palette.light.window};`, `--secondary: ${palette.light.secondary};`]) {
      expect(lightColors).toContain(variable);
    }
    for (const variable of [`--window: ${palette.dark.window};`, `--secondary: ${palette.dark.secondary};`, `--switch-off: ${palette.dark.switchOff};`]) expect(darkColors).toContain(variable);
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
  test("the update button checks, waits, restarts, and retries, saying why it failed", async () => {
    const updateButton = () => [...document.querySelectorAll("main .row")].find((row) => row.firstElementChild?.textContent === "Updates")?.querySelector("button") ?? undefined;
    const cases: [SettingsState["update"], string | null, boolean, Command | null][] = [
      [{ kind: "idle" }, "Check for Updates…", false, { type: "checkForUpdates" }],
      [{ kind: "checking" }, "Checking for Updates…", true, null],
      [{ kind: "downloading", version: "2.0.0" }, "Downloading Version 2.0.0…", true, null],
      [{ kind: "ready", version: "2.0.0" }, "Restart to Update to Version 2.0.0", false, { type: "installUpdate" }],
      [{ kind: "failed", version: "2.0.0", message: "Version 2.0.0 didn't install." }, "Retry Update to Version 2.0.0", false, { type: "checkForUpdates" }],
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
      // Why it failed shows under the card, and only then.
      if (update?.kind === "failed") expect(visibleText()).toContain(update.message);
      else expect(visibleText()).not.toContain("didn't install");
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
    const recording = "Your recording is used only to transcribe it, and is never stored.";
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

    // Smart dictation, screen reading, learning the user's corrections, debug mode, the two agent
    // tools with a switch, closing the chat window on a click elsewhere, and Opt Out of AI.
    expect(document.querySelectorAll(".toggle .caption")).toHaveLength(8);
    expect(page.commands).toEqual([]);
  });

  /** Edit and Compose have a switch in Agent mode, on as the state says, which turns it on or off.
   * Answer has none: it is always on (owner, 2026-10-27). Thunderbird's has none, nor has the email
   * app it sends to, until its native connector (ADR-DESK-037). */
  test("each agent tool but Answer has a switch", async () => {
    const shown: SettingsState = { ...signedIn, enabledTools: ["edit"] };
    const page = await settingsPage({ error: null }, shown, shown);
    await act(async () => button("Agent mode").click());

    const labels = ["Edit", "Compose"];
    expect(labels.map((label) => toggle(label).checked)).toEqual([true, false]);
    for (const label of labels) await act(async () => toggle(label).click());

    expect(page.commands).toEqual([
      { type: "setAgentToolEnabled", tool: "edit", value: false },
      { type: "setAgentToolEnabled", tool: "compose", value: true },
    ]);
    expect([...document.querySelectorAll(".toggle label")].map((label) => label.textContent)).not.toContain("Answer");
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
    expect(labels).toEqual(["Calendar", "Compose", "Edit", "Reminders"]);
    expect(["Calendar", "Reminders"].map((label) => toggle(label).checked)).toEqual([false, true]);
    for (const label of ["Calendar", "Reminders"]) await act(async () => toggle(label).click());

    expect(page.commands).toEqual([
      { type: "setConnectorEnabled", connector: "calendar", value: true },
      { type: "setConnectorEnabled", connector: "reminders", value: false },
    ]);
  });

  /** How long a new event lasts sits under the Calendar switch (owner, 2026-10-18), with
   * Thunderbird's choices, and the one in force among them if agent mode set another. */
  describe("the default event length", () => {
    const withCalendar: SettingsState = { ...signedIn, connectors: ["calendar", "reminders"], enabledConnectors: ["calendar"] };
    const picker = (): HTMLSelectElement => {
      const label = [...document.querySelectorAll("label")].find((element) => element.textContent === "Default event length");
      const select = label && document.getElementById(label.htmlFor);
      if (!(select instanceof HTMLSelectElement)) throw new Error("no Default event length menu");
      return select;
    };
    const options = () => [...picker().options].map((option) => [option.value, option.textContent]);

    test("sits under the Calendar switch only, showing the one in force", async () => {
      await settingsPage({ error: null }, withCalendar, withCalendar);
      await act(async () => button("Agent mode").click());
      expect(picker().closest(".toggle")?.querySelector("label")?.textContent).toBe("Calendar");
      expect(document.querySelectorAll(".event-duration")).toHaveLength(1);
      expect(picker().value).toBe("45");
      expect(options()).toEqual([
        ["15", "15 min"],
        ["30", "30 min"],
        ["45", "45 min"],
        ["60", "1 hour"],
        ["90", "1h 30m"],
        ["120", "2 hours"],
      ]);
    });

    test("isn't shown without the calendar", async () => {
      await settingsPage({ error: null }, signedIn);
      await act(async () => button("Agent mode").click());
      expect(document.querySelector(".event-duration")).toBeNull();
      expect(document.body.textContent).not.toContain("Default event length");
    });

    test("a duration agent mode set is listed in order, and shown", async () => {
      const custom: SettingsState = { ...withCalendar, eventDuration: 50 };
      await settingsPage({ error: null }, custom, custom);
      await act(async () => button("Agent mode").click());
      expect(picker().value).toBe("50");
      expect(options().map(([value]) => value)).toEqual(["15", "30", "45", "50", "60", "90", "120"]);
      expect(options()[3]?.[1]).toBe("50 min");
    });

    test("a choice is sent as minutes", async () => {
      const page = await settingsPage({ error: null }, { ...withCalendar, eventDuration: 90 }, withCalendar);
      await act(async () => button("Agent mode").click());
      await act(async () => pick(picker(), "90"));
      expect(page.commands).toEqual([{ type: "setEventDuration", value: 90 }]);
      expect(picker().value).toBe("90");
      expect(document.querySelector(".event-duration .error")).toBeNull();
    });

    test("a choice that couldn't be saved says so, and the next choice clears it", async () => {
      const reply: CommandResult = { error: "The default event duration couldn't be saved. Check the disk and try again." };
      await settingsPage(reply, withCalendar, withCalendar);
      await act(async () => button("Agent mode").click());
      await act(async () => pick(picker(), "30"));
      expect(document.querySelector(".event-duration .error")?.textContent).toBe("The default event duration couldn't be saved. Check the disk and try again.");
      expect(picker().value).toBe("45");

      reply.error = null;
      await act(async () => pick(picker(), "60"));
      expect(document.querySelector(".event-duration .error")).toBeNull();
    });
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
      "Your recording is used only to transcribe it, and is never stored.",
      "Lets AI clean up your dictation: names and terms spelled as on screen, filler words removed, grammar fixed. Adds a delay of a second or more to each dictation.",
      "Uses the text in the window you’re dictating into, so names and terms come out right. Passwords and secrets are left out, and nothing is stored.",
      "Uses the development server and shows debug items in the menu.",
      "Rewrites the text you selected, as you ask: friendlier, shorter, translated, fixed.",
      "Writes new text where your cursor is: a reply, a message, a note, a command.",
      "Sent to TabMail with agent mode’s requests, so it knows which messages on screen are yours. TabMail doesn’t keep it.",
      // Closing the chat window on a click elsewhere, which the Swift app never had (owner, 2026-10-25).
      "It also closes when you switch to another app. It stays open while it’s listening, thinking, or waiting for your answer.",
      "Names and terms spelled your way, kept on this computer. They’re sent with each dictation so they come out right, and TabMail doesn’t keep them.",
      "No words yet.",
      `For ${config.correctionWatchDuration / 1000} seconds after a dictation, watches the text field it went into. When you correct how a word or name was spelled, the new spelling is added here. Learned words fill the room your own words leave, up to ${config.dictionaryMaxEntries} in all, and the one used least recently makes way for a new one. The field’s text stays on this computer, and a password field is never read.`,
      // Privacy's, which the Swift app never had (owner, 2026-09-30); Opt Out of AI as Thunderbird's and iOS's (owner, 2026-10-28).
      "Turns off dictation, agent mode and memory, so nothing you say or have on screen is sent to AI. Signing in and updates still work. On this computer only.",
      "In these apps TabMail Voice never reads the screen: nothing in their windows is sent with a dictation or used to learn a spelling. Dictation still works there.",
      `Password managers are always excluded: ${config.builtInExcludedApps.map((app) => app.name).join(", ")}.`,
      "No apps added yet.",
      // The websites', which the Swift app never had either (owner, 2026-10-01).
      "On these websites, and their subdomains, TabMail Voice never reads the screen, whichever browser they are open in.",
      `Password managers’ websites are always excluded: ${config.builtInExcludedSites.join(", ")}.`,
      "No websites added yet.",
      // Memory's, a port of Thunderbird's Chat History (ADR-DESK-061).
      "Agent mode’s requests, and what it answered or wrote, are kept on this computer so it can look back at them when you ask. Plain dictation isn’t kept.",
      "When memory reaches the limit, the oldest requests are removed first.",
      "No requests kept yet.",
      // Personalization's, a port of Thunderbird's writing style and knowledge base (ADR-DESK-063).
      // One short line each (owner, 2026-10-28).
      "How agent mode writes for you. Sent with its requests; TabMail doesn’t keep it.",
      "What agent mode knows and remembers about you. Sent with each request; TabMail doesn’t keep it.",
      `Your last ${config.promptHistoryMax} changes, kept on this computer so you can put one back.`,
      "No changes yet.",
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

  test.each(["available", "restart", "ready", undefined] as const)("Right Alt asks for the integration only while it is not enabled (%s)", async (state) => {
    const shown: SettingsState = { ...signedIn, hotkey: "rightAlt", availableHotkeys: ["F8", "F9", "rightAlt"], gnomeIntegration: state };
    await settingsPage({ error: null }, shown, shown);
    await act(async () => button("Dictation").click());
    const asked = visibleText().includes("Right Alt works once GNOME integration is enabled in Permissions.");
    expect(asked).toBe(state === "available" || state === "restart");
  });

  // Once F8 is chosen, Right Alt being unavailable no longer matters.
  test.each([["rightAlt", true, true], ["rightAlt", undefined, false], ["F8", true, false]] as const)("Right Alt the Shell can't hold says to choose F8 or F9 (%s, %s)", async (hotkey, unavailable, said) => {
    const shown: SettingsState = { ...signedIn, hotkey, availableHotkeys: ["F8", "F9", "rightAlt"], gnomeIntegration: "ready", ...(unavailable ? { hotkeyUnavailable: true } : {}) };
    await settingsPage({ error: null }, shown, shown);
    await act(async () => button("Dictation").click());
    expect(visibleText().includes("Right Alt types characters with this keyboard layout (AltGr), so it can’t be the dictation key. Choose F8 or F9.")).toBe(said);
  });

  test("F8 never asks for the integration", async () => {
    const shown: SettingsState = { ...signedIn, hotkey: "F8", availableHotkeys: ["F8", "F9", "rightAlt"], gnomeIntegration: "available" };
    await settingsPage({ error: null }, shown, shown);
    await act(async () => button("Dictation").click());
    expect(visibleText()).toContain("Hold F8 to dictate");
    expect(visibleText()).not.toContain("Right Alt works once");
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
