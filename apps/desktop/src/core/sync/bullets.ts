// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import catalogFile from "./device-sync-default-catalog.json";

/**
 * Device Sync's labelled bullets (ADR-DESK-066): the knowledge base's and the writing style's bullets,
 * each carrying a label (writer name, counter), and per field the highest counter seen of every name.
 * The same rules run in Thunderbird and iOS, pinned by the shared conformance vectors; each rule's ID
 * is named where it is implemented. Pure functions: storage, writer names and messages are the
 * engine's (`bulletSync.ts`).
 */

export type SyncField = "kb" | "composition" | "action";

/** The fields in the order every app handles them (upgrade, connect). */
export const syncFields: readonly SyncField[] = ["kb", "composition", "action"];

/** One live bullet: its section key (DS-SECTION), its text (DS-TEXT) and its label (DS-LABEL). */
export interface Bullet {
  section: string;
  text: string;
  name: string;
  n: number;
}

/** A bullet as text only, before it has a label. */
export interface BulletText {
  section: string;
  text: string;
}

/** One field as a device keeps it: its own skeleton lines (DS-SKELETON), its live bullets in local
 * order, and the full seen map (DS-SEEN), kept together (DS-ATOMIC). */
export interface FieldState {
  head: string[];
  tail: string[];
  bullets: Bullet[];
  seen: Map<string, number>;
}

/** The writing style's and the action rules' sections: key, then the header name Thunderbird's
 * `bulletMerge.js` and iOS's `PromptParser` use (DS-SECTION). The knowledge base has the one section
 * "" and no header (R1). */
export const sectionHeaders: Readonly<Record<SyncField, readonly (readonly [key: string, name: string])[]>> = {
  kb: [],
  composition: [
    ["general", "General writing style"],
    ["language", "Language"],
    ["links", "Useful links to personal website and other resources"],
  ],
  action: [
    ["delete", "Emails to be marked as `delete`"],
    ["archive", "Emails to be marked as `archive`"],
    ["reply", "Emails to be marked as `reply`"],
    ["none", "Emails to be marked as `none`"],
  ],
};

export const headerMark = "DO NOT EDIT/DELETE THIS SECTION HEADER";
export const instructionsEnd = "====END USER INSTRUCTIONS====";

/** Released Thunderbird's and iOS's time of a text never edited, or reset (DS-LEGACY-IN). */
export const epochZero = "1970-01-01T00:00:00.000Z";

/** The section keys this app shows for `field`. */
export function displayedSections(field: SyncField): string[] {
  return field === "kb" ? [""] : sectionHeaders[field].map(([key]) => key);
}

// MARK: Text (R2)

/** ECMAScript WhiteSpace and LineTerminator, listed (R2): what "trimmed" strips at both ends. */
const trimmed = new Set([
  0x09, 0x0b, 0x0c, 0x20, 0xa0, 0xfeff, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
  0x2028, 0x2029, 0x0d, 0x0a,
]);

