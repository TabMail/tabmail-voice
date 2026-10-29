// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defaultComposition } from "../../src/core/personalization/defaults.js";
import { type PromptField, promptFields, type ShownBullet, UserPrompts } from "../../src/core/personalization/prompts.js";
import { type Bullet, type Catalog, defaultCatalog, type FieldState, parse } from "../../src/core/sync/bullets.js";
import { DeviceSync, type SyncSocketEvents } from "../../src/core/sync/deviceSync.js";
import { MemoryStore } from "../../src/core/util/keyValueStore.js";
import { Fixtures } from "./stubs.js";

const ownerKey = "device_sync_owner_user_id";

/** A device's store: a `MemoryStore` whose next whole-value write can be made to fail, as a full disk's
 * would. */
export class DeviceStore extends MemoryStore {
  failNext = false;

  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    if (this.failNext) {
      this.failNext = false;
      return false;
    }
    return super.setAll(values);
  }

  /** A copy of everything stored (the user copying the app's data folder, or a backup). */
  copy(): DeviceStore {
    return new DeviceStore(structuredClone(this.snapshot()));
  }

  /** Puts back everything `other` holds, as a restored backup does. */
  replaceWith(other: DeviceStore): void {
    for (const key of Object.keys(this.snapshot())) this.values.delete(key);
    for (const [key, value] of Object.entries(structuredClone(other.snapshot()))) this.values.set(key, value);
  }
}

/** A store of `userID`'s texts (the signed-in fixture account's by default), with nothing else in it:
 * a new install. */
export function ownedStore(userID: string = Fixtures.userID): DeviceStore {
  return new DeviceStore({ [ownerKey]: userID });
}

/** One snapshot a device sent: every part, and who has yet to get each. */
interface Snapshot {
  id: string;
  from: string;
  field: string;
  parts: string[];
}

interface Pending {
  snapshot: Snapshot;
  part: number;
  to: string;
}

/** The Device Sync relay between the test's devices: forwards each message to every other connected
 * device, nothing kept. What is pending is delivered, reordered or lost as the test says. */
export class BulletRelay {
  readonly snapshots = new Map<string, Snapshot>();
  pending: Pending[] = [];
  private readonly connected = new Map<string, SyncSocketEvents>();
  private readonly counts = new Map<string, number>();
  private readonly bySnap = new Map<string, Snapshot>();

  isConnected(device: string): boolean {
    return this.connected.has(device);
  }

  /** What `device`'s transport is told of its connection. */
  events(device: string): SyncSocketEvents {
    const events = this.connected.get(device);
    if (events === undefined) throw new Error(`${device} isn't connected`);
    return events;
  }

  join(device: string, events: SyncSocketEvents): void {
    this.connected.set(device, events);
  }

  leave(device: string): void {
    this.connected.delete(device);
    this.pending = this.pending.filter((entry) => entry.to !== device);
  }

  /** How many snapshots of `field` `device` has sent. */
  sent(device: string, field: string): number {
    return this.counts.get(`${device}:${field}`) ?? 0;
  }

  send(from: string, text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
    if (message.type !== "bullet_state") throw new Error(`${from} sent a ${String(message.type)} message`);
    const field = String(message.field);
    const key = `${from}:${field}`;
    const part = message.part as number;
    const snapKey = `${key}:${String(message.snap)}`;
    let snapshot = this.bySnap.get(snapKey);
    if (snapshot === undefined) {
      const k = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, k);
      snapshot = { id: `${key}#${k}`, from, field, parts: [] };
      this.snapshots.set(snapshot.id, snapshot);
      this.bySnap.set(snapKey, snapshot);
    }
    snapshot.parts[part - 1] = text;
    for (const to of this.connected.keys()) if (to !== from) this.pending.push({ snapshot, part, to });
  }

  /** Delivers `part` of `id` to `to` (again when it already was). */
  deliver(id: string, to: string, part: number): void {
    const snapshot = this.snapshots.get(id);
    if (snapshot === undefined) throw new Error(`no snapshot ${id}`);
    const index = this.pending.findIndex((entry) => entry.snapshot === snapshot && entry.to === to && entry.part === part);
    if (index >= 0) this.pending.splice(index, 1);
    this.events(to).message(snapshot.parts[part - 1] as string);
  }

  drop(id: string, to?: readonly string[], parts?: readonly number[]): void {
    this.pending = this.pending.filter((entry) => !(entry.snapshot.id === id && (to === undefined || to.includes(entry.to)) && (parts === undefined || parts.includes(entry.part))));
  }

  /** Delivers the oldest pending part; false when none is. */
  deliverOldest(): boolean {
    const entry = this.pending[0];
    if (entry === undefined) return false;
    this.deliver(entry.snapshot.id, entry.to, entry.part);
    return true;
  }
}

