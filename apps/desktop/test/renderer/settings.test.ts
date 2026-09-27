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

/** The Settings page, mounted afresh against a stand-in main process that answers each command with
 * `reply` and then pushes `after` (as the main process pushes the new state). */
async function settingsPage(reply: CommandResult, after: SettingsState): Promise<{ commands: Command[] }> {
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
  await act(async () => listener?.(signedIn));
  return { commands };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
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
});
