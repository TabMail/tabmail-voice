// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import type { Command, HistoryState } from "../../../src/shared/ipc.js";

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
    await import("../../../src/renderer/history/index.js");
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

  /** A card of the overlay's glass, with its rim and glow (owner, 2026-10-09: "the paste history
   * should also have the same glow"), the margin its window keeps for the glow around it. */
  test("is a card of the overlay's glass, with its glow", async () => {
    await historyPage(state);
    const card = document.querySelector<HTMLElement>(".history")?.style;
    expect(card?.background).toBe("var(--glass)");
    expect(card?.boxShadow).toContain("var(--rim)");
    expect(card?.boxShadow).toContain("var(--glow)");
    // The crisp shadow, and room in the window for all of it.
    expect(card?.boxShadow).toContain("var(--contact)");
    expect(card?.boxShadow).toContain("var(--ambient)");
    expect(config.pasteHistoryShadowMargin).toBeGreaterThanOrEqual(config.glassShadowReach);
    expect(card?.margin).toBe(`${config.pasteHistoryShadowMargin}px`);
    expect(card?.borderRadius).toBe(`${config.pasteHistoryCornerRadius}px`);
  });

  /** The window is clear round the card, for its glow, whichever of the page's stylesheet and
   * `form.css` (`html, body` in the window's color) the build links last: the page's selectors
   * outrank theirs (`:root`, a pseudo-class, over `html`, a type). */
  test("the window stays clear round the card, above form.css", () => {
    const css = readFileSync(join(import.meta.dirname, "../../../src/renderer/history/index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const clear = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, , body = ""]) => /background:\s*transparent/.test(body));
    const selectors = (clear?.[1] ?? "").split(",").map((selector) => selector.trim());
    expect(selectors).toEqual([":root", ":root > body"]);
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
