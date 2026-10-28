// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Personalization } from "../agent/requests.js";
import * as config from "../config.js";
import { log } from "../log.js";
import { type KeyValueStore, type StoreProblem, storedString } from "../util/keyValueStore.js";
import { Observable } from "../util/observable.js";
import { compositionSections, extractBullets, extractSection, mergeFlatField, replaceSection } from "./bulletMerge.js";
import { defaultComposition, defaultKnowledgeBase } from "./defaults.js";

/** The keys Thunderbird and iOS keep the texts and their history under, kept the same so the three
 * apps' data reads alike. */
const Key = {
  composition: "user_prompts:user_composition.md",
  knowledgeBase: "user_prompts:user_kb.md",
  history: "prompt_history",
} as const;

export type PromptField = "composition" | "kb";

/** How a history entry came about: edits (in Settings or by the agent's tools), recorded
 * once they stop, or a reset or a restore, recorded before it. As iOS names them. */
export type PromptHistorySource = "local_edit" | "reset";

/** The two texts at one moment, kept so the user can put them back (iOS's `PromptHistoryEntry`,
 * without the fields Voice doesn't have). */
export interface PromptHistoryEntry {
  id: string;
  /** When it was recorded (ISO 8601). */
  timestamp: string;
  source: PromptHistorySource;
  /** The texts the event changed. */
  fields: PromptField[];
  composition: string;
  kb: string;
}

/** The writing style as agent requests send it: each section under "# <section>" with what it holds, a
 * section holding nothing left out. Without the rest of Thunderbird's document, whose "Strictly follow these
 * instructions in future responses" would also govern the chat window's replies (ADR-DESK-063). */
function sentWritingStyle(composition: string): string {
  return compositionSections
    .map((section) => ({ heading: `# ${section}`, body: extractSection(composition, section) }))
    .filter(({ body }) => body.trim() !== "")
    .map(({ heading, body }) => `${heading}\n${body}`)
    .join("\n\n");
}

/** Bullets as the texts hold them, one "- " line each: a bullet's line breaks become spaces, and an
 * empty one is left out. Split on the breaks and trimmed, rather than one pattern of spaces around
 * breaks, which takes time growing with the square of a long run of spaces. A bullet in `kept` (one
 * shown and left as it was) stays as it is stored, so saving one bullet changes no other: tidying an
 * untouched one (a text written elsewhere, as Thunderbird and iOS write it, can hold "-  Beta.") would make it another bullet, and a removal of it
 * made with the same list would miss it. */
function asBullets(bullets: readonly string[], kept: ReadonlySet<string> = new Set()): string {
  return bullets
    .map((bullet) =>
      kept.has(bullet)
        ? bullet
        : bullet
            .split(/[\r\n]+/)
            .map((line) => line.trim())
            .filter((line) => line !== "")
            .join(" "),
    )
    .filter((bullet) => bullet.trim() !== "")
    .map((bullet) => `- ${bullet}`)
    .join("\n");
}

/** `current` with the user's edit from `shown` to `edited`: `edited` as it is when `current` still
 * holds the bullets shown, else the edit merged into it three ways (`mergeFlatField`), so a bullet
 * `kb_add` added since the page showed is kept. */
function withEdit(current: string, shown: readonly string[], edited: readonly string[]): string {
  // The bullets as shown, not tidied: a stored one written elsewhere with a space after its
  // "- " must match itself, or its removal or edit is lost in the merge.
  const base = shown.map((bullet) => `- ${bullet}`).join("\n");
  const kept = new Set(shown);
  if (extractBullets(current).join("\n") === extractBullets(base).join("\n")) return asBullets(edited, kept);
  return mergeFlatField(base, current, asBullets(edited, kept));
}

function isHistoryEntry(value: unknown): value is PromptHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.timestamp === "string" &&
    (entry.source === "local_edit" || entry.source === "reset") &&
    Array.isArray(entry.fields) &&
    entry.fields.every((field) => field === "composition" || field === "kb") &&
    typeof entry.composition === "string" &&
    typeof entry.kb === "string"
  );
}

/**
 * The user's writing style and knowledge base (ADR-DESK-063), kept on this computer in their own
 * file, as Thunderbird's add-on keeps them: the writing style as its markdown with three sections of
 * bullets, the knowledge base as a list of bullets. Settings and the agent's `kb_add` and `kb_del`
 * all write through here, each reading the text and writing it back in one step, so no
 * write is lost to another. A text never written is its default, which reading it never stores.
 */
