// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type PromptField, promptFields } from "../../../src/core/personalization/prompts.js";
import { type Bullet, displayedSections, labelKey } from "../../../src/core/sync/bullets.js";
import { BulletDevice, BulletRelay, type DeviceStore, ownedStore, storeStates } from "../../support/bulletDevices.js";
import type { ReceiveOutcome } from "../../../src/core/sync/bulletSync.js";

/**
 * Device Sync between three to six Voice devices, driven by a seeded generator: adds, deletions,
 * rewords, moves between sections, Settings edits committed from an older capture, resets, the user's
 * factory reset of the texts' file, restarts, failed saves, a copied data folder, a restored backup, a
 * released device's texts, connections coming and going, and the relay delivering, reordering,
 * repeating and losing parts. A model of every label checks these invariants:
 *
 * - I1 (no loss): when a delivery makes a bullet's text gone from every device, each label it had was
 *   deleted by a user (its deletion travelled), or was put aside by DS-DEDUP for a label that was,
 *   checked at every step; at the end every label still held somewhere is held everywhere.
 * - I2 (convergence): connected and settled, every device holds the same labels.
 * - I3 (bounded messages): each message's `seen` names every bullet it carries, and otherwise only
 *   the ones in the last snapshot of that field the sender merged (DS-SEEN-OUT); settling ends.
 *
 * A failure names its seed and step; `DEVICE_SYNC_FUZZ_SEEDS` runs more seeds.
 */

const seeds = Number(process.env.DEVICE_SYNC_FUZZ_SEEDS ?? 300);
const steps = 120;
const maxDevices = 6;
/** More deliveries than settling ever needs: messages that never stop (I3). */
const maxDeliveries = 50_000;
const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"];
const future = "2099-01-01T00:00:00.000Z";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/** A label, with its field: one key across both fields. */
function key(field: PromptField, bullet: Pick<Bullet, "name" | "n">): string {
  return `${field}|${labelKey(bullet)}`;
}

function itemKey(field: PromptField, bullet: Pick<Bullet, "section" | "text">): string {
  return `${field}|${bullet.section}|${bullet.text}`;
}

class Fuzz {
  readonly relay = new BulletRelay();
  readonly devices: BulletDevice[] = [];
  /** Labels a user deleted, by any device: a delete, a reword or move, an edit committed from a capture. */
  readonly deleted = new Set<string>();
  /** For a label a device dropped while its text stayed live there under another (DS-DEDUP), those
   * others: the dropped label goes with a user's deletion of one of them. */
  private readonly aliases = new Map<string, Set<string>>();
  /** For each device and field, the names on bullets in the last snapshot it merged since its process
   * started or its texts were reloaded: what its `seen` may name besides its own bullets (DS-SEEN-OUT). */
  private readonly merged = new Map<string, Set<string>>();
  /** Parts each device has of a sender's snapshot: by device, the message's sender and field, as it
   * buffers them. */
  private readonly buffers = new Map<string, { snap: string; parts: Set<number> }>();
  /** Whether this step put a device's texts aside (a reset, a restore, the file's reset): no dedup. */
  private cleared = false;
  /** Messages whose `seen` broke DS-SEEN-OUT: kept for the test, as a throw would land in the sender. */
  readonly violations: string[] = [];
  private readonly captures = new Map<BulletDevice, { field: PromptField; section: string; epoch: number; captured: Bullet[] | null }>();
  private readonly backups = new Map<BulletDevice, DeviceStore>();
  private unique = 0;
  /** Labels given to bullets in a section this version doesn't show, one each. */
  newerLabels = 0;
  readonly log: string[] = [];

