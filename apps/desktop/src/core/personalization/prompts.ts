// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Personalization } from "../agent/requests.js";
import * as config from "../config.js";
import { log } from "../log.js";
import { type Bullet, type BulletText, type Catalog, displayedSections, type FieldState, hasLineBreak, isMarkerText, isName, parse, render, sectionHeaders, trim } from "../sync/bullets.js";
import { BulletSync, type BulletStore, type CapturedChange, type CommitKind, type CommitResult } from "../sync/bulletSync.js";
import { type KeyValueStore, type StoreProblem, storedString } from "../util/keyValueStore.js";
import { Observable } from "../util/observable.js";
import { defaultComposition } from "./defaults.js";

export type PromptField = "composition" | "kb";

/** The fields Voice keeps and syncs (Device Sync's `kb` and `composition`; the action rules are
 * Thunderbird's and iOS's). */
export const promptFields: readonly PromptField[] = ["kb", "composition"];

const Key = {
  /** Each field's labelled bullets, seen map and skeleton (`StoredField`), kept together. */
  state: (field: PromptField) => `bullet_state:${field}`,
  /** The texts as Voice kept them before labelled bullets (Thunderbird's and iOS's key names): read
   * once, to upgrade, then removed. */
  legacyText: (field: PromptField) => (field === "kb" ? "user_prompts:user_kb.md" : "user_prompts:user_composition.md"),
  history: "prompt_history",
  /** The TabMail account the texts belong to (iOS's name). */
  owner: "device_sync_owner_user_id",
} as const;

/** Keys a development build kept for an earlier Device Sync merge: removed with the upgrade. */
const retiredKeys = (field: PromptField) => [`device_sync_ts:${field}`, `device_peer_base:${field}`, `device_peer_base_ts:${field}`];

/** One field as stored: its skeleton lines, live bullets (section, text, name, n) and seen map. */
interface StoredField {
  head: string[];
  tail: string[];
  bullets: [string, string, string, number][];
  seen: Record<string, number>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}

/** A stored field read back; what isn't one is left out, and said. */
function storedState(field: PromptField, value: unknown): FieldState | null {
  if (typeof value !== "object" || value === null) return null;
  const stored = value as Partial<Record<keyof StoredField, unknown>>;
  const bullets: Bullet[] = [];
  let skipped = 0;
  for (const entry of Array.isArray(stored.bullets) ? stored.bullets : []) {
    const [section, text, name, n] = Array.isArray(entry) ? (entry as unknown[]) : [];
    if (typeof section === "string" && typeof text === "string" && text !== "" && trim(text) === text && !hasLineBreak(text) && isName(name) && Number.isSafeInteger(n) && (n as number) >= 1) {
      bullets.push({ section, text, name, n: n as number });
    } else skipped += 1;
  }
  const seen = new Map<string, number>();
  if (typeof stored.seen === "object" && stored.seen !== null) {
    for (const [name, n] of Object.entries(stored.seen)) {
      if (Number.isSafeInteger(n) && (n as number) >= 0) seen.set(name, n as number);
      else skipped += 1;
    }
  }
  if (skipped > 0) log.error(`UserPrompts: ${field} held ${skipped} entries that aren't bullets or seen counters; left out`);
  return { head: isStringArray(stored.head) ? stored.head : [], tail: isStringArray(stored.tail) ? stored.tail : [], bullets, seen };
}

function toStored(state: FieldState): StoredField {
  return {
    head: state.head,
    tail: state.tail,
    bullets: state.bullets.map((bullet) => [bullet.section, bullet.text, bullet.name, bullet.n]),
    seen: Object.fromEntries(state.seen),
  };
}

/** The built-in skeletons (DS-SKELETON): the default texts' lines around their sections. */
const builtInSkeleton: Record<PromptField, Pick<FieldState, "head" | "tail">> = {
  kb: { head: [], tail: [] },
  composition: (({ head, tail }) => ({ head, tail }))(parse("composition", defaultComposition)),
};

/** A bullet as the user typed it in Settings, as a bullet's text (DS-TEXT): its line breaks become
 * spaces and it is trimmed; empty when nothing is left. */
