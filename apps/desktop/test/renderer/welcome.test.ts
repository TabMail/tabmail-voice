// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../../src/core/config.js";
import type { Command, WelcomeState } from "../../src/shared/ipc.js";

const features: WelcomeState = {
  step: "screenReading",
  index: 3,
  categoryIndex: 1,
  isFirstStep: false,
  isLastStep: false,
  canAdvance: true,
  hasConsented: true,
  readsScreen: true,
  enabledTools: ["compose", "thunderbird"],
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
    await import("../../src/renderer/welcome.js");
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

  /** The Features step has a checkbox for each agent tool, with its description, ticked as the state
   * says, which turns it on or off. */
  test("the Features step has a checkbox for each agent tool", async () => {
    const page = await welcomePage(features);
    const tools = [...document.querySelectorAll<HTMLLabelElement>("label.check")].filter((label) => label.querySelector(".labelled-icon"));

    expect(tools.map((label) => label.querySelector(".labelled-icon")?.textContent)).toEqual(["Edit", "Compose", "Thunderbird", "Answer"]);
    expect(tools.every((label) => (label.querySelector(".caption")?.textContent ?? "") !== "")).toBe(true);
    const boxes = tools.map((label) => label.querySelector("input") as HTMLInputElement);
    expect(boxes.map((box) => box.checked)).toEqual([false, true, true, false]);
    for (const box of boxes) await act(async () => box.click());

    expect(page.commands).toEqual([
      { type: "setAgentToolEnabled", tool: "edit", value: true },
      { type: "setAgentToolEnabled", tool: "compose", value: false },
      { type: "setAgentToolEnabled", tool: "thunderbird", value: false },
      { type: "setAgentToolEnabled", tool: "answer", value: true },
    ]);
  });

  /** On a Mac, the Features step has a checkbox for each app the Answer tool reaches, after the
   * tools, checked as the state says, which turns it on or off. */
  test("the Features step has a checkbox for each app the Answer tool reaches", async () => {
    const page = await welcomePage({ ...features, connectors: ["calendar", "reminders"], enabledConnectors: ["calendar"] });
    const rows = [...document.querySelectorAll<HTMLLabelElement>("label.check")].filter((label) => label.querySelector(".labelled-icon"));

    expect(rows.map((label) => label.querySelector(".labelled-icon")?.textContent)).toEqual(["Edit", "Compose", "Thunderbird", "Answer", "Calendar", "Reminders"]);
    expect(rows.every((label) => (label.querySelector(".caption")?.textContent ?? "") !== "")).toBe(true);
    const boxes = rows.slice(4).map((label) => label.querySelector("input") as HTMLInputElement);
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
