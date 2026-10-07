// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import type { Command, WelcomeState } from "../../../src/shared/ipc.js";

const features: WelcomeState = {
  step: "screenReading",
  index: 3,
  categoryIndex: 1,
  isFirstStep: false,
  isLastStep: false,
  canAdvance: true,
  hasConsented: true,
  canLearnWords: true,
  readsScreen: true,
  enabledTools: ["compose"],
  connectors: [],
  enabledConnectors: [],
  userName: null,
  suggestedName: "",
  microphoneGranted: true,
  accessibilityTrusted: true,
  vscodeFix: "notNeeded",
};

const accessibility: WelcomeState = { ...features, step: "accessibility", index: 2 };
const name: WelcomeState = { ...features, step: "name", index: 1 };

/** The welcome wizard, mounted afresh against a stand-in main process that shows `state`. */
async function welcomePage(state: WelcomeState): Promise<{ commands: Command[]; push: (state: WelcomeState) => Promise<void> }> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const commands: Command[] = [];
  let listener: ((state: WelcomeState) => void) | null = null;
  vi.stubGlobal("voice", {
    onState: (_name: string, next: (state: WelcomeState) => void) => {
      listener = next;
      return () => {};
    },
    send: async (command: Command) => {
      commands.push(command);
      return { error: null };
    },
  });
  vi.resetModules();
  await act(async () => {
    await import("../../../src/renderer/welcome/index.js");
  });
  await act(async () => listener?.(state));
  return { commands, push: (next) => act(async () => listener?.(next)) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** Types `text` into `input` as the user would, so React sees the change. */
function type(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function nameField(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>('input[aria-label="Your name"]');
  if (!found) throw new Error("no name field");
  return found;
}

describe("welcome wizard", () => {
  /** The consent step names everything a dictation sends, the dictionary's words included, and that
   * learning them reads the field on this computer only (ADR-DESK-038). */
  test("consent describes local learning only when the platform supports it", async () => {
    const { push } = await welcomePage({ ...features, step: "consent", canLearnWords: false });
    expect(document.querySelector(".sends")?.textContent).not.toContain("also learns");
    await push({ ...features, step: "consent", canLearnWords: true });
    expect(document.querySelector(".sends")?.textContent).toContain("also learns");
    expect(document.querySelector(".sends")?.textContent).toContain("That text stays on this computer.");
  });

  test("Ubuntu offers keyboard control with the portal instructions", async () => {
    const { commands } = await welcomePage({ ...accessibility, accessibilityTrusted: false, keyboardPermission: {
      title: "Keyboard control", description: "Lets TabMail Voice type your dictation.",
      button: "Allow Keyboard Control", instructions: "Turn on Allow Remote Interaction, then choose Share.",
    } });
    expect(document.querySelector("h1")?.textContent).toBe("Keyboard control");
    expect(document.body.textContent).toContain("Allow Remote Interaction");
    expect(document.body.textContent).not.toContain("System Settings");
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Allow Keyboard Control");
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(commands).toContainEqual({ type: "requestAccessibility" });
  });

  test("the consent step says what dictation sends", async () => {
    await welcomePage({ ...features, step: "consent", index: 0, isFirstStep: true, hasConsented: false });
    const sent = [...document.querySelectorAll(".sends li")].map((item) => item.textContent ?? "");
    expect(sent).toHaveLength(5);
    expect(sent[0]).toContain("Your voice");
    expect(sent[1]).toContain("The text in the window in front");
    expect(sent[2]).toContain("The words in your dictionary");
    expect(sent[2]).toContain("That text stays on this computer.");
    expect(sent[2]).toContain("Learning is on unless you switch it off in Settings.");
    // Agent mode's request, selection, apps' results and web pages (#170).
    expect(sent[3]).toContain("In agent mode, your request and the text you’ve selected");
    expect(sent[3]).toContain("what the apps you switch on in the Features step or in Settings return");
    expect(sent[3]).toContain("the text of the web pages it reads");
    expect(sent[4]).toContain("All of it goes to TabMail and the AI providers it uses, only to process that dictation, and isn’t stored.");
    expect(sent[4]).toContain("When agent mode searches the web, the search goes to a search provider too.");
  });

  /** The name step offers the computer account's name while none is stored, filling it in when it
   * arrives after the page opens; a stored name shows as stored; what the user types is sent as typed
   * and stays in the field. */
  test("the name step offers the suggested name and sends what the user types", async () => {
    const page = await welcomePage(name);
    expect(document.querySelector("h1")?.textContent).toBe("Your Name");
    expect(nameField().value).toBe("");
    await page.push({ ...name, suggestedName: "Alex Example" });
    expect(nameField().value).toBe("Alex Example");
    expect(nameField().maxLength).toBe(config.userNameMaxLength);

    await act(async () => type(nameField(), "Alex"));
    expect(page.commands).toEqual([{ type: "setUserName", value: "Alex" }]);
    await page.push({ ...name, userName: "Alex", suggestedName: "Alex Example" });
    expect(nameField().value).toBe("Alex");
    await act(async () => type(nameField(), ""));
    expect(page.commands.at(-1)).toEqual({ type: "setUserName", value: "" });
    expect(nameField().value).toBe("");

    await welcomePage({ ...name, userName: "Sam", suggestedName: "Alex Example" });
    expect(nameField().value).toBe("Sam");
    await welcomePage({ ...name, userName: "", suggestedName: "Alex Example" });
    expect(nameField().value).toBe("");
  });

  /** The Features step has a checkbox for each agent tool offered, in alphabetical order, with its
   * description, ticked as the state says, which turns it on or off. Thunderbird's has none until its
   * native connector (ADR-DESK-037). */
  test("the Features step has a checkbox for each agent tool", async () => {
    const page = await welcomePage(features);
    const tools = [...document.querySelectorAll<HTMLLabelElement>("label.check")].filter((label) => label.querySelector(".labeled-icon"));

    expect(tools.map((label) => label.querySelector(".labeled-icon")?.textContent)).toEqual(["Answer", "Compose", "Edit"]);
    expect(tools.every((label) => (label.querySelector(".caption")?.textContent ?? "") !== "")).toBe(true);
    const boxes = tools.map((label) => label.querySelector("input") as HTMLInputElement);
    expect(boxes.map((box) => box.checked)).toEqual([false, true, false]);
    for (const box of boxes) await act(async () => box.click());

    expect(page.commands).toEqual([
      { type: "setAgentToolEnabled", tool: "answer", value: true },
      { type: "setAgentToolEnabled", tool: "compose", value: false },
      { type: "setAgentToolEnabled", tool: "edit", value: true },
    ]);
    expect(document.body.textContent).not.toContain("Thunderbird");
  });

  /** On a Mac, the Features step has a checkbox for each app the Answer tool reaches, among the tools
   * in alphabetical order as Settings lists them (owner, 2026-09-28), checked as the state says,
   * which turns it on or off. */
  test("the Features step has a checkbox for each app the Answer tool reaches", async () => {
    const page = await welcomePage({ ...features, connectors: ["calendar", "reminders"], enabledConnectors: ["calendar"] });
    const rows = [...document.querySelectorAll<HTMLLabelElement>("label.check")].filter((label) => label.querySelector(".labeled-icon"));

    expect(rows.map((label) => label.querySelector(".labeled-icon")?.textContent)).toEqual(["Answer", "Calendar", "Compose", "Edit", "Reminders"]);
    expect(rows.every((label) => (label.querySelector(".caption")?.textContent ?? "") !== "")).toBe(true);
    const boxes = [rows[1], rows[4]].map((label) => label?.querySelector("input") as HTMLInputElement);
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    for (const box of boxes) await act(async () => box.click());

    expect(page.commands).toEqual([
      { type: "setConnectorEnabled", connector: "calendar", value: false },
      { type: "setConnectorEnabled", connector: "reminders", value: true },
    ]);
  });

  /** When VS Code's settings hide the caret, the Accessibility step says so and offers to fix them,
   * then shows they are fixed; otherwise it doesn't mention VS Code. */
  test("the Accessibility step offers to fix VS Code's settings only when they need it", async () => {
    const page = await welcomePage({ ...accessibility, vscodeFix: "needed" });
    const fix = [...document.querySelectorAll("button")].find((button) => button.textContent === "Fix VS Code’s Settings");
    expect(fix).toBeDefined();
    await act(async () => fix?.click());
    expect(page.commands).toEqual([{ type: "fixVSCodeSettings" }]);

    await welcomePage({ ...accessibility, vscodeFix: "done" });
    expect(document.body.textContent).toContain("✓ Fixed");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Fix VS Code’s Settings")).toBe(false);

    await welcomePage(accessibility);
    expect(document.body.textContent).not.toContain("VS Code");
  });
});
