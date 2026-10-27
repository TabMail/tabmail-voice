// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { log } from "../log.js";
import { applyKBPatch, normalizeUnicode } from "./patchApplier.js";
import type { UserPrompts } from "./prompts.js";

/**
 * The agent loop's knowledge-base tools, run on this computer (ADR-DESK-063): `kb_add` keeps a
 * statement the user asked to be remembered, pinned, and `kb_del` removes one. A port of Thunderbird's
 * tools of the same names: the same argument, patches, results and errors, each result the JSON of
 * what the tool answers. They edit only the user's own knowledge base, so they ask nothing first.
 */
export class KBTools {
  /** The tools' names, as the loop offers them. */
  static readonly names: readonly string[] = [config.kbAddTool, config.kbDelTool];

  constructor(private readonly prompts: UserPrompts) {}

  /** Runs the tool `name` with `args` (the call's parsed arguments), and returns what the model reads. */
  run(name: string, args: Record<string, unknown>): string {
    // One line: a statement is one bullet, so a line break in it (or a line reading ADD or DEL) never
    // becomes another edit.
    const statement = normalizeUnicode(typeof args.statement === "string" ? args.statement : "")
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join(" ");
    if (statement === "") {
      log.error(`KBTools: ${name} called without a statement`);
      return JSON.stringify({ error: "missing statement" });
    }
    return JSON.stringify(name === config.kbAddTool ? this.add(statement) : this.remove(statement));
  }

  private add(statement: string): unknown {
    // Pinned: the user asked for it, so a refine never edits or removes it.
    const patch = `ADD\n${statement.startsWith("[Pinned]") ? statement : `[Pinned] ${statement}`}`;
    let failed = false;
    const outcome = this.prompts.updateKnowledgeBase((current) => {
      const updated = applyKBPatch(current, patch);
      failed = updated === null;
      return updated;
    });
    log.debug(`KBTools: ${config.kbAddTool} ${failed ? "failed" : outcome}`);
    if (failed) return { error: "failed to update knowledge base" };
    if (outcome === "unsaved") return { error: "failed to persist knowledge base" };
    return outcome === "unchanged" ? "No change (duplicate or unchanged)." : "Added to knowledge base.";
  }

  private remove(statement: string): unknown {
    if (this.prompts.knowledgeBase === "") {
      log.debug(`KBTools: ${config.kbDelTool} on an empty knowledge base`);
      return { error: "knowledge base is empty" };
    }
    let failed = false;
    const outcome = this.prompts.updateKnowledgeBase((current) => {
      const updated = applyKBPatch(current, `DEL\n${statement}`);
      failed = updated === null;
      return updated;
    });
    log.debug(`KBTools: ${config.kbDelTool} ${failed ? "found nothing" : outcome}`);
    if (failed) return { error: "failed to delete from knowledge base (statement not found)" };
    if (outcome === "unsaved") return { error: "failed to persist knowledge base" };
    return outcome === "unchanged" ? { error: "statement not found in knowledge base" } : "Removed from knowledge base.";
  }
}