export class UserPrompts extends Observable {
  private pendingFields = new Set<PromptField>();
  private historyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly store: KeyValueStore) {
    super();
  }

  /** Why the texts' file couldn't be read at launch, until it is fixed or the user resets it: nothing
   * is saved to it meanwhile. */
  get fileProblem(): StoreProblem | undefined {
    return this.store.problem;
  }

  /** The user's factory reset of the texts' file (`moveAside`, which throws, changing nothing, when the
   * file can't be moved): both texts and their history read their defaults from here on. */
  resetFile(moveAside: () => void): void {
    moveAside();
    this.changed();
  }

  /** The writing style's markdown (`user_prompts:user_composition.md`). */
  get composition(): string {
    return storedString(this.store, Key.composition) ?? defaultComposition;
  }

  /** The knowledge base's bullets (`user_prompts:user_kb.md`). */
  get knowledgeBase(): string {
    return storedString(this.store, Key.knowledgeBase) ?? defaultKnowledgeBase;
  }

  /** Both texts as an agent request sends them, read now: the knowledge base whole, the writing
   * style's sections (`sentWritingStyle`). */
  get personalization(): Personalization {
    return { knowledgeBase: this.knowledgeBase, writingStyle: sentWritingStyle(this.composition) };
  }

  /** The user's edit in Settings of the writing style's `section`, from the bullets it showed
   * (`shown`) to `edited` (`withEdit`); false when it couldn't be saved (nothing changed then) or
   * there is no such section. */
  editCompositionSection(section: string, shown: readonly string[], edited: readonly string[]): boolean {
    if (!compositionSections.includes(section)) return false;
    const composition = this.composition;
    const updated = replaceSection(composition, section, withEdit(extractSection(composition, section), shown, edited));
    return updated === composition || this.save("composition", updated);
  }

  /** The user's edit in Settings of the knowledge base, from the bullets it showed (`shown`) to
   * `edited` (`withEdit`); false when it couldn't be saved (nothing changed then). */
  editKnowledgeBase(shown: readonly string[], edited: readonly string[]): boolean {
    return this.updateKnowledgeBase((current) => withEdit(current, shown, edited)) !== "unsaved";
  }

  /** Edits the knowledge base as it is now, in one step: `edit` is given the text and returns the new
   * one, or null to leave it. `unchanged` when it was left or came back the same, `unsaved` when it
   * couldn't be written (nothing changed then). */
  updateKnowledgeBase(edit: (current: string) => string | null): "saved" | "unchanged" | "unsaved" {
    const current = this.knowledgeBase;
    const updated = edit(current);
    if (updated === null || updated === current) return "unchanged";
    return this.save("kb", updated) ? "saved" : "unsaved";
  }

  /** Puts the writing style back to its default, recording it as it was first. */
  resetComposition(): boolean {
    return this.reset("composition", defaultComposition);
  }

  /** Puts the knowledge base back to its default, recording it as it was first. */
  resetKnowledgeBase(): boolean {
    return this.reset("kb", defaultKnowledgeBase);
  }

  /** The history, the newest last. */
  get history(): PromptHistoryEntry[] {
    const stored = this.store.get(Key.history);
    return Array.isArray(stored) ? stored.filter(isHistoryEntry) : [];
  }

  /** Puts back both texts as the history entry `id` holds them, recording them as they were first;
   * false when there is no such entry or they couldn't be saved. */
  restore(id: string): boolean {
    const entry = this.history.find((candidate) => candidate.id === id);
    if (entry === undefined) return false;
    this.flushHistory();
    this.record("reset", ["composition", "kb"]);
    const saved = this.write({ [Key.composition]: entry.composition, [Key.knowledgeBase]: entry.kb });
    if (saved) this.changed();
    return saved;
  }

  /** Records the edits waiting for their quiet period now: the app is quitting. */
  flushHistory(): void {
    if (this.historyTimer === null) return;
    clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.recordPending();
  }

  private reset(field: PromptField, value: string): boolean {
    this.flushHistory();
    this.record("reset", [field]);
    const saved = this.write({ [field === "kb" ? Key.knowledgeBase : Key.composition]: value });
    if (saved) this.changed();
    return saved;
  }

  /** Writes `field`, telling of the change and recording it once edits stop. */
  private save(field: PromptField, value: string): boolean {
    if (!this.write({ [field === "kb" ? Key.knowledgeBase : Key.composition]: value })) return false;
    log.debug(`UserPrompts: ${field} saved (${value.length} chars)`);
    this.pendingFields.add(field);
    if (this.historyTimer !== null) clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      this.recordPending();
      // Settings lists the history.
      this.changed();
    }, config.promptHistoryQuietPeriod);
    this.changed();
    return true;
  }

  /** Writes `values` together, in one write of the file; when it couldn't be written, puts them all
   * back and returns false: what applies is what is saved. One write for both, so a restore that
   * fails can't leave one text changed in the file. */
  private write(values: Record<string, string>): boolean {
    const before = Object.fromEntries(Object.keys(values).map((key) => [key, this.store.get(key)]));
    if (this.store.setAll(values)) return true;
    this.store.setAll(before);
    log.error("UserPrompts: couldn't be saved");
    return false;
  }

  private recordPending(): void {
    const fields = [...this.pendingFields];
    this.pendingFields = new Set();
    if (fields.length > 0) this.record("local_edit", fields);
  }

  /** Records both texts as they are now. A history that can't be written loses the entry only. */
  private record(source: PromptHistorySource, fields: PromptField[]): void {
    const entry: PromptHistoryEntry = { id: globalThis.crypto.randomUUID(), timestamp: new Date().toISOString(), source, fields, composition: this.composition, kb: this.knowledgeBase };
    const history = [...this.history, entry].slice(-config.promptHistoryMax);
    if (!this.store.set(Key.history, history)) log.error("UserPrompts: history entry not kept");
  }
}