function bulletText(typed: string): string {
  return typed
    .split(/\r\n|\r|\n/)
    .map(trim)
    .filter((line) => line !== "")
    .join(" ");
}

/** Whether a line typed for the writing style holds the section-header mark or the END marker, which
 * would be read back as a header or the skeleton (R23): Settings refuses the edit. */
export function holdsSectionMarker(edited: readonly string[]): boolean {
  return edited.some((typed) => isMarkerText("composition", bulletText(typed)));
}

/** How a history entry came about: edits (in Settings or by the agent's tools), recorded
 * once they stop, or a reset or a restore, recorded before it, or what Device Sync received,
 * recorded before it applied. As iOS names them. */
export type PromptHistorySource = "local_edit" | "reset" | "sync_receive";

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

/** A bullet as Settings showed it: its text and the labels it had then (DS-CAPTURE), which an edit
 * hands back. */
export interface ShownBullet {
  text: string;
  labels: [string, number][];
}

/** What an agent request took of the knowledge base at key-down: the write generation then, which its
 * `kb_add` and `kb_del` need unchanged to write (root ADR-035), and the live labels its `kb_del` may
 * delete (DS-CAPTURE), null while the upgrade is unsaved (R22). */
export interface KnowledgeCapture {
  generation: number;
  bullets: Bullet[] | null;
}

/** The writing style as agent requests send it: each section under "# <section>" with what it holds, a
 * section holding nothing left out. Without the rest of Thunderbird's document, whose "Strictly follow these
 * instructions in future responses" would also govern the chat window's replies (ADR-DESK-063). */
function sentWritingStyle(state: FieldState): string {
  return sectionHeaders.composition
    .map(([key, name]) => ({ heading: `# ${name}`, body: state.bullets.filter((bullet) => bullet.section === key).map((bullet) => `- ${bullet.text}`) }))
    .filter(({ body }) => body.length > 0)
    .map(({ heading, body }) => `${heading}\n${body.join("\n")}`)
    .join("\n\n");
}

function isHistoryEntry(value: unknown): value is PromptHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.timestamp === "string" &&
    (entry.source === "local_edit" || entry.source === "reset" || entry.source === "sync_receive") &&
    Array.isArray(entry.fields) &&
    entry.fields.every((field) => field === "composition" || field === "kb") &&
    typeof entry.composition === "string" &&
    typeof entry.kb === "string"
  );
}