  constructor(
    private readonly next: () => number,
    private readonly budget: number | undefined,
  ) {
    const count = 3 + this.int(4);
    for (let index = 0; index < count; index += 1) this.create(this.initialStore());
    const send = this.relay.send.bind(this.relay);
    this.relay.send = (from, text) => {
      this.checkSeen(from, text);
      send(from, text);
    };
    const deliver = this.relay.deliver.bind(this.relay);
    this.relay.deliver = (id, to, part) => {
      const device = this.devices.find((other) => other.id === to);
      const before = device === undefined ? undefined : this.labelsOf(device);
      const whole = this.arrived(id, to, part);
      if (device === undefined || before === undefined || whole === undefined) {
        deliver(id, to, part);
        if (device !== undefined && before !== undefined) this.dropped(device, before);
        return;
      }
      // Its answer, sent during the delivery, names this snapshot's names once merged, the last one's
      // until then: either is allowed meanwhile, and after it, this one's only if it was merged.
      const merged = `${to}|${whole.field}`;
      const last = this.merged.get(merged) ?? new Set<string>();
      const names = new Set(whole.bullets.map(([, , name]) => name));
      this.merged.set(merged, new Set([...last, ...names]));
      // A plain wrapper, not a spy: a spy keeps every call's message and result, and runs out of memory
      // over a few hundred seeds.
      const sync = device.prompts.sync;
      const receive = sync.receive;
      let outcome: ReceiveOutcome | undefined;
      sync.receive = (message) => (outcome = receive.call(sync, message));
      deliver(id, to, part);
      sync.receive = receive;
      this.merged.set(merged, outcome?.kind === "merged" ? names : last);
      this.dropped(device, before);
      this.mergedAside(device, whole);
    };
    const leave = this.relay.leave.bind(this.relay);
    this.relay.leave = (device) => {
      leave(device);
      // DS-CHUNK: incomplete snapshots are dropped on disconnect.
      for (const buffer of [...this.buffers.keys()]) if (buffer.startsWith(`${device}|`)) this.buffers.delete(buffer);
    };
  }

  /** DS-SEEN-OUT, I3: `seen` names every bullet the sender sends, and besides them only those of the
   * last snapshot it merged. */
  private checkSeen(from: string, text: string): void {
    const message = JSON.parse(text) as { field: PromptField; seen: Record<string, number> };
    const device = this.devices.find((other) => other.id === from);
    if (device === undefined) throw new Error(`${from} isn't a device`);
    const own = new Set(device.state(message.field).bullets.map((bullet) => bullet.name));
    const merged = this.merged.get(`${from}|${message.field}`) ?? new Set();
    const extra = Object.keys(message.seen).filter((name) => !own.has(name) && !merged.has(name));
    if (extra.length > 0) this.violations.push(`I3: ${from}'s ${message.field} message names ${extra.join(", ")} in seen, on no bullet it holds or merged last`);
    const missing = [...own].filter((name) => !(name in message.seen));
    if (missing.length > 0) this.violations.push(`DS-SEEN-OUT: ${from}'s ${message.field} message leaves ${missing.join(", ")} of its own bullets out of seen`);
  }

  /** A part arriving at `to`, buffered as the device buffers it: once its snapshot is whole, its field
   * and bullets. */
  private arrived(id: string, to: string, part: number): { field: PromptField; bullets: [string, string, string, number][] } | undefined {
    const snapshot = this.relay.snapshots.get(id);
    if (snapshot === undefined) return undefined;
    const first = JSON.parse(snapshot.parts[part - 1] as string) as { sender: string; snap: string; parts: number };
    const buffer = `${to}|${first.sender}|${snapshot.field}`;
    let parts = this.buffers.get(buffer);
    if (parts === undefined || parts.snap !== first.snap) {
      parts = { snap: first.snap, parts: new Set() };
      this.buffers.set(buffer, parts);
    }
    parts.parts.add(part);
    if (parts.parts.size < first.parts) return undefined;
    this.buffers.delete(buffer);
    const field = snapshot.field as PromptField;
    const bullets = snapshot.parts.flatMap((text) => (JSON.parse(text as string) as { bullets: [string, string, string, number][] }).bullets);
    return { field, bullets };
  }

  /** DS-DEDUP on merge: an incoming label `device` didn't keep, its text held there under another. */
  private mergedAside(device: BulletDevice, { field, bullets }: { field: PromptField; bullets: [string, string, string, number][] }): void {
    const held = new Map(device.state(field).bullets.map((bullet) => [itemKey(field, bullet), key(field, bullet)]));
    for (const [section, text, name, n] of bullets) {
      const label = key(field, { name, n });
      const other = held.get(itemKey(field, { section, text }));
      if (other !== undefined && other !== label) this.aliases.set(label, (this.aliases.get(label) ?? new Set()).add(other));
    }
  }

  /** `device`'s process started afresh, or its texts were reloaded: nothing merged since. */
  private forgetMerged(device: BulletDevice): void {
    for (const field of promptFields) this.merged.delete(`${device.id}|${field}`);
  }

