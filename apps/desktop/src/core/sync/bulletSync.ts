// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  add,
  type Bullet,
  type BulletText,
  type Catalog,
  commitCapture,
  defaultCatalog,
  defaultState,
  epochZero,
  type FieldState,
  hasLineBreak,
  importLegacy,
  isName,
  type LabelSource,
  merge,
  sameState,
  type SyncField,
  syncFields,
  trim,
  upgrade,
} from "./bullets.js";

/** Where a device keeps its fields. */
export interface BulletStore {
  /** The field as stored, or null when there is none yet. */
  read(field: SyncField): FieldState | null;
  /** The field's text as the app kept it before labelled bullets, or null: DS-UPGRADE takes it. */
  legacyText(field: SyncField): string | null;
  /** Writes every state given in one atomic write (DS-ATOMIC); false when it couldn't be saved, and
   * nothing changed then. `kind` says what wrote it, for the app's history. */
  write(states: Partial<Record<SyncField, FieldState>>, kind: CommitKind): boolean;
}

export type CommitKind = "edit" | "reset" | "sync" | "upgrade";

export type CommitOutcome = "saved" | "unchanged" | "unsaved";

/** A local commit's outcome, and the fields it changed (saved). */
export interface CommitResult {
  outcome: CommitOutcome;
  fields: SyncField[];
}

/** One field's part of a captured operation's commit (DS-CAPTURE). */
export interface CapturedChange {
  field: SyncField;
  captured: readonly Bullet[];
  result: readonly BulletText[];
}

export interface BulletSyncOptions {
  store: BulletStore;
  /** The fields this app syncs (DS-VOICE: Voice, kb and composition). */
  fields: readonly SyncField[];
  /** The app's built-in skeleton of `field` (DS-SKELETON). */
  skeleton(field: SyncField): Pick<FieldState, "head" | "tail">;
  /** A fresh writer name: 16 lowercase hex characters from a cryptographic random source. */
  newName(): string;
  /** A random id for this process's sender and each snapshot. */
  newID(): string;
  /** The relay's budget for one message (bytes, DS-CHUNK). */
  budget(): number;
  /** What is logged as an error: the field and a reason, label or sizes, never a text. */
  error(message: string): void;
  catalog?: Catalog;
}

/** One `bullet_state` message (DS-WIRE). */
export interface BulletStateMessage {
  type: "bullet_state";
  v: 1;
  field: SyncField;
  sender: string;
  snap: string;
  part: number;
  parts: number;
  bullets: [string, string, string, number][];
  seen: Record<string, number>;
}

export type Outgoing = { kind: "messages"; messages: BulletStateMessage[] } | { kind: "oversize"; bytes: number; budget: number };

export type ReceiveOutcome =
  /** Not for this app: another type, or a field it doesn't sync (DS-VOICE). */
  | { kind: "ignored" }
  /** DS-VALIDATE: dropped whole. */
  | { kind: "invalid"; field: string; reason: string }
  /** A part buffered; the snapshot isn't complete (DS-CHUNK-APPLY). */
  | { kind: "partial" }
  /** DS-MERGE-3: refused whole. */
  | { kind: "conflict"; field: SyncField }
  | { kind: "unsaved"; field: SyncField }
  /** Merged: `changed` when the state changed, `send` when DS-SEND has this device answer. */
  | { kind: "merged"; field: SyncField; changed: boolean; send: boolean };

interface PartBuffer {
  /** The snapshot's id as the sender gave it (DS-VALIDATE puts no rule on it). */
  snap: unknown;
  parts: number;
  seen: string;
  received: Map<number, string>;
  bullets: Map<number, Bullet[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown, least: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= least;
}

function isField(value: unknown): value is SyncField {
  return typeof value === "string" && (syncFields as readonly string[]).includes(value);
}

/** The bullets of a part, or the DS-VALIDATE reason they are dropped. */
function validBullets(value: unknown): Bullet[] | string {
  if (!Array.isArray(value)) return "bullets";
  const bullets: Bullet[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 4) return "bullet";
    const [section, text, name, n] = entry as unknown[];
    if (typeof section !== "string") return "section";
    if (typeof text !== "string" || text === "" || trim(text) !== text || hasLineBreak(text)) return "text";
    if (!isName(name)) return "name";
    if (!isCount(n, 1)) return "counter";
    bullets.push({ section, text, name, n });
  }
  return bullets;
}

