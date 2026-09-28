// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
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
  microphoneGranted: true,
  accessibilityTrusted: true,
};

/** The welcome wizard, mounted afresh against a stand-in main process that shows `state`. */
async function welcomePage(state: WelcomeState): Promise<{ commands: Command[] }> {
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
  return { commands };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("welcome wizard", () => {
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
});
