// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Command, CommandResult, SettingsState } from "../../src/shared/ipc.js";

const signedIn: SettingsState = {
  email: "person@example.com",
  hotkey: "rightOption",
  readsScreen: true,
  emailClient: null,
  systemEmailApp: null,
  installedEmailApps: [],
  hasTabMail: false,
  defaultEmailAppIsSupported: false,
  microphoneGranted: true,
  accessibilityTrusted: true,
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
      "Agent mode": ["Email app"],
      Permissions: ["Microphone", "Accessibility"],
      General: ["Open at login", "Debug mode"],
    };
    const shown = { ...signedIn, debugAllowed: true };
    await settingsPage({ error: null }, shown, shown);
    expect(document.querySelector("h1")?.textContent).toBe("Account");

    for (const [section, settings] of Object.entries(own)) {
      await act(async () => button(section).click());
      expect(document.querySelector("h1")?.textContent).toBe(section);
      expect(button(section).getAttribute("aria-current")).toBe("page");
      expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      const visible = visibleText();
      for (const setting of settings) expect(visible, `${section} shows ${setting}`).toContain(setting);
      for (const [other, theirs] of Object.entries(own)) {
        if (other === section) continue;
        for (const setting of theirs) expect(visible, `${section} hides ${other}'s ${setting}`).not.toContain(setting);
      }
    }
  });

  /** A section with something to do (signed out, a permission missing) is marked in the sidebar,
   * with a mark a screen reader announces (an image with a label, not a bare dot). */
  test("the sidebar marks the sections that need the user", async () => {
    const marked = () => [...document.querySelectorAll("button.nav")].filter((nav) => nav.querySelector('[role="img"][aria-label="Needs attention"]')).map((nav) => nav.textContent);

    await settingsPage({ error: null }, signedIn);
    expect(marked()).toEqual([]);

    await settingsPage({ error: null }, signedIn, { ...signedIn, email: null, microphoneGranted: false });
    expect(marked()).toEqual(["Account", "Permissions"]);

    await settingsPage({ error: null }, signedIn, { ...signedIn, accessibilityTrusted: false });
    expect(marked()).toEqual(["Permissions"]);
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

    expect(document.querySelectorAll(".toggle .caption")).toHaveLength(2);
    expect(page.commands).toEqual([]);
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