/** The seen map of a part, or null when a value isn't an integer >= 0. */
function validSeen(value: unknown): Map<string, number> | null {
  if (!isRecord(value)) return null;
  const seen = new Map<string, number>();
  for (const [name, n] of Object.entries(value)) {
    // R18: a key is a name as a bullet's is.
    if (!isName(name) || !isCount(n, 0)) return null;
    seen.set(name, n);
  }
  return seen;
}

/** A seen map compared between parts: its entries in order of name. */
function seenKey(seen: Map<string, number>): string {
  return JSON.stringify([...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/**
 * One device's Device Sync of its labelled bullets (ADR-DESK-066): the local operations, each one
 * read-change-save commit (DS-LOCK: JavaScript runs one at a time and every commit re-reads the store),
 * the messages it sends and the merge of those it receives. Free of the transport: the app sends what
 * `outgoing` gives and passes `receive` what arrives.
 */
export class BulletSync {
  /** This process's sender id (DS-WIRE), never persisted. */
  readonly sender: string;
  /** The current writer name and its last counter: memory only (DS-NAME). */
  private writer: { name: string; n: number } | null = null;
  /** The names on the bullets of the last complete snapshot merged for each field (DS-SEEN-OUT). */
  private readonly lastMerged = new Map<SyncField, Set<string>>();
  /** Parts of incomplete snapshots, per sender and field (DS-CHUNK). */
  private readonly buffers = new Map<string, PartBuffer>();
  private readonly catalog: Catalog;

  constructor(private readonly options: BulletSyncOptions) {
    this.sender = options.newID();
    this.catalog = options.catalog ?? defaultCatalog;
  }

  /** `field` as it is now, after DS-UPGRADE when it hasn't run; a new install's defaults when nothing
   * is stored (DS-DEFAULT). */
  state(field: SyncField): FieldState {
    return this.upgraded()[field] ?? this.stored(field);
  }

  /** DS-UPGRADE: each field with no labelled state yet but a text from before is parsed and labelled,
   * all in one commit. Returns the states when that couldn't be saved, for showing until it can. */
  upgraded(): Partial<Record<SyncField, FieldState>> {
    const states: Partial<Record<SyncField, FieldState>> = {};
    for (const field of this.options.fields) {
      if (this.options.store.read(field) !== null) continue;
      const text = this.options.store.legacyText(field);
      if (text !== null) states[field] = upgrade(field, text, this.labels(), this.catalog);
    }
    if (Object.keys(states).length === 0) return {};
    if (this.write(states, "upgrade")) return {};
    return states;
  }

  /** DS-ADD of `items`. */
  add(field: SyncField, items: readonly BulletText[]): CommitResult {
    return this.commit([[field, (state) => add(state, items, this.labels())]], "edit");
  }

  /** DS-CAPTURE: the live labels of `sections` (all when not given), to commit against later. */
  capture(field: SyncField, sections?: readonly string[]): Bullet[] {
    return this.state(field).bullets.filter((bullet) => sections === undefined || sections.includes(bullet.section));
  }

  /** DS-CAPTURE's commit, of one or more fields in one write: each `result` the operation's bullets for
   * what it captured. */
  commitCapture(changes: readonly CapturedChange[]): CommitResult {
    return this.commit(
      changes.map((change): [SyncField, (state: FieldState) => FieldState] => [change.field, (state) => commitCapture(state, change.captured, change.result, this.labels())]),
      "edit",
    );
  }

  /** DS-RESET of `fields`, in one commit: bullets and seen map cleared together, the defaults added,
   * the writer name abandoned. */
  reset(fields: readonly SyncField[]): CommitResult {
    this.abandonName();
    const states: Partial<Record<SyncField, FieldState>> = {};
    for (const field of fields) states[field] = defaultState(field, this.options.skeleton(field), this.catalog);
    return this.write(states, "reset") ? { outcome: "saved", fields: [...fields] } : { outcome: "unsaved", fields: [] };
  }

  /** DS-NAME-ABANDON for an in-process reload of the fields from storage: the next add uses a fresh
   * name, and what was merged before is forgotten. */
  reload(): void {
    this.abandonName();
    this.lastMerged.clear();
    this.buffers.clear();
  }

  /** The connection ended: incomplete snapshots are dropped (DS-CHUNK). */
  disconnected(): void {
    this.buffers.clear();
  }

  /** DS-LEGACY-IN: a released device's `prompt_state` data, additions only. Returns the fields it
   * changed, saved. */
  receiveLegacy(data: unknown): SyncField[] {
    if (!isRecord(data)) return [];
    const changed: SyncField[] = [];
    for (const field of this.options.fields) {
      const text = data[field];
      if (typeof text !== "string") continue;
      // Released Thunderbird's and iOS's own reading of the time.
      const time = data[`${field}_updated_at`] || data.updatedAt || epochZero;
      if (time === epochZero) continue;
      if (this.commit([[field, (state) => importLegacy(field, state, text, this.labels(), this.catalog)]], "sync").outcome === "saved") changed.push(field);
    }
    return changed;
  }

  /** A `bullet_state` message: validated (DS-VALIDATE), buffered until complete (DS-CHUNK-APPLY), then
   * merged (§6). */
  receive(message: unknown): ReceiveOutcome {
    if (!isRecord(message) || message.type !== "bullet_state") return { kind: "ignored" };
    const field = message.field;
    if (!isField(field)) return this.invalid(String(typeof field === "string" ? "unknown" : typeof field), "field");
    if (!this.options.fields.includes(field)) return { kind: "ignored" };
    const { sender, snap, part, parts } = message;
    const key = `${String(sender)}\u0000${field}`;
    // R19: a refused part drops the snapshot it belongs to, so no later part can complete it.
    const refuse = (reason: string): ReceiveOutcome => {
      if (this.buffers.get(key)?.snap === snap) this.buffers.delete(key);
      return this.invalid(field, reason);
    };
    if (message.v !== 1) return refuse("version");
    if (!isCount(parts, 1) || !isCount(part, 1) || part > parts) return refuse("part");
    const bullets = validBullets(message.bullets);
    if (typeof bullets === "string") return refuse(bullets);
    const seen = validSeen(message.seen);
    if (seen === null) return refuse("seen");

    let buffer = this.buffers.get(key);
    // A part of another snapshot from the same sender for the field replaces what was buffered.
    if (buffer === undefined || buffer.snap !== snap) {
      buffer = { snap, parts, seen: seenKey(seen), received: new Map(), bullets: new Map() };
      this.buffers.set(key, buffer);
    }
    const content = JSON.stringify(message.bullets);
    // R5: parts that disagree drop the snapshot; an identical duplicate part is ignored.
    if (buffer.parts !== parts || buffer.seen !== seenKey(seen) || (buffer.received.has(part) && buffer.received.get(part) !== content)) {
      this.buffers.delete(key);
      return this.invalid(field, "part");
    }
    buffer.received.set(part, content);
    buffer.bullets.set(part, bullets);
    if (buffer.received.size < parts) return { kind: "partial" };
    this.buffers.delete(key);
    const all: Bullet[] = [];
    for (let index = 1; index <= parts; index += 1) all.push(...(buffer.bullets.get(index) ?? []));
    return this.mergeSnapshot(field, all, seen);
  }

  /** What to send for `field` now (DS-WIRE, DS-SEEN-OUT, DS-CHUNK), or that one bullet alone is over the
   * budget (DS-OVERSIZE). */
  outgoing(field: SyncField): Outgoing {
    // DS-UPGRADE step 6: commit, then send. An upgrade not saved yet is shown, never sent.
    if (Object.keys(this.upgraded()).length > 0) return { kind: "messages", messages: [] };
    const state = this.stored(field);
    const names = new Set(state.bullets.map((bullet) => bullet.name));
    for (const name of this.lastMerged.get(field) ?? []) names.add(name);
    const seen = Object.fromEntries([...names].flatMap((name) => (state.seen.has(name) ? [[name, state.seen.get(name) as number]] : [])));
    const tuples = state.bullets.map((bullet): [string, string, string, number] => [bullet.section, bullet.text, bullet.name, bullet.n]);
    const snap = this.options.newID();
    const budget = this.options.budget();
    const message = (part: number, parts: number, bullets: [string, string, string, number][]): BulletStateMessage => ({
      type: "bullet_state",
      v: 1,
      field,
      sender: this.sender,
      snap,
      part,
      parts,
      bullets,
      seen,
    });
    const whole = message(1, 1, tuples);
    if (byteLength(JSON.stringify(whole)) <= budget) return { kind: "messages", messages: [whole] };
    // Measured with the largest part number there can be, so a part's number never takes it over.
    const most = Math.max(1, tuples.length);
    const envelope = byteLength(JSON.stringify(message(most, most, [])));
    const groups: [string, string, string, number][][] = [];
    let group: [string, string, string, number][] = [];
    let size = envelope;
    for (const tuple of tuples) {
      const bytes = byteLength(JSON.stringify(tuple));
      if (envelope + bytes > budget) {
        this.options.error(`DeviceSync: ${field} not sent: one bullet makes a ${envelope + bytes}-byte message, over the relay's ${budget}`);
        return { kind: "oversize", bytes: envelope + bytes, budget };
      }
      const added = group.length === 0 ? bytes : bytes + 1;
      if (size + added > budget) {
        groups.push(group);
        group = [];
        size = envelope;
      }
      size += group.length === 0 ? bytes : bytes + 1;
      group.push(tuple);
    }
    groups.push(group);
    return { kind: "messages", messages: groups.map((bullets, index) => message(index + 1, groups.length, bullets)) };
  }

  private mergeSnapshot(field: SyncField, bullets: Bullet[], seen: Map<string, number>): ReceiveOutcome {
    // Nothing is merged into an upgrade not saved yet: the upgrade commits all its fields at once.
    if (Object.keys(this.upgraded()).length > 0) return { kind: "unsaved", field };
    const local = this.stored(field);
    const result = merge(local, { bullets, seen });
    if (result.kind === "conflict") {
      this.options.error(`DeviceSync: ${field} refused: label ${result.label.name}/${result.label.n} holds another text or section`);
      return { kind: "conflict", field };
    }
    const changed = !sameState(local, result.state);
    if (changed && !this.write({ [field]: result.state }, "sync")) return { kind: "unsaved", field };
    this.lastMerged.set(field, new Set(bullets.map((bullet) => bullet.name)));
    return { kind: "merged", field, changed, send: result.differed };
  }

  private invalid(field: string, reason: string): ReceiveOutcome {
    this.options.error(`DeviceSync: a ${field} snapshot dropped (${reason})`);
    return { kind: "invalid", field, reason };
  }

  private stored(field: SyncField): FieldState {
    return this.options.store.read(field) ?? defaultState(field, this.options.skeleton(field), this.catalog);
  }

  /** One read-change-save commit (DS-LOCK) of each field given, after DS-UPGRADE, in one write. */
  private commit(changes: readonly [SyncField, (state: FieldState) => FieldState][], kind: CommitKind): CommitResult {
    const pending = this.upgraded();
    if (Object.keys(pending).length > 0) return { outcome: "unsaved", fields: [] };
    const states: Partial<Record<SyncField, FieldState>> = {};
    for (const [field, change] of changes) {
      const before = this.stored(field);
      const after = change(before);
      if (!sameState(before, after)) states[field] = after;
    }
    const fields = syncFields.filter((field) => states[field] !== undefined);
    if (fields.length === 0) return { outcome: "unchanged", fields: [] };
    return this.write(states, kind) ? { outcome: "saved", fields } : { outcome: "unsaved", fields: [] };
  }

  /** Writes `states`; when that fails, the writer name is abandoned (DS-NAME-ABANDON, R7). */
  private write(states: Partial<Record<SyncField, FieldState>>, kind: CommitKind): boolean {
    if (this.options.store.write(states, kind)) return true;
    this.abandonName();
    return false;
  }

  private abandonName(): void {
    this.writer = null;
  }

  /** Labels under the current writer name, a fresh one when there is none (DS-NAME, DS-ORDER). */
  private labels(): LabelSource {
    return {
      next: () => {
        this.writer ??= { name: this.options.newName(), n: 0 };
        this.writer.n += 1;
        return { name: this.writer.name, n: this.writer.n };
      },
    };
  }
}
