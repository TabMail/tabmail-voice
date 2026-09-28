// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { Arguments, type LoopTool, LoopToolArgumentError } from "./loopTool.js";

/** The user's shortcuts, as the Shortcuts app's `shortcuts` command lists and runs them
 * (ADR-DESK-029); `signal` ends the command. */
export interface ShortcutsRunner {
  /** Every shortcut's name, as the Shortcuts app orders them. */
  names(signal: AbortSignal): Promise<string[]>;
  /** Runs the shortcut named `name` with no input; its output as text, empty when it has none. */
  run(name: string, signal: AbortSignal): Promise<string>;
}

/** The Shortcuts connector's tools. */
export function shortcutsTools(runner: ShortcutsRunner): LoopTool[] {
  return [new ShortcutsListTool(runner), new ShortcutsRunTool(runner)];
}

/** `text` compared as a person reads it: ignoring case and accents. */
function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The user's shortcuts by name (`shortcuts_list`), for "which shortcuts do I have" and to find the
 * exact name `shortcuts_run` takes. */
export class ShortcutsListTool implements LoopTool {
  readonly name = "shortcuts_list";
  readonly connector = "shortcuts";
  readonly progressLabel = "Looking at your shortcuts";

  constructor(private readonly runner: ShortcutsRunner) {}

  confirmation(): null {
    return null;
  }

  /** Every shortcut, or those whose name contains `query` (ignoring case and accents), at most
   * `shortcutsListMaxResults`; more say so. */
  async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const query = Arguments.text(args, "query");
    const found = (await this.runner.names(signal)).filter((name) => query === null || folded(name).includes(folded(query)));
    if (found.length === 0) return query === null ? "The user has no shortcuts." : `No shortcut's name contains "${query}".`;
    const limit = config.shortcutsListMaxResults;
    const lines = [query === null ? "The user's shortcuts:" : `Shortcuts whose name contains "${query}":`, ...found.slice(0, limit).map((name) => `- ${name}`)];
    if (found.length > limit) lines.push(`(${found.length - limit} more; list them with a query.)`);
    return lines.join("\n");
  }
}

/** Runs one of the user's shortcuts (`shortcuts_run`), once the user confirms the name the chat window
 * shows: the question and the run come from the same argument. */
export class ShortcutsRunTool implements LoopTool {
  readonly name = "shortcuts_run";
  readonly connector = "shortcuts";
  readonly progressLabel = "Running the shortcut";

  constructor(private readonly runner: ShortcutsRunner) {}

  /** Null only for arguments `run` rejects before running anything. */
  confirmation(args: Record<string, unknown>): string | null {
    const shortcut = Arguments.text(args, "name");
    return shortcut === null ? null : `Run the shortcut "${shortcut}"?`;
  }

  /** Runs the shortcut only if one has exactly that name; its text output, if any. */
  async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const shortcut = Arguments.text(args, "name");
    if (shortcut === null) throw LoopToolArgumentError.missing("name");
    if (!(await this.runner.names(signal)).includes(shortcut)) {
      throw new LoopToolArgumentError(`No shortcut is named "${shortcut}": find its exact name with shortcuts_list.`);
    }
    const output = await this.runner.run(shortcut, signal);
    return output === "" ? `Ran the shortcut "${shortcut}". It gave no text.` : `Ran the shortcut "${shortcut}". It gave:\n${output}`;
  }
}
