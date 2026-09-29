// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../../src/core/config.js";
import { brandBlue, brandGradient, brandTextGradient } from "../../src/renderer/brand.js";
import type { Command, CommandResult, SettingsState } from "../../src/shared/ipc.js";

const signedIn: SettingsState = {
  email: "person@example.com",
  hotkey: "rightOption",
  readsScreen: true,
  enabledTools: ["edit", "compose", "thunderbird", "answer"],
  connectors: [],
  enabledConnectors: [],
  userName: "Alex Example",
  suggestedName: "Alex Example",
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
    await import("../../src/renderer/settings.js");
  });
  await act(async () => listener?.(initial));
  return { commands };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

/** The switch labelled `label`: the input its label names. */
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
      "Agent mode": ["Your name", "Edit", "Compose", "Thunderbird", "Answer", "Email app"],
      Permissions: ["Microphone", "Accessibility"],
      General: ["Open at login", "Debug mode"],
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

  /** Every other control sends its own command: each menu its choice (the email app's Default as
   * none), each Allow… its own permission's request, and Sign In the email and the code typed. */
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
    await act(async () => pick(menu("Email app"), "com.example.mail"));
    await act(async () => pick(menu("Email app"), ""));
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
      { type: "setEmailClient", bundleIdentifier: "com.example.mail" },
      { type: "setEmailClient", bundleIdentifier: null },
      { type: "requestAccessibility" },
      { type: "requestMicrophone" },
      { type: "sendCode", email: "person@example.com" },
      { type: "verify", email: "person@example.com", code: "123456" },
    ]);
  });

  /** Only on macOS, where the window is frosted under inset traffic lights, is the page clear with
   * its sidebar the title bar (`.mac`); elsewhere the page has its own colour. */
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

  /** Every colour `settings.css` reads is there: declared by a stylesheet, or set on the page by
   * `settings.tsx` from the brand and the config (a missing gradient would leave the chosen
   * section's white label on white). */
  test("the page provides every colour its stylesheet reads", async () => {
    const stylesheet = (name: string) => readFileSync(join(import.meta.dirname, "../../src/renderer", name), "utf8");
    const settingsCSS = stylesheet("settings.css");
    const declared = new Set([...(settingsCSS + stylesheet("form.css")).matchAll(/(--[\w-]+)\s*:/g)].map(([, name = ""]) => name));
    const read = new Set([...settingsCSS.matchAll(/var\((--[\w-]+)\)/g)].map(([, name = ""]) => name));
    await settingsPage({ error: null }, signedIn);
    const page = document.querySelector<HTMLElement>(".settings");
    if (!page) throw new Error("no page");
    const provided: Record<string, string> = {
      "--brand-gradient": brandGradient,
      "--brand-text-gradient": brandTextGradient,
      "--brand-blue": brandBlue,
      "--window-light": config.settingsWindowColour.light,
      "--window-dark": config.settingsWindowColour.dark,
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

  /** Debug mode is offered, under General, only to an account allowed it. */
  test("Debug mode shows only when allowed", async () => {
    await settingsPage({ error: null }, signedIn, { ...signedIn, debugAllowed: true });
    await act(async () => button("General").click());
    expect(visibleText()).toContain("Debug mode");

    await settingsPage({ error: null }, signedIn);
    await act(async () => button("General").click());
    expect(visibleText()).not.toContain("Debug mode");
  });

  /** Under the hotkey: the Globe key's note while fn is the hotkey, then the recording's. */
  test("the hotkey's notes", async () => {
    const globe = "While fn is the hotkey";
    const recording = "Your recording is sent to TabMail for transcription and isn’t stored.";
    const notes = () => [...document.querySelectorAll("main > div:not([hidden]) .card-section")].find((card) => card.textContent?.includes("Hold to dictate"))?.querySelectorAll(".group-caption");

    await settingsPage({ error: null }, signedIn, { ...signedIn, hotkey: "function" });
    await act(async () => button("Dictation").click());
    expect([...(notes() ?? [])].map((note) => note.textContent?.slice(0, globe.length))).toEqual([globe, recording.slice(0, globe.length)]);

    await settingsPage({ error: null }, signedIn);
    await act(async () => button("Dictation").click());
    expect([...(notes() ?? [])].map((note) => note.textContent)).toEqual([recording]);
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

    // Screen reading, debug mode and the four agent tools.
    expect(document.querySelectorAll(".toggle .caption")).toHaveLength(6);
    expect(page.commands).toEqual([]);
  });

  /** Each agent tool has a switch in Agent mode, on as the state says, which turns it on or off. */
  test("each agent tool has a switch", async () => {
    const shown: SettingsState = { ...signedIn, enabledTools: ["edit", "answer"] };
    const page = await settingsPage({ error: null }, shown, shown);
    await act(async () => button("Agent mode").click());

    const labels = ["Edit", "Compose", "Thunderbird", "Answer"];
    expect(labels.map((label) => toggle(label).checked)).toEqual([true, false, false, true]);
    for (const label of labels) await act(async () => toggle(label).click());

    expect(page.commands).toEqual([
      { type: "setAgentToolEnabled", tool: "edit", value: false },
      { type: "setAgentToolEnabled", tool: "compose", value: true },
      { type: "setAgentToolEnabled", tool: "thunderbird", value: true },
      { type: "setAgentToolEnabled", tool: "answer", value: false },
    ]);
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
    expect(labels).toEqual(["Answer", "Calendar", "Compose", "Edit", "Reminders", "Thunderbird"]);
    expect(["Calendar", "Reminders"].map((label) => toggle(label).checked)).toEqual([false, true]);
    for (const label of ["Calendar", "Reminders"]) await act(async () => toggle(label).click());

    expect(page.commands).toEqual([
      { type: "setConnectorEnabled", connector: "calendar", value: true },
      { type: "setConnectorEnabled", connector: "reminders", value: false },
    ]);
  });

  /** The notes are the Swift app's (typographic apostrophes aside) and no others: every state's
   * notes, in each email-app case, with fn the hotkey and debug mode allowed. The redesign once
   * invented notes, one of them untrue. */
  test("the notes are the Swift app's", async () => {
    const notes = () => [...document.querySelectorAll("main .caption")].map((note) => note.textContent);
    const always = [
      "While fn is the hotkey, the 🌐 key’s own action in Keyboard settings is set to “Do Nothing”. Your choice comes back when you pick another key or quit.",
      "Your recording is sent to TabMail for transcription and isn’t stored.",
      "Sends the text in the window in front with your dictation, so names and terms are spelled as they appear there. It isn’t stored.",
      "Uses the development server and shows debug items in the menu.",
      "Rewrites the text you selected, as you ask: friendlier, shorter, translated, fixed.",
      "Writes new text where your cursor is: a reply, a message, a note, a command.",
      "Sends mail and calendar requests to TabMail’s chat in Thunderbird.",
      "Answers you in a chat window beside the app. Hold the key again while it’s open to follow up; your earlier requests and its replies go with the follow-up and aren’t stored.",
      "Sent to TabMail with agent mode’s requests, so it knows which messages on screen are yours. TabMail doesn’t keep it.",
    ];
    const cases: [Partial<SettingsState>, string][] = [
      [{ hasTabMail: false }, "TabMail’s add-on isn’t installed in Thunderbird, so mail and calendar requests aren’t offered."],
      [{ hasTabMail: true, emailClient: null, defaultEmailAppIsSupported: false }, "Mail and calendar requests need Thunderbird with TabMail. Choose it here, or make it your default email app."],
      [{ hasTabMail: true, emailClient: null, defaultEmailAppIsSupported: true }, "Mail and calendar requests go to TabMail’s chat in this app."],
    ];
    for (const [emailApp, caption] of cases) {
      await settingsPage({ error: null }, signedIn, { ...signedIn, hotkey: "function", debugAllowed: true, ...emailApp });
      expect(notes().sort()).toEqual([...always, caption].sort());
    }
  });
});
