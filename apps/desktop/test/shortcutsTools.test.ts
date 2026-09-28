// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test } from "vitest";
import { LoopToolArgumentError } from "../src/core/agent/loopTool.js";
import { type ShortcutsRunner, ShortcutsListTool, ShortcutsRunTool, shortcutsTools } from "../src/core/agent/shortcutsTools.js";
import * as config from "../src/core/config.js";

/** Shortcuts as the Answer prompt's tools, against a fake: the shortcuts listed, what the user is asked
 * to confirm, and the shortcut run (from the Swift `ShortcutsToolsTests`). No test here runs a
 * command; `shortcuts.test.ts` runs a stand-in for it. */

/** The shortcuts `names`, and the ones run, never running one. */
class FakeShortcuts implements ShortcutsRunner {
  names_: string[] = [];
  output = "";
  readonly ran: string[] = [];
  readonly signals: AbortSignal[] = [];

  async names(signal: AbortSignal): Promise<string[]> {
    this.signals.push(signal);
    return this.names_;
  }

  async run(name: string, signal: AbortSignal): Promise<string> {
    this.signals.push(signal);
    this.ran.push(name);
    return this.output;
  }
}

let shortcuts: FakeShortcuts;
const signal = new AbortController().signal;

beforeEach(() => {
  shortcuts = new FakeShortcuts();
});

describe("the connector", () => {
  test("Shortcuts has shortcuts_list and shortcuts_run", () => {
    const tools = shortcutsTools(shortcuts);

    expect(tools.map((tool) => [tool.name, tool.connector])).toEqual([
      ["shortcuts_list", "shortcuts"],
      ["shortcuts_run", "shortcuts"],
    ]);
  });
});

describe("shortcuts_list", () => {
  test("every shortcut is listed, without asking", async () => {
    shortcuts.names_ = ["Morning", "Log water"];
    const tool = new ShortcutsListTool(shortcuts);

    const result = await tool.run({}, signal);

    expect(tool.confirmation()).toBeNull();
    expect(result).toBe("The user's shortcuts:\n- Morning\n- Log water");
    expect(shortcuts.signals).toEqual([signal]);
  });

  /** A query keeps the shortcuts whose name contains it, ignoring case and accents. */
  test("a query keeps the names containing it", async () => {
    shortcuts.names_ = ["Morning", "Log Wáter", "Water plants", "Evening"];
    const tool = new ShortcutsListTool(shortcuts);

    expect(await tool.run({ query: " water " }, signal)).toBe('Shortcuts whose name contains "water":\n- Log Wáter\n- Water plants');
    expect(await tool.run({ query: "WÁTER" }, signal)).toBe('Shortcuts whose name contains "WÁTER":\n- Log Wáter\n- Water plants');
    expect(await tool.run({ query: "lights" }, signal)).toBe('No shortcut\'s name contains "lights".');
  });

  test("no shortcuts says so", async () => {
    expect(await new ShortcutsListTool(shortcuts).run({}, signal)).toBe("The user has no shortcuts.");
  });

  test("a long list is cut short and says so", async () => {
    const limit = config.shortcutsListMaxResults;
    shortcuts.names_ = Array.from({ length: limit + 1 }, (_, index) => `Shortcut ${index}`);

    const lines = (await new ShortcutsListTool(shortcuts).run({}, signal)).split("\n");

    expect(lines.slice(1, -1)).toEqual(Array.from({ length: limit }, (_, index) => `- Shortcut ${index}`));
    expect(lines.at(-1)).toBe("(1 more; list them with a query.)");
  });

  test("a list of exactly the most is not cut short", async () => {
    const limit = config.shortcutsListMaxResults;
    shortcuts.names_ = Array.from({ length: limit }, (_, index) => `Shortcut ${index}`);

    const lines = (await new ShortcutsListTool(shortcuts).run({}, signal)).split("\n");

    expect(lines).toHaveLength(limit + 1);
    expect(lines.at(-1)).toBe(`- Shortcut ${limit - 1}`);
  });
});

describe("shortcuts_run", () => {
  /** The user is asked with the shortcut's name, and the shortcut run is that one. */
  test("the confirmed shortcut runs", async () => {
    shortcuts.names_ = ["Morning", "Log water"];
    shortcuts.output = "Logged 250 ml";
    const tool = new ShortcutsRunTool(shortcuts);
    const args = { name: "Log water" };

    const question = tool.confirmation(args);
    const result = await tool.run(args, signal);

    expect(question).toBe('Run the shortcut "Log water"?');
    expect(shortcuts.ran).toEqual(["Log water"]);
    expect(result).toBe('Ran the shortcut "Log water". It gave:\nLogged 250 ml');
    expect(shortcuts.signals).toEqual([signal, signal]);
  });

  test("a shortcut without output says so", async () => {
    shortcuts.names_ = ["Morning"];

    expect(await new ShortcutsRunTool(shortcuts).run({ name: "Morning" }, signal)).toBe('Ran the shortcut "Morning". It gave no text.');
  });

  /** Only a shortcut with exactly that name runs; any other name runs nothing and the model is told to
   * look the name up. */
  test.each(["morning", "Morning routine", "Mor"])("%j, which no shortcut is named, runs nothing", async (name) => {
    shortcuts.names_ = ["Morning"];
    const tool = new ShortcutsRunTool(shortcuts);

    await expect(tool.run({ name }, signal)).rejects.toEqual(new LoopToolArgumentError(`No shortcut is named "${name}": find its exact name with shortcuts_list.`));
    expect(shortcuts.ran).toEqual([]);
  });

  test.each([{}, { name: " " }, { name: 7 }])("%j asks nothing and runs nothing", async (args) => {
    shortcuts.names_ = ["Morning"];
    const tool = new ShortcutsRunTool(shortcuts);

    expect(tool.confirmation(args)).toBeNull();
    await expect(tool.run(args, signal)).rejects.toEqual(LoopToolArgumentError.missing("name"));
    expect(shortcuts.ran).toEqual([]);
  });
});