function randomHex(bytes: number): string {
  return [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface UserPromptsOptions {
  /** A fresh writer name (DS-NAME): tests give their own. */
  newName?: () => string;
  /** The relay's message budget in bytes (DS-CHUNK): tests give a small one. */
  budget?: () => number;
  /** The default catalog (DS-DEFAULT): tests give one a newer app would have. */
  catalog?: Catalog;
}

/**
 * The user's writing style and knowledge base (ADR-DESK-063), kept on this computer in their own file
 * as labelled bullets (ADR-DESK-066), the same model Thunderbird and iOS keep: each field's bullets
 * with their labels, its seen map and its own skeleton, in one value. Settings, the agent's `kb_add`
 * and `kb_del`, history and resets change them through `sync` (`BulletSync`), one commit at a time,
 * and Device Sync merges into them through it. The texts shown and sent to the model are rendered
 * from them.
 */
export class UserPrompts extends Observable implements BulletStore {
  private pendingFields = new Set<PromptField>();
  /** Root ADR-035: counts what an agent request's knowledge-base writes must not come after, in memory
   * only: each change saved from Settings (an edit, a reset, a restore), the texts' file reset, another
   * account's texts taken, and an account change. */
  private generation = 0;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  /** The engine every change goes through. */
  readonly sync: BulletSync;
  /** Called after the user, the agent's tools, a history restore, a reset or a saved upgrade changed a
   * field here: Device Sync sends it (DS-SEND, R20). Never for what Device Sync merged. */
  onLocalChange: ((field: PromptField) => void) | undefined;

  constructor(
    private readonly store: KeyValueStore,
    /** The signed-in account's ID, read now; null while signed out. */
    private readonly signedIn: () => string | null,
    options: UserPromptsOptions = {},
  ) {
    super();
    this.sync = new BulletSync({
      store: this,
      fields: promptFields,
      skeleton: (field) => builtInSkeleton[field as PromptField],
      newName: options.newName ?? (() => randomHex(8)),
      newID: () => randomHex(8),
      budget: options.budget ?? (() => config.deviceSyncMessageMaxBytes),
      error: (message) => log.error(message),
      catalog: options.catalog,
    });
  }

  /** Root ADR-035, the one check every read and write of the texts makes: they are shown, sent and
   * changed only while an account is signed in and they are its own, or no account's yet (the claim
   * makes them its own then). While signed out, and while another account's texts couldn't be wiped,
   * every reader gets nothing and every write is refused; only that wipe is let through. */
  get isAvailable(): boolean {
    const account = this.signedIn();
    if (account === null) return false;
    const owner = this.owner;
    return owner === null || owner === account;
  }

  /** Why the texts' file couldn't be read at launch, until it is fixed or the user resets it: nothing
   * is saved to it meanwhile. */
  get fileProblem(): StoreProblem | undefined {
    return this.store.problem;
  }

  /** The user's factory reset of the texts' file (`moveAside`, which throws, changing nothing, when the
   * file can't be moved): DS-RESET of both fields, and their history gone. */
  resetFile(moveAside: () => void): void {
    moveAside();
    this.generation += 1;
    this.sync.reload();
    this.dropPendingHistory();
    this.changed();
    for (const field of promptFields) this.onLocalChange?.(field);
  }

  /** The writing style's markdown, rendered (DS-RENDER). */
  get composition(): string {
    if (!this.isAvailable) return "";
    return render("composition", this.sync.state("composition"));
  }

  /** The knowledge base's bullets, rendered. */
  get knowledgeBase(): string {
    if (!this.isAvailable) return "";
    return render("kb", this.sync.state("kb"));
  }

  /** Both texts as an agent request sends them, read now: the knowledge base whole, the writing
   * style's sections (`sentWritingStyle`). */
  get personalization(): Personalization {
    if (!this.isAvailable) return { knowledgeBase: "", writingStyle: "" };
    return { knowledgeBase: this.knowledgeBase, writingStyle: sentWritingStyle(this.sync.state("composition")) };
  }

  /** The live bullets of `field`'s `section`, in order, as Settings shows them. While an upgrade is
   * unsaved they carry no labels, and an edit of them is refused (R22). */
  shown(field: PromptField, section: string): ShownBullet[] {
    if (!this.isAvailable) return [];
    const captured = this.sync.capture(field, [section]);
    if (captured === null) return this.sync.state(field).bullets.filter((bullet) => bullet.section === section).map((bullet) => ({ text: bullet.text, labels: [] }));
    return captured.map((bullet) => ({ text: bullet.text, labels: [[bullet.name, bullet.n]] }));
  }

  /** The knowledge base as an agent request takes it at key-down (`KnowledgeCapture`). */
  captureKnowledgeBase(): KnowledgeCapture {
    return { generation: this.generation, bullets: this.isAvailable ? this.sync.capture("kb", [""]) : [] };
  }

  /** Root ADR-035, the one check an agent request's knowledge-base writes make: nothing was saved from
   * Settings, and the account didn't change, since it took `captured`. */
  isCurrent(captured: KnowledgeCapture): boolean {
    return captured.generation === this.generation;
  }

  /** The signed-in account changed (signed out, or in): no agent request from before writes. */
  accountChanged(): void {
    this.generation += 1;
  }

  /** The user's edit in Settings of the writing style's section `section` (its key), from the bullets
   * it showed to `edited` (DS-CAPTURE); false when it couldn't be saved (nothing changed then) or there
   * is no such section. */
  editCompositionSection(section: string, shown: readonly ShownBullet[], edited: readonly string[]): boolean {
    if (!displayedSections("composition").includes(section)) return false;
    return this.editSection("composition", section, shown, edited);
  }

  /** The user's edit in Settings of the knowledge base, from the bullets it showed to `edited`. */
  editKnowledgeBase(shown: readonly ShownBullet[], edited: readonly string[]): boolean {
    return this.editSection("kb", "", shown, edited);
  }

  /** `kb_add`: DS-ADD of `text` to the knowledge base. */
  addKnowledge(text: string): CommitResult {
    return this.local(this.sync.add("kb", [{ section: "", text }]));
  }

  /** `kb_del`: of the labels an agent request captured, those of `item` deleted (DS-CAPTURE). */
  removeKnowledge(captured: readonly Bullet[], item: BulletText): CommitResult {
    const labels = captured.filter((bullet) => bullet.section === item.section && bullet.text === item.text);
    return this.local(this.sync.commitCapture([{ field: "kb", captured: labels, result: [] }]));
  }

  /** DS-RESET of the writing style, recorded first. */
  resetComposition(): boolean {
    return this.reset("composition");
  }

  /** DS-RESET of the knowledge base, recorded first. */
  resetKnowledgeBase(): boolean {
    return this.reset("kb");
  }

  /** The history, the newest last. */
  get history(): PromptHistoryEntry[] {
    if (!this.isAvailable) return [];
    const stored = this.store.get(Key.history);
    return Array.isArray(stored) ? stored.filter(isHistoryEntry) : [];
  }

  /** Puts back both texts as the history entry `id` holds them, recording them as they were first:
   * a user edit captured now (DS-VOICE, R6), in the sections Settings shows; false when there is no such
   * entry or it couldn't be saved. */
  restore(id: string): boolean {
    const entry = this.history.find((candidate) => candidate.id === id);
    if (entry === undefined) return false;
    this.flushHistory();
    this.record("reset", [...promptFields]);
    const changes: CapturedChange[] = [];
    for (const field of promptFields) {
      const sections = displayedSections(field);
      const captured = this.sync.capture(field, sections);
      // R22: refused while an upgrade is unsaved.
      if (captured === null) return false;
      changes.push({ field, captured, result: parse(field, field === "kb" ? entry.kb : entry.composition).bullets.filter((bullet) => sections.includes(bullet.section)) });
    }
    return this.fromSettings(this.local(this.sync.commitCapture(changes))).outcome !== "unsaved";
  }

  /** The TabMail account the texts belong to; null before one signed in. */
  get owner(): string | null {
    return storedString(this.store, Key.owner);
  }

  /** Makes the texts the signed-in account's (iOS ADR-IOS-089): kept when they are its own already,
   * taken as they are when they belong to no account yet, and wiped first, back at their defaults with
   * no history, when they belong to another (root ADR-035: never a merge on top). False when the wipe
   * couldn't be saved: the texts are still the other account's, and that sign-in fails
   * (`AccountModel.admit`). */
  claim(userID: string): boolean {
    const owner = this.owner;
    if (owner === userID) return true;
    if (owner === null) return this.save({ [Key.owner]: userID });
    const texts: Record<string, unknown> = { [Key.history]: undefined };
    for (const field of promptFields) for (const key of [Key.state(field), Key.legacyText(field), ...retiredKeys(field)]) texts[key] = undefined;
    if (!this.save({ ...texts, [Key.owner]: userID })) return false;
    this.wiped();
    return true;
  }

  /** The texts are another account's no more (root ADR-035): no agent request from before writes, the
   * writer name is fresh, edits waiting to be recorded are not the next account's history, and Settings
   * shows the defaults. */
  private wiped(): void {
    this.generation += 1;
    this.sync.reload();
    this.dropPendingHistory();
    log.debug("UserPrompts: another account signed in; knowledge base and writing style back to defaults");
    this.changed();
  }

  /** Records the edits waiting for their quiet period now: the app is quitting. */
  flushHistory(): void {
    if (this.historyTimer === null) return;
    clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.recordPending();
  }

  // MARK: BulletStore

  read(field: PromptField): FieldState | null {
    const value = this.store.get(Key.state(field));
    return value === undefined ? null : storedState(field, value);
  }

  legacyText(field: PromptField): string | null {
    return storedString(this.store, Key.legacyText(field));
  }

  /** Writes the fields' states in one write, the texts from before and retired keys removed with them.
   * A merge that changes a text is recorded in the history first (`sync_receive`). */
  write(states: Partial<Record<PromptField, FieldState>>, kind: CommitKind): boolean {
    const fields = promptFields.filter((field) => states[field] !== undefined);
    if (kind === "sync") {
      const changed = fields.filter((field) => render(field, states[field] as FieldState) !== render(field, this.sync.state(field)));
      if (changed.length > 0) {
        this.flushHistory();
        this.record("sync_receive", changed);
      }
    }
    const written: Record<string, unknown> = {};
    for (const field of fields) {
      written[Key.state(field)] = toStored(states[field] as FieldState);
      for (const key of [Key.legacyText(field), ...retiredKeys(field)]) written[key] = undefined;
    }
    if (!this.writeValues(written)) return false;
    log.debug(`UserPrompts: ${fields.join(", ")} saved (${kind})`);
    this.changed();
    // R20: an upgrade saved on whichever read or commit ran it sends every field it saved.
    if (kind === "upgrade") for (const field of fields) this.onLocalChange?.(field);
    return true;
  }

  // MARK: Private

  private editSection(field: PromptField, section: string, shown: readonly ShownBullet[], edited: readonly string[]): boolean {
    // R22: bullets shown while an upgrade was unsaved carry no labels, and nothing is saved from them.
    if (shown.some((bullet) => bullet.labels.length === 0)) return false;
    const captured = shown.flatMap((bullet) => bullet.labels.map(([name, n]) => ({ section, text: bullet.text, name, n })));
    const result = edited.map((typed) => ({ section, text: bulletText(typed) })).filter((bullet) => bullet.text !== "");
    return this.fromSettings(this.local(this.sync.commitCapture([{ field, captured, result }]))).outcome !== "unsaved";
  }

  private reset(field: PromptField): boolean {
    this.flushHistory();
    this.record("reset", [field]);
    return this.fromSettings(this.local(this.sync.reset([field]), false)).outcome === "saved";
  }

  /** A change from Settings, saved: no agent request from before it writes (root ADR-035). */
  private fromSettings(result: CommitResult): CommitResult {
    if (result.outcome === "saved") this.generation += 1;
    return result;
  }

  /** After a local commit: its fields recorded once edits stop (`edits`), and sent. */
  private local(result: CommitResult, edits = true): CommitResult {
    const fields = result.fields as PromptField[];
    if (result.outcome === "saved") {
      if (edits) this.pending(fields);
      for (const field of fields) this.onLocalChange?.(field);
    }
    return result;
  }

  private pending(fields: readonly PromptField[]): void {
    for (const field of fields) this.pendingFields.add(field);
    if (this.historyTimer !== null) clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      this.recordPending();
      // Settings lists the history.
      this.changed();
    }, config.promptHistoryQuietPeriod);
  }

  private dropPendingHistory(): void {
    if (this.historyTimer !== null) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.pendingFields = new Set();
  }

  /** The one function every write of the texts goes through (root ADR-035): refused, changing nothing,
   * while they aren't available (`isAvailable`). */
  private writeValues(values: Record<string, unknown>): boolean {
    if (!this.isAvailable) {
      log.debug("UserPrompts: not saved: signed out, or the texts are another account's");
      return false;
    }
    return this.save(values);
  }

  /** Writes `values` together, in one write of the file; when it couldn't be written, puts them all
   * back and returns false: what applies is what is saved. Only `writeValues` and the claim call it. */
  private save(values: Record<string, unknown>): boolean {
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
    if (!this.isAvailable) return;
    const entry: PromptHistoryEntry = { id: globalThis.crypto.randomUUID(), timestamp: new Date().toISOString(), source, fields, composition: this.composition, kb: this.knowledgeBase };
    const history = [...this.history, entry].slice(-config.promptHistoryMax);
    if (!this.store.set(Key.history, history)) log.error("UserPrompts: history entry not kept");
  }
}
