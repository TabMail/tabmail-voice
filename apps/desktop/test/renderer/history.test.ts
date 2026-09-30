// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Command, HistoryState } from "../../src/shared/ipc.js";

/** The paste history page, mounted afresh against a stand-in main process that shows `state`, its
 * list measuring `height` (happy-dom lays nothing out). */
async function historyPage(state: HistoryState, height = 0): Promise<Command[]> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height);
  const commands: Command[] = [];
  let listener: ((state: HistoryState) => void) | null = null;
  vi.stubGlobal("voice", {
    onState: (_name: string, next: (state: HistoryState) => void) => {
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
    await import("../../src/renderer/history.js");
  });
  await act(async () => listener?.(state));
  return commands;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** The paste history a triple tap opens (ADR-DESK-043). */
describe("paste history page", () => {
  const now = Date.now();
  const state: HistoryState = {
    entries: [
      { id: 2, text: "Sounds good.", at: now },
      { id: 1, text: "Can we move it to Thursday?", at: now - 3 * 60_000 },
    ],
  };

  test("lists the texts, the newest first, with how long ago; the window takes the list's height", async () => {
    const commands = await historyPage(state, 180);
    const entries = [...document.querySelectorAll(".history-entry")];
    expect(entries.map((entry) => entry.querySelector(".history-text")?.textContent)).toEqual(["Sounds good.", "Can we move it to Thursday?"]);
    expect(entries.map((entry) => entry.querySelector(".history-time")?.textContent)).toEqual(["just now", "3 min ago"]);
    expect(commands).toContainEqual({ type: "historyHeight", height: 180 });
  });

  test("a click copies its entry", async () => {
    const commands = await historyPage(state);
    await act(async () => document.querySelectorAll<HTMLButtonElement>(".history-entry")[1]?.click());
    expect(commands).toEqual([{ type: "copyHistoryEntry", id: 1 }]);
  });

  /** Each test's page stays mounted on `window` (the module is imported afresh), so an Escape may be
   * heard more than once: what it sends is what counts. */
  test("Escape closes it", async () => {
    const commands = await historyPage(state);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
    expect(commands).toEqual([]);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.type === "closeHistory")).toBe(true);
  });

  test("says when nothing was pasted yet", async () => {
    await historyPage({ entries: [] });
    expect(document.querySelector(".history-empty")?.textContent).toBe("Nothing pasted yet.");
    expect(document.querySelector(".history-hint")).toBeNull();
  });
});
