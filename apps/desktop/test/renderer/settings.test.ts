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

afterEach(() => {
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

  /** The sidebar shows one section at a time, Account first; every setting is in one of them. */
  test("each section in the sidebar shows its own settings", async () => {
    await settingsPage({ error: null }, signedIn);
    const heading = () => document.querySelector("h1")?.textContent;
    const shown: Record<string, string[]> = {};
    for (const section of ["Account", "Dictation", "Agent mode", "Permissions", "General"]) {
      await act(async () => button(section).click());
      expect(heading()).toBe(section);
      expect(button(section).getAttribute("aria-current")).toBe("page");
      expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      shown[section] = [...document.querySelectorAll("main > div:not([hidden]) .row")].map((row) => row.textContent ?? "");
    }

    const everything = Object.values(shown).flat().join("\n");
    for (const setting of ["Sign Out", "Hold to dictate", "Read the screen while dictating", "Email app", "Microphone", "Accessibility", "Open at login"]) {
      expect(everything).toContain(setting);
    }
    expect(shown.Account?.join()).toContain("Sign Out");
    expect(shown.Dictation?.join()).not.toContain("Sign Out");
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