/** Lets the connection's token arrive and the transport open. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

export interface DeviceOptions {
  /** This device's k-th fresh writer name, k from 1. */
  name: (k: number) => string;
  budget?: number;
  catalog?: Catalog;
}

/** A Voice device: its store, and the process running on it (`UserPrompts` and `DeviceSync`), which
 * restarts. */
export class BulletDevice {
  prompts!: UserPrompts;
  sync!: DeviceSync;
  private names = 0;

  constructor(
    readonly id: string,
    readonly store: DeviceStore,
    private readonly relay: BulletRelay,
    private readonly options: DeviceOptions,
  ) {
    this.start();
  }

  private start(): void {
    this.prompts = new UserPrompts(this.store, {
      newName: () => this.options.name(++this.names),
      budget: this.options.budget === undefined ? undefined : () => this.options.budget as number,
      catalog: this.options.catalog,
    });
    this.sync = new DeviceSync({
      prompts: this.prompts,
      account: { session: Fixtures.session(), validToken: () => Promise.resolve("token") },
      allowed: () => true,
      url: () => "wss://sync.example.com",
      open: (_url, events) => {
        this.relay.join(this.id, events);
        return { send: (text) => this.relay.send(this.id, text), close: () => this.relay.leave(this.id) };
      },
    });
  }

  async connect(): Promise<void> {
    if (this.relay.isConnected(this.id)) return;
    this.sync.update();
    await settle();
    this.relay.events(this.id).message(JSON.stringify({ type: "connected", userId: Fixtures.userID, timestamp: 0 }));
  }

  disconnect(): void {
    this.sync.stop();
  }

  /** The process ends and another opens the same store. */
  restart(): void {
    this.disconnect();
    this.prompts.flushHistory();
    this.start();
  }

  /** A message delivered to this device straight from the network. */
  receive(message: unknown): void {
    const text = JSON.stringify(message);
    if (this.relay.isConnected(this.id)) this.relay.events(this.id).message(text);
    else if ((message as { type?: unknown }).type === "prompt_state") this.prompts.sync.receiveLegacy((message as { data: unknown }).data);
    else this.prompts.sync.receive(message);
  }

  state(field: PromptField): FieldState {
    return this.prompts.sync.state(field);
  }

  shown(field: PromptField, section: string): ShownBullet[] {
    return this.prompts.shown(field, section);
  }

  /** The user's edit of one section in Settings, from what it shows now to `texts`. */
  editSection(field: PromptField, section: string, texts: (shown: string[]) => string[]): boolean {
    const shown = this.shown(field, section);
    const edited = texts(shown.map((bullet) => bullet.text));
    return field === "kb" ? this.prompts.editKnowledgeBase(shown, edited) : this.prompts.editCompositionSection(section, shown, edited);
  }

  add(field: PromptField, section: string, text: string): void {
    if (field === "kb") this.prompts.addKnowledge(text);
    else this.editSection(field, section, (texts) => [...texts, text]);
  }

  delete(field: PromptField, section: string, text: string): void {
    this.editSection(field, section, (texts) => texts.filter((other) => other !== text));
  }

  /** A section's edit committed from what `captured` held then (DS-CAPTURE). */
  commit(field: PromptField, section: string, captured: readonly Bullet[] | null, result: readonly string[]): void {
    // A capture refused while an upgrade was unsaved saves nothing (R22).
    if (captured === null) return;
    const shown: ShownBullet[] = captured.map((bullet) => ({ text: bullet.text, labels: [[bullet.name, bullet.n]] }));
    if (field === "kb") this.prompts.editKnowledgeBase(shown, result);
    else this.prompts.editCompositionSection(section, shown, result);
  }

  reset(field: PromptField): void {
    if (field === "kb") this.prompts.resetKnowledgeBase();
    else this.prompts.resetComposition();
  }
}

/** Each field's skeleton as Voice's built-in texts have it. */
export function builtInSkeleton(field: PromptField): Pick<FieldState, "head" | "tail"> {
  if (field === "kb") return { head: [], tail: [] };
  const { head, tail } = parse("composition", defaultComposition);
  return { head, tail };
}

/** Writes `states` into `store` as `UserPrompts` keeps them; fields not given stored empty. */
export function storeStates(store: DeviceStore, states: Partial<Record<PromptField, Pick<FieldState, "bullets" | "seen">>>): void {
  const prompts = new UserPrompts(store);
  const all: Partial<Record<PromptField, FieldState>> = {};
  for (const field of promptFields) {
    const given = states[field];
    all[field] = { ...builtInSkeleton(field), bullets: given?.bullets ?? [], seen: given?.seen ?? new Map() };
  }
  if (!prompts.write(all, "upgrade")) throw new Error("couldn't store the states");
}

export { defaultCatalog };