/** `text` without R2's whitespace at either end. Every character listed is one UTF-16 unit. */
export function trim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && trimmed.has(text.charCodeAt(start))) start += 1;
  while (end > start && trimmed.has(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** The lines of `text`, split on "\r\n", "\r" and "\n" (R2). */
export function lines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Whether `text` holds a line break as DS-VALIDATE means it (R2). */
export function hasLineBreak(text: string): boolean {
  return text.includes("\n") || text.includes("\r");
}

/** A trimmed, non-empty line inside a section as a bullet's text: without its "- ", trimmed again; any
 * other line as it is (DS-PARSE, R3). */
function bulletText(line: string): string {
  return line.startsWith("- ") ? trim(line.slice(2)) : line;
}

/** R23: in the sectioned fields a text holding the header mark or the END marker would be read back as
 * a header or the skeleton, so it is not a bullet: no writer makes one, and a snapshot carrying one is
 * dropped. The knowledge base has neither (R1). */
export function isMarkerText(field: SyncField, text: string): boolean {
  return field !== "kb" && (text.includes(headerMark) || text.includes(instructionsEnd));
}

/** The section key whose header `line` is (R3): it holds the header's name and the marker; the first
 * in order when several match. */
function headerOf(field: SyncField, line: string): string | undefined {
  if (!line.includes(headerMark)) return undefined;
  return sectionHeaders[field].find(([, name]) => line.includes(name))?.[0];
}

// MARK: Parse and render

export interface ParsedField {
  head: string[];
  tail: string[];
  bullets: BulletText[];
}

/** DS-PARSE, DS-SKELETON: the shared reader. Lines before the first section header, and from the END
 * marker on, are the skeleton, kept verbatim; in a section an empty line is skipped and every other
 * line is a bullet. The knowledge base has no skeleton (R1). */
export function parse(field: SyncField, text: string): ParsedField {
  const parsed: ParsedField = { head: [], tail: [], bullets: [] };
  let section: string | null = field === "kb" ? "" : null;
  let ended = false;
  for (const line of lines(text)) {
    if (field !== "kb") {
      if (ended || line.includes(instructionsEnd)) {
        ended = true;
        parsed.tail.push(line);
        continue;
      }
      const header = headerOf(field, line);
      if (header !== undefined) {
        section = header;
        continue;
      }
      if (section === null) {
        parsed.head.push(line);
        continue;
      }
    }
    const content = trim(line);
    if (content !== "") parsed.bullets.push({ section: section ?? "", text: bulletText(content) });
  }
  return parsed;
}

/** DS-RENDER: the field's text, from its skeleton and its live bullets in local order, each section
 * under its header. Bullets in a section this app doesn't know are kept but not shown. */
export function render(field: SyncField, state: Pick<FieldState, "head" | "tail" | "bullets">): string {
  const of = (section: string) => state.bullets.filter((bullet) => bullet.section === section).map((bullet) => `- ${bullet.text}`);
  if (field === "kb") return of("").join("\n");
  const rendered = [...state.head];
  for (const [key, name] of sectionHeaders[field]) rendered.push(`# ${name} (${headerMark})`, ...of(key), "");
  rendered.push(...state.tail);
  return rendered.join("\n");
}

// MARK: Labels

export function sameLabel(a: Pick<Bullet, "name" | "n">, b: Pick<Bullet, "name" | "n">): boolean {
  return a.name === b.name && a.n === b.n;
}

/** DS-DEDUP's order: the name as a byte string, then the counter. Names are ASCII (DS-VALIDATE), so
 * UTF-16 order is byte order. */
export function compareLabels(a: Pick<Bullet, "name" | "n">, b: Pick<Bullet, "name" | "n">): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.n - b.n;
}

export function labelKey(bullet: Pick<Bullet, "name" | "n">): string {
  return `${bullet.name}\u0000${bullet.n}`;
}

function textKey(bullet: BulletText): string {
  return `${bullet.section}\u0000${bullet.text}`;
}

export function isLive(state: Pick<FieldState, "bullets">, item: BulletText): boolean {
  return state.bullets.some((bullet) => bullet.section === item.section && bullet.text === item.text);
}

const writerNamePattern = /^[0-9a-f]{16}$/;
const defaultNamePattern = /^default:[a-z0-9-]+$/;

/** DS-LABEL, R4: a writer name (16 lowercase hex) or a default's (`default:<id>`). */
export function isName(value: unknown): value is string {
  return typeof value === "string" && (writerNamePattern.test(value) || defaultNamePattern.test(value));
}

/** DS-DEDUP: one label for each (section, text), the smallest, where the first of them stood. */
export function dedup(bullets: readonly Bullet[]): Bullet[] {
  const kept = new Map<string, number>();
  const result: Bullet[] = [];
  for (const bullet of bullets) {
    const key = textKey(bullet);
    const at = kept.get(key);
    if (at === undefined) {
      kept.set(key, result.length);
      result.push(bullet);
    } else if (compareLabels(bullet, result[at] as Bullet) < 0) result[at] = bullet;
  }
  return result;
}

// MARK: Defaults (DS-DEFAULT)

export interface CatalogEntry {
  id: string;
  field: SyncField;
  section: string;
  text: string;
}

export interface Catalog {
  version: number;
  defaults: CatalogEntry[];
}

/** The shared default catalog, byte-identical in the three apps. */
export const defaultCatalog: Catalog = catalogFile as Catalog;

export function defaultName(entry: Pick<CatalogEntry, "id">): string {
  return `default:${entry.id}`;
}

/** DS-DEFAULT, DS-RESET: `field` as a new install or a reset holds it: every catalog default under its
 * own label, each seen. */
export function defaultState(field: SyncField, skeleton: Pick<FieldState, "head" | "tail">, catalog: Catalog = defaultCatalog): FieldState {
  const entries = catalog.defaults.filter((entry) => entry.field === field);
  return {
    head: [...skeleton.head],
    tail: [...skeleton.tail],
    bullets: entries.map((entry) => ({ section: entry.section, text: entry.text, name: defaultName(entry), n: 1 })),
    seen: new Map(entries.map((entry) => [defaultName(entry), 1])),
  };
}

function catalogMatch(field: SyncField, item: BulletText, catalog: Catalog): CatalogEntry | undefined {
  return catalog.defaults.find((entry) => entry.field === field && entry.section === item.section && entry.text === item.text);
}

// MARK: Local operations

/** Hands out labels under this process's writer name (DS-NAME, DS-ORDER, R7): one name for every
 * field, counted in commit order. */
export interface LabelSource {
  next(): { name: string; n: number };
}

function cloneState(state: FieldState): FieldState {
  return { head: [...state.head], tail: [...state.tail], bullets: [...state.bullets], seen: new Map(state.seen) };
}

function withLabel(state: FieldState, item: BulletText, labels: LabelSource): void {
  const { name, n } = labels.next();
  state.bullets.push({ section: item.section, text: item.text, name, n });
  // DS-ORDER: seen in the same commit.
  state.seen.set(name, Math.max(state.seen.get(name) ?? 0, n));
}

/** DS-ADD: `items` added, each not already live, under fresh labels (a fresh label is the only one of
 * its text, so nothing is left for DS-DEDUP). */
export function add(state: FieldState, items: readonly BulletText[], labels: LabelSource): FieldState {
  const next = cloneState(state);
  for (const item of items) if (!isLive(next, item)) withLabel(next, item, labels);
  return next;
}

/** DS-CAPTURE commit, and with it DS-DELETE and DS-EDIT (a deleted or reworded bullet is a captured
 * text `result` lacks; a reworded or moved one's new text is added under a new label): of the
 * `captured` labels, those whose (section, text) `result` lacks are deleted when still live; a
 * captured text `result` keeps its label; every other text of `result` is added (DS-ADD). A bullet that arrived since the capture is never deleted. */
export function commitCapture(state: FieldState, captured: readonly Bullet[], result: readonly BulletText[], labels: LabelSource): FieldState {
  const kept = new Set(result.map(textKey));
  const capturedTexts = new Set(captured.map(textKey));
  const deleted = new Set(captured.filter((bullet) => !kept.has(textKey(bullet))).map(labelKey));
  const next = { ...cloneState(state), bullets: state.bullets.filter((bullet) => !deleted.has(labelKey(bullet))) };
  return add(next, result.filter((item) => !capturedTexts.has(textKey(item))), labels);
}

/** DS-UPGRADE steps 1-4: `text` parsed; a catalog default under its label, every other bullet under a
 * fresh one, in order; seen from those labels only; then DS-DEDUP. The device's own skeleton is kept. */
export function upgrade(field: SyncField, text: string, labels: LabelSource, catalog: Catalog = defaultCatalog): FieldState {
  const parsed = parse(field, text);
  const state: FieldState = { head: parsed.head, tail: parsed.tail, bullets: [], seen: new Map() };
  for (const item of parsed.bullets) {
    if (isMarkerText(field, item.text)) continue;
    const entry = catalogMatch(field, item, catalog);
    if (entry === undefined) {
      withLabel(state, item, labels);
      continue;
    }
    const name = defaultName(entry);
    state.bullets.push({ ...item, name, n: 1 });
    state.seen.set(name, 1);
  }
  return { ...state, bullets: dedup(state.bullets) };
}

/** DS-LEGACY-IN: a released device's `text` imported, additions only: each (section, text) not live
 * here added, a catalog default under its own label unless it was seen (deleted here), any other
 * under a fresh one. Nothing is deleted. */
export function importLegacy(field: SyncField, state: FieldState, text: string, labels: LabelSource, catalog: Catalog = defaultCatalog): FieldState {
  const next = cloneState(state);
  for (const item of parse(field, text).bullets) {
    if (isLive(next, item) || isMarkerText(field, item.text)) continue;
    const entry = catalogMatch(field, item, catalog);
    if (entry === undefined) {
      withLabel(next, item, labels);
      continue;
    }
    const name = defaultName(entry);
    // DS-MERGE-1 for the default's label.
    if ((next.seen.get(name) ?? 0) >= 1) continue;
    next.bullets.push({ ...item, name, n: 1 });
    next.seen.set(name, 1);
  }
  return { ...next, bullets: dedup(next.bullets) };
}

// MARK: Merge (§6)

export interface Incoming {
  bullets: Bullet[];
  seen: Map<string, number>;
}

export type MergeResult =
  | { kind: "merged"; state: FieldState; differed: boolean }
  /** DS-MERGE-3: one label with another text or section here, or twice in the message. */
  | { kind: "conflict"; label: Pick<Bullet, "name" | "n"> };

/** DS-MERGE-1..5: an incoming complete snapshot merged into `local`. */
export function merge(local: FieldState, incoming: Incoming): MergeResult {
  const localByLabel = new Map(local.bullets.map((bullet) => [labelKey(bullet), bullet]));
  const incomingByLabel = new Map<string, Bullet>();
  for (const bullet of incoming.bullets) {
    const key = labelKey(bullet);
    const other = incomingByLabel.get(key) ?? localByLabel.get(key);
    if (other !== undefined && (other.section !== bullet.section || other.text !== bullet.text)) return { kind: "conflict", label: { name: bullet.name, n: bullet.n } };
    if (!incomingByLabel.has(key)) incomingByLabel.set(key, bullet);
  }
  const before = local.seen;
  // DS-MERGE-2 and -3: a local label the message lacks is dropped when the sender has seen it.
  const bullets = local.bullets.filter((bullet) => incomingByLabel.has(labelKey(bullet)) || (incoming.seen.get(bullet.name) ?? 0) < bullet.n);
  // DS-MERGE-1: an incoming label new here is rejected when the map BEFORE this merge has seen it.
  for (const [key, bullet] of incomingByLabel) {
    if (!localByLabel.has(key) && (before.get(bullet.name) ?? 0) < bullet.n) bullets.push(bullet);
  }
  // DS-MERGE-4.
  const seen = new Map(before);
  for (const [name, n] of incoming.seen) if ((seen.get(name) ?? 0) < n) seen.set(name, n);
  // DS-SEND's difference: the incoming labels against this device's before the merge.
  const differed = incomingByLabel.size !== localByLabel.size || [...incomingByLabel.keys()].some((key) => !localByLabel.has(key));
  // DS-MERGE-5.
  return { kind: "merged", state: { head: local.head, tail: local.tail, bullets: dedup(bullets), seen }, differed };
}

/** Whether two states hold the same bullets in the same order, the same seen map and skeleton. */
export function sameState(a: FieldState, b: FieldState): boolean {
  return (
    a.bullets.length === b.bullets.length &&
    a.bullets.every((bullet, index) => {
      const other = b.bullets[index] as Bullet;
      return bullet.section === other.section && bullet.text === other.text && sameLabel(bullet, other);
    }) &&
    a.seen.size === b.seen.size &&
    [...a.seen].every(([name, n]) => b.seen.get(name) === n) &&
    a.head.length === b.head.length &&
    a.head.every((line, index) => line === b.head[index]) &&
    a.tail.length === b.tail.length &&
    a.tail.every((line, index) => line === b.tail[index])
  );
}
