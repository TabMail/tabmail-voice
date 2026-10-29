// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import { log } from "../log.js";
import type { Bullet } from "../sync/bullets.js";
import { unsavedBecauseOf } from "../ui/fileProblems.js";
import { normalizeUnicode } from "./patchApplier.js";
import type { UserPrompts } from "./prompts.js";

/** A statement as a bullet's text, as Thunderbird's `patchApplier.js` writes it: without a leading
 * "- ", with a period after it if it has none. */
function bulletText(statement: string): string {
  const text = statement.startsWith("- ") ? statement.substring(2).trim() : statement.trim();
  return text.endsWith(".") ? text : `${text}.`;
}

/** A bullet as Thunderbird's `kb_del` compares it: its "- " line made plain, in lower case, without a
 * final period. */
function deletionKey(text: string): string {
  return normalizeUnicode(`- ${text}`).trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The agent loop's knowledge-base tools, run on this computer (ADR-DESK-063): `kb_add` keeps a
 * statement the user asked to be remembered, pinned, and `kb_del` removes one. A port of Thunderbird's
 * tools of the same names: the same argument, matching, results and errors, each result the JSON of
 * what the tool answers. They edit only the user's own knowledge base, so they ask nothing first.
 * `kb_del` removes only a bullet the request saw (`captured`, taken at key-down, DS-CAPTURE) or one
 * its own `kb_add` made, never one that arrived since.
 */
export class KBTools {
  /** The tools' names, as the loop offers them. */
  static readonly names: readonly string[] = [config.kbAddTool, config.kbDelTool];

  constructor(
    private readonly prompts: UserPrompts,
    private readonly captured: Bullet[] | null,
  ) {}

  /** Runs the tool `name` with `args` (the call's parsed arguments), and returns what the model reads. */
  run(name: string, args: Record<string, unknown>): string {
    // One line: a statement is one bullet, so a line break in it never becomes another edit.
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
    // Pinned: the user asked for it, so the knowledge-base refine Thunderbird and iOS run never edits or removes it.
    const text = bulletText(statement.startsWith("[Pinned]") ? statement : `[Pinned] ${statement}`);
    // A statement there already, whatever its case, is not added again.
    const wanted = `- ${text}`.toLowerCase();
    const live = this.prompts.sync.state("kb").bullets;
    if (live.some((bullet) => normalizeUnicode(`- ${bullet.text}`).toLowerCase() === wanted)) {
      log.debug(`KBTools: ${config.kbAddTool} unchanged`);
      return "No change (duplicate or unchanged).";
    }
    const { outcome } = this.prompts.addKnowledge(text);
    log.debug(`KBTools: ${config.kbAddTool} ${outcome}`);
    if (outcome === "unsaved") return { error: this.unsaved() };
    if (outcome === "unchanged") return "No change (duplicate or unchanged).";
    // What it added is the request's own, for a `kb_del` after it.
    this.captured?.push(...this.prompts.sync.state("kb").bullets.filter((bullet) => bullet.section === "" && bullet.text === text));
    return "Added to knowledge base.";
  }

  private remove(statement: string): unknown {
    if (this.prompts.knowledgeBase === "") {
      log.debug(`KBTools: ${config.kbDelTool} on an empty knowledge base`);
      return { error: "knowledge base is empty" };
    }
    // R22: the request's read was refused while the knowledge base's upgrade was unsaved.
    if (this.captured === null) return { error: this.unsaved() };
    const wanted = deletionKey(bulletText(statement));
    const match = this.captured.find((bullet) => bullet.section === "" && deletionKey(bullet.text) === wanted);
    if (match === undefined) {
      log.debug(`KBTools: ${config.kbDelTool} found nothing`);
      return { error: "failed to delete from knowledge base (statement not found)" };
    }
    const { outcome } = this.prompts.removeKnowledge(this.captured, { section: "", text: match.text });
    log.debug(`KBTools: ${config.kbDelTool} ${outcome}`);
    if (outcome === "unsaved") return { error: this.unsaved() };
    return outcome === "unchanged" ? { error: "statement not found in knowledge base" } : "Removed from knowledge base.";
  }

  /** A knowledge base that couldn't be saved: how to fix its file when it couldn't be read, for the
   * model to tell the user. */
  private unsaved(): string {
    return this.prompts.fileProblem === undefined ? "failed to persist knowledge base" : unsavedBecauseOf("knowledgeBase");
  }
}