  int(below: number): number {
    return Math.floor(this.next() * below);
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)] as T;
  }

  private initialStore(): DeviceStore {
    const store = ownedStore();
    const kind = this.int(4);
    if (kind === 1) storeStates(store, {});
    if (kind === 2) store.set("user_prompts:user_kb.md", [this.text(), this.text(), "plain line"].map((text) => `- ${text}`).join("\n"));
    if (kind === 3) {
      // Bullets merged from a newer version's device, in a section this version doesn't show (DS-SECTION):
      // kept, sent on and never shown, each with a label of its own.
      const newer = (): [Bullet, [string, number]] => {
        const name = `ffffffff${hex(++this.newerLabels)}`;
        return [{ section: "future", text: this.text(), name, n: 1 }, [name, 1]];
      };
      const [kb, kbSeen] = newer();
      const [composition, compositionSeen] = newer();
      storeStates(store, { kb: { bullets: [kb], seen: new Map([kbSeen]) }, composition: { bullets: [composition], seen: new Map([compositionSeen]) } });
    }
    return store;
  }

  private create(store: DeviceStore): BulletDevice {
    const index = this.devices.length + 1;
    const device = new BulletDevice(String.fromCharCode(64 + index), store, this.relay, { name: (k) => `${hex(index)}${hex(k)}`, budget: this.budget });
    this.devices.push(device);
    return device;
  }

  private text(): string {
    if (this.next() < 0.2) return `unique ${++this.unique}`;
    return this.pick(words);
  }

  private section(field: PromptField): string {
    return field === "kb" ? "" : this.pick(displayedSections("composition"));
  }

  /** Every label held, with the devices holding it, and every text live on some device. */
  held(): { labels: Map<string, Set<string>>; items: Set<string> } {
    const labels = new Map<string, Set<string>>();
    const items = new Set<string>();
    for (const device of this.devices) {
      for (const field of promptFields) {
        for (const bullet of device.state(field).bullets) {
          const label = key(field, bullet);
          labels.set(label, (labels.get(label) ?? new Set()).add(device.id));
          items.add(itemKey(field, bullet));
        }
      }
    }
    return { labels, items };
  }

  /** The bullets each label held names. */
  bulletsHeld(): Map<string, { field: PromptField; bullet: Bullet }> {
    const all = new Map<string, { field: PromptField; bullet: Bullet }>();
    for (const device of this.devices) for (const field of promptFields) for (const bullet of device.state(field).bullets) all.set(key(field, bullet), { field, bullet });
    return all;
  }

  /** `device`'s labels, with their texts. */
  private labelsOf(device: BulletDevice): Map<string, string> {
    const labels = new Map<string, string>();
    for (const field of promptFields) for (const bullet of device.state(field).bullets) labels.set(key(field, bullet), itemKey(field, bullet));
    return labels;
  }

  /** DS-DEDUP: a label `device` held `before` and dropped while its text stayed live there under another. */
  private dropped(device: BulletDevice, before: Map<string, string>): void {
    const now = this.labelsOf(device);
    const byItem = new Map<string, string>();
    for (const [label, item] of now) byItem.set(item, label);
    for (const [label, item] of before) {
      const other = byItem.get(item);
      if (now.has(label) || other === undefined) continue;
      this.aliases.set(label, (this.aliases.get(label) ?? new Set()).add(other));
    }
  }

  /** One step; true when it delivered parts (merges), whose disappearances I1 checks. */
  async step(): Promise<boolean> {
    const before = new Map(this.devices.map((device) => [device, this.labelsOf(device)]));
    this.cleared = false;
    const delivered = await this.act();
    if (!this.cleared) for (const [device, labels] of before) this.dropped(device, labels);
    return delivered;
  }

  private async act(): Promise<boolean> {
    const device = this.pick(this.devices);
    const field = this.pick(promptFields);
    const roll = this.next();
    if (roll < 0.3) {
      const count = 1 + this.int(4);
      for (let index = 0; index < count && this.relay.pending.length > 0; index += 1) {
        const entry = this.next() < 0.7 ? this.relay.pending[0] : this.pick(this.relay.pending);
        if (entry === undefined) break;
        this.log.push(`deliver ${entry.snapshot.id}/${entry.part} to ${entry.to}`);
        this.relay.deliver(entry.snapshot.id, entry.to, entry.part);
      }
      return true;
    }
    if (roll < 0.33) {
      // A part delivered again.
      const snapshot = this.pick([...this.relay.snapshots.values()]);
      const to = this.pick(this.devices);
      if (snapshot === undefined || snapshot.from === to.id || !this.relay.isConnected(to.id)) return false;
      const part = 1 + this.int(snapshot.parts.length);
      this.log.push(`repeat ${snapshot.id}/${part} to ${to.id}`);
      this.relay.deliver(snapshot.id, to.id, part);
      return true;
    }
    if (roll < 0.36) {
      const entry = this.pick(this.relay.pending);
      if (entry === undefined) return false;
      this.log.push(`lose ${entry.snapshot.id}/${entry.part} to ${entry.to}`);
      this.relay.drop(entry.snapshot.id, [entry.to], [entry.part]);
      return false;
    }
    if (roll < 0.48) {
      this.log.push(`${device.id} connect`);
      await device.connect();
      return false;
    }
    if (roll < 0.53) {
      this.log.push(`${device.id} disconnect`);
      device.disconnect();
      return false;
    }
    if (roll < 0.65) {
      const section = this.section(field);
      const text = this.text();
      this.log.push(`${device.id} add ${field}/${section} ${text}`);
      device.add(field, section, text);
      return false;
    }
    if (roll < 0.73) {
      const victim = this.pick(device.state(field).bullets.filter((bullet) => displayedSections(field).includes(bullet.section)));
      if (victim === undefined) return false;
      this.log.push(`${device.id} delete ${field}/${victim.section} ${victim.text}`);
      this.markDeleted(device, field, victim.section, victim.text);
      device.delete(field, victim.section, victim.text);
      return false;
    }
    if (roll < 0.78) {
      const victim = this.pick(device.state(field).bullets.filter((bullet) => displayedSections(field).includes(bullet.section)));
      if (victim === undefined) return false;
      const to = this.text();
      const section = field === "composition" && this.next() < 0.3 ? this.section(field) : victim.section;
      this.log.push(`${device.id} edit ${field}/${victim.section} ${victim.text} -> ${section} ${to}`);
      this.markDeleted(device, field, victim.section, victim.text);
      if (section === victim.section) device.editSection(field, section, (texts) => texts.map((text) => (text === victim.text ? to : text)));
      else {
        device.delete(field, victim.section, victim.text);
        device.add(field, section, to);
      }
      return false;
    }
    if (roll < 0.82) {
      const capture = this.captures.get(device);
      if (capture === undefined) {
        const section = this.section(field);
        this.log.push(`${device.id} capture ${field}/${section}`);
        this.captures.set(device, { field, section, epoch: device.prompts.sync.epoch(field), captured: device.prompts.sync.capture(field, [section]) });
        return false;
      }
      this.captures.delete(device);
      const captured = capture.captured ?? [];
      const result = captured.filter(() => this.next() < 0.6).map((bullet) => bullet.text);
      if (this.next() < 0.5) result.push(this.text());
      this.log.push(`${device.id} commit ${capture.field}/${capture.section} [${result.join(", ")}]`);
      // R30: a capture whose epoch ended since (a reset of its field, the texts' file reset) writes nothing.
      const ended = capture.epoch !== device.prompts.sync.epoch(capture.field);
      const before = JSON.stringify(device.state(capture.field));
      const saved = device.commit(capture.field, capture.section, capture.epoch, capture.captured, result);
      if (ended) {
        expect(saved, `${this.log.join("\n")}\nan ended capture was committed`).toBe(false);
        expect(JSON.stringify(device.state(capture.field)), `${this.log.join("\n")}\nan ended capture changed the field`).toBe(before);
      }
      // Only a commit that was saved deleted anything.
      if (saved) for (const bullet of captured) if (!result.includes(bullet.text)) this.markLabel(capture.field, bullet);
      return false;
    }
    if (roll < 0.85) {
      this.log.push(`${device.id} reset ${field}`);
      this.cleared = true;
      device.reset(field);
      return false;
    }
    if (roll < 0.88) {
      this.log.push(`${device.id} restart`);
      this.captures.delete(device);
      this.forgetMerged(device);
      device.restart();
      return false;
    }
    if (roll < 0.9) {
      this.log.push(`${device.id} next save fails`);
      device.store.failNext = true;
      return false;
    }
    if (roll < 0.92) {
      if (this.devices.length >= maxDevices) return false;
      device.prompts.flushHistory();
      const copy = this.create(device.store.copy());
      this.log.push(`${device.id} copied to ${copy.id}`);
      return false;
    }
    if (roll < 0.95) {
      const backup = this.backups.get(device);
      if (backup === undefined || this.next() < 0.5) {
        this.log.push(`${device.id} backup`);
        this.backups.set(device, device.store.copy());
        return false;
      }
      this.log.push(`${device.id} restore`);
      this.cleared = true;
      this.captures.delete(device);
      this.forgetMerged(device);
      device.disconnect();
      device.store.replaceWith(backup);
      device.restart();
      return false;
    }
    if (roll < 0.97) {
      this.log.push(`${device.id} reset of the texts' file`);
      this.cleared = true;
      // A capture taken before stays, to be refused at its commit (R30).
      this.forgetMerged(device);
      device.prompts.resetFile(() => device.store.replaceWith(ownedStore()));
      return false;
    }
    const texts = [this.text(), this.text()];
    this.log.push(`${device.id} legacy ${field} [${texts.join(", ")}]`);
    const text = field === "kb" ? texts.map((line) => `- ${line}`).join("\n") : `# Language (DO NOT EDIT/DELETE THIS SECTION HEADER)\n${texts.map((line) => `- ${line}`).join("\n")}`;
    device.receive({ type: "prompt_state", data: { [field]: text, [`${field}_updated_at`]: future } });
    return false;
  }

  /** The labels `device` shows for a text a user deletes there. */
  private markDeleted(device: BulletDevice, field: PromptField, section: string, text: string): void {
    for (const bullet of device.state(field).bullets) if (bullet.section === section && bullet.text === text) this.markLabel(field, bullet);
  }

  private markLabel(field: PromptField, bullet: Bullet): void {
    this.deleted.add(key(field, bullet));
  }

  /** A label no device holds any more went with a user's deletion: its own, or that of a label DS-DEDUP
   * kept in its place. */
  justified(field: PromptField, bullet: Bullet): boolean {
    const seen = new Set<string>();
    const pending = [key(field, bullet)];
    for (let label = pending.pop(); label !== undefined; label = pending.pop()) {
      if (this.deleted.has(label)) return true;
      if (seen.has(label)) continue;
      seen.add(label);
      pending.push(...(this.aliases.get(label) ?? []));
    }
    return false;
  }

  /** Every device connected afresh, and everything delivered (I3). */
  async settle(): Promise<void> {
    for (const device of this.devices) device.store.failNext = false;
    for (const device of this.devices) device.disconnect();
    for (const device of this.devices) await device.connect();
    let deliveries = 0;
    while (this.relay.deliverOldest()) {
      deliveries += 1;
      if (deliveries > maxDeliveries) throw new Error("I3: the devices never stop sending");
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test(`Device Sync keeps every bullet no user deleted, converges, and goes quiet (${seeds} seeds)`, { timeout: 600_000 }, async () => {
  // Seeds that end with a bullet in a section this version doesn't show held everywhere (DS-SECTION).
  let reached = 0;
  for (let seed = 1; seed <= seeds; seed += 1) {
    const next = random(seed);
    const fuzz = new Fuzz(next, next() < 0.3 ? 1_500 + Math.floor(next() * 1_500) : undefined);
    const fail = (message: string): never => {
      throw new Error(`seed ${seed}: ${message}\n${fuzz.log.slice(-40).join("\n")}`);
    };
    try {
      for (let index = 0; index < steps; index += 1) {
        const bullets = fuzz.bulletsHeld();
        const delivered = await fuzz.step();
        if (fuzz.violations.length > 0) fail(`step ${index + 1}: ${fuzz.violations.join("; ")}`);
        if (!delivered) continue;
        // I1 at every merge: a text gone from every device lost only labels a user deleted.
        const after = fuzz.held();
        for (const [label, { field, bullet }] of bullets) {
          if (after.labels.has(label) || after.items.has(itemKey(field, bullet))) continue;
          if (!fuzz.justified(field, bullet)) fail(`step ${index + 1}: I1: "${bullet.text}" (${label}) gone from every device, and no user deleted it`);
        }
      }
      const bullets = fuzz.bulletsHeld();
      await fuzz.settle();
      if (fuzz.violations.length > 0) fail(`settling: ${fuzz.violations.join("; ")}`);
      const after = fuzz.held();
      for (const [label, { field, bullet }] of bullets) {
        if (after.labels.has(label) || after.items.has(itemKey(field, bullet)) || fuzz.justified(field, bullet)) continue;
        fail(`I1: "${bullet.text}" (${label}) gone after settling, and no user deleted it`);
      }
      // Each field fits the budget, so nothing is held back (DS-OVERSIZE).
      for (const device of fuzz.devices) if (device.sync.tooLarge) fail(`${device.id} held a field back as oversize`);
      // I2: every device holds the same labels.
      for (const field of promptFields) {
        const first = JSON.stringify(
          fuzz.devices[0]
            ?.state(field)
            .bullets.map((bullet) => key(field, bullet))
            .sort(),
        );
        for (const device of fuzz.devices) {
          const labels = JSON.stringify(
            device
              .state(field)
              .bullets.map((bullet) => key(field, bullet))
              .sort(),
          );
          if (labels !== first) fail(`I2: ${device.id}'s ${field} ${labels} differs from A's ${first}`);
        }
      }
      if (fuzz.devices.every((device) => promptFields.some((field) => device.state(field).bullets.some((bullet) => bullet.section === "future")))) reached += 1;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`seed ${seed}:`)) throw error;
      fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
  }
  expect(seeds).toBeGreaterThan(0);
  expect(reached).toBeGreaterThan(0);
});
