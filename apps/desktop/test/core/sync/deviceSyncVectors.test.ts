// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PromptField } from "../../../src/core/personalization/prompts.js";
import { type Bullet, type Catalog, type CatalogEntry, defaultCatalog, parse, render, type SyncField, trim } from "../../../src/core/sync/bullets.js";
import { BulletDevice, BulletRelay, type DeviceStore, ownedStore, storeStates } from "../../support/bulletDevices.js";

// The shared conformance vectors and default catalog, byte-identical in TabMail for Thunderbird, iOS and
// Voice: a change to either is made in all three, and these hashes with it.
const vectorsSha256 = "f656a5bfffbec4597a5fb0c97b63d9b4946f13bd67eeebe8f9cf1ddcc304a4a8";
const catalogSha256 = "1ca6383ba9af86b42e13736b453cc3932297da32141aaf21a08c2055d9339f5f";

const vectorsBytes = readFileSync(join(__dirname, "device-sync-vectors.json"));
const catalogBytes = readFileSync(join(__dirname, "../../../src/core/sync/device-sync-default-catalog.json"));

type Tuple = [string, string, string, number];
type Item = [string, string];

interface ParseVector {
  id: string;
  field: SyncField;
  text: string;
  head: string[];
  tail: string[];
  bullets: Item[];
  render?: string;
}

type Init = "new" | "empty" | "later" | "shared" | { legacy: Partial<Record<PromptField, string>> } | { state: Partial<Record<PromptField, { bullets: Tuple[]; seen: Record<string, number> }>> };

interface DeviceVector {
  id: string;
  init: Init;
  store?: string;
  catalogExtra?: CatalogEntry[];
}

type Step = Record<string, unknown> & { op: string };

interface Scenario {
  id: string;
  rules: string[];
  fields: string[];
  requires?: string[];
  budget?: number;
  devices: DeviceVector[];
  steps: Step[];
}

interface Vectors {
  catalogSha256: string;
  conventions: { trim: string[] };
  parse: ParseVector[];
  scenarios: Scenario[];
}

const vectors = JSON.parse(vectorsBytes.toString("utf8")) as Vectors;
/** What Voice syncs, and can do. */
const voiceFields = ["kb", "composition"];
const voiceCapabilities: string[] = [];
/** More deliveries than any scenario needs: messages that never stop. */
const maxDeliveries = 100_000;

function hex(value: number): string {
  return value.toString(16).padStart(8, "0");
}

function bullets(tuples: readonly Tuple[]): Bullet[] {
  return tuples.map(([section, text, name, n]) => ({ section, text, name, n }));
}

function tuples(list: readonly Bullet[]): Tuple[] {
  return list.map((bullet) => [bullet.section, bullet.text, bullet.name, bullet.n]);
}

function sortedJSON<T>(values: readonly T[]): string[] {
  return values.map((value) => JSON.stringify(value)).sort();
}

class ScenarioRun {
  readonly relay = new BulletRelay();
  readonly devices = new Map<string, BulletDevice>();
  readonly backups = new Map<string, DeviceStore>();
  readonly captures = new Map<string, { device: BulletDevice; field: PromptField; section: string; captured: Bullet[] | null }>();
  private readonly specs = new Map<string, { index: number; spec: DeviceVector }>();

  constructor(private readonly scenario: Scenario) {
    scenario.devices.forEach((spec, index) => this.specs.set(spec.id, { index: index + 1, spec }));
    for (const spec of scenario.devices) {
      if (spec.init === "later") continue;
      const store = spec.init === "shared" ? this.device(spec.store as string).store : this.initialStore(spec.init);
      this.create(spec.id, store);
    }
  }

  private initialStore(init: Init): DeviceStore {
    const store = ownedStore();
    if (init === "new") return store;
    if (init === "empty") {
      storeStates(store, {});
      return store;
    }
    if (typeof init === "object" && "legacy" in init) {
      for (const [field, text] of Object.entries(init.legacy)) store.set(field === "kb" ? "user_prompts:user_kb.md" : "user_prompts:user_composition.md", text);
      return store;
    }
    if (typeof init === "object" && "state" in init) {
      storeStates(
        store,
        Object.fromEntries(Object.entries(init.state).map(([field, value]) => [field, { bullets: bullets(value.bullets), seen: new Map(Object.entries(value.seen)) }])),
      );
      return store;
    }
    throw new Error(`unknown init ${JSON.stringify(init)}`);
  }

  private create(id: string, store: DeviceStore): BulletDevice {
    const { index, spec } = this.specs.get(id) as { index: number; spec: DeviceVector };
    const catalog: Catalog | undefined = spec.catalogExtra === undefined ? undefined : { ...defaultCatalog, defaults: [...defaultCatalog.defaults, ...spec.catalogExtra] };
    const device = new BulletDevice(id, store, this.relay, { name: (k) => `${hex(index)}${hex(k)}`, budget: this.scenario.budget, catalog });
    this.devices.set(id, device);
    return device;
  }

  device(id: unknown): BulletDevice {
    const device = this.devices.get(String(id));
    if (device === undefined) throw new Error(`no device ${String(id)}`);
    return device;
  }

  /** Every pending part delivered to the devices that have yet to get it, oldest first. */
  quiesce(): void {
    let deliveries = 0;
    while (this.relay.deliverOldest()) {
      deliveries += 1;
      if (deliveries > maxDeliveries) throw new Error("the devices never stop sending");
    }
  }

  async run(step: Step): Promise<void> {
    const field = step.field as PromptField | undefined;
    switch (step.op) {
      case "connect":
        await this.device(step.device).connect();
        return;
      case "disconnect":
        this.device(step.device).disconnect();
        return;
      case "restart":
        this.device(step.device).restart();
        return;
      case "add":
        this.device(step.device).add(field as PromptField, step.section as string, step.text as string);
        return;
      case "delete":
        this.device(step.device).delete(field as PromptField, step.section as string, step.text as string);
        return;
      case "edit": {
        const [fromSection, fromText] = step.from as Item;
        const [toSection, toText] = step.to as Item;
        const device = this.device(step.device);
        if (fromSection === toSection) device.editSection(field as PromptField, fromSection, (texts) => texts.map((text) => (text === fromText ? toText : text)));
        else {
          device.delete(field as PromptField, fromSection, fromText);
          device.add(field as PromptField, toSection, toText);
        }
        return;
      }
      case "capture": {
        const device = this.device(step.device);
        const section = step.section as string;
        this.captures.set(step.as as string, { device, field: field as PromptField, section, captured: device.prompts.sync.capture(field as PromptField, [section]) });
        return;
      }
      case "commit": {
        const capture = this.captures.get(step.capture as string);
        if (capture === undefined) throw new Error(`no capture ${String(step.capture)}`);
        capture.device.commit(capture.field, capture.section, capture.captured, step.result as string[]);
        return;
      }
      case "reset":
        this.device(step.device).reset(field as PromptField);
        return;
      case "fail_next_save":
        this.device(step.device).store.failNext = true;
        return;
      case "copy": {
        const from = this.device(step.from);
        from.prompts.flushHistory();
        this.create(step.to as string, from.store.copy());
        return;
      }
      case "backup":
        this.backups.set(step.as as string, this.device(step.device).store.copy());
        return;
      case "restore": {
        const device = this.device(step.device);
        device.disconnect();
        device.store.replaceWith(this.backups.get(step.from as string) as DeviceStore);
        device.restart();
        return;
      }
      case "deliver": {
        const id = step.msg as string;
        const snapshot = this.relay.snapshots.get(id);
        if (snapshot === undefined) throw new Error(`no message ${id}`);
        const to = (step.to as string[] | undefined) ?? [...new Set(this.relay.pending.filter((entry) => entry.snapshot === snapshot).map((entry) => entry.to))];
        const parts = (step.parts as number[] | undefined) ?? snapshot.parts.map((_, index) => index + 1);
        for (const device of to) for (const part of parts) this.relay.deliver(id, device, part);
        return;
      }
      case "drop":
        this.relay.drop(step.msg as string, step.to as string[] | undefined, step.parts as number[] | undefined);
        return;
      case "quiesce":
        this.quiesce();
        return;
      case "raw":
        this.device(step.to).receive(step.message);
        return;
      case "legacy":
        this.device(step.to).receive({ type: "prompt_state", data: step.data });
        return;
      case "expect":
        this.expectState(step);
        return;
      case "expect_sent":
        expect(this.relay.sent(step.device as string, step.field as string), `${String(step.device)} ${String(step.field)} snapshots sent`).toBe(step.count);
        return;
      case "expect_quiet":
        expect(this.relay.pending.map((entry) => `${entry.snapshot.id}/${entry.part} to ${entry.to}`)).toEqual([]);
        return;
      case "expect_oversize":
        expect(this.device(step.device).sync.tooLarge).toBe(step.value);
        return;
      default:
        throw new Error(`unknown op ${step.op}`);
    }
  }

  private expectState(step: Step): void {
    const device = this.device(step.device);
    const state = device.state(step.field as PromptField);
    const what = `${device.id} ${String(step.field)}`;
    const items = state.bullets.map((bullet): Item => [bullet.section, bullet.text]);
    if (step.live !== undefined) expect(sortedJSON(tuples(state.bullets)), `${what} live`).toEqual(sortedJSON(step.live as Tuple[]));
    if (step.texts !== undefined) expect(sortedJSON(items), `${what} texts`).toEqual(sortedJSON(step.texts as Item[]));
    for (const item of (step.has as Item[] | undefined) ?? []) expect(sortedJSON(items), `${what} has`).toContain(JSON.stringify(item));
    for (const item of (step.lacks as Item[] | undefined) ?? []) expect(sortedJSON(items), `${what} lacks`).not.toContain(JSON.stringify(item));
    if (step.seen !== undefined) expect(Object.fromEntries([...state.seen].sort(([a], [b]) => (a < b ? -1 : 1))), `${what} seen`).toEqual(step.seen);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the shared conformance vectors", () => {
  test("are the shared files, byte for byte", () => {
    expect(createHash("sha256").update(catalogBytes).digest("hex")).toBe(catalogSha256);
    expect(createHash("sha256").update(vectorsBytes).digest("hex")).toBe(vectorsSha256);
    expect(vectors.catalogSha256).toBe(catalogSha256);
  });

  // R2: the same characters are trimmed on every platform, or a text one stores is one another refuses.
  test.each(vectors.conventions.trim)("trims U+%s at both ends and keeps it inside", (hex) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    expect(trim(`${character}${character}a${character}b${character}`)).toBe(`a${character}b`);
  });

  test("trims nothing outside the R2 list", () => {
    expect(vectors.conventions.trim).toHaveLength(25);
    expect(trim("\u200Ba\u0085\u180E")).toBe("\u200Ba\u0085\u180E");
  });

  test.each(vectors.parse)("parse $id", (vector) => {
    const parsed = parse(vector.field, vector.text);
    expect({ head: parsed.head, tail: parsed.tail, bullets: parsed.bullets.map((bullet) => [bullet.section, bullet.text]) }).toEqual({
      head: vector.head,
      tail: vector.tail,
      bullets: vector.bullets,
    });
    const rendered = render(vector.field, { ...parsed, bullets: parsed.bullets.map((bullet) => ({ ...bullet, name: "default:x", n: 1 })) });
    if (vector.render !== undefined) expect(rendered).toBe(vector.render);
    // Stable after one round: the rendered text parses to the same bullets, each section's in order (render
    // puts a repeated section's bullets together), and renders the same.
    const again = parse(vector.field, rendered);
    const bySection = (list: readonly { section: string; text: string }[]) => Object.groupBy(list, (bullet) => bullet.section);
    expect(bySection(again.bullets)).toEqual(bySection(parsed.bullets));
    expect(render(vector.field, { ...again, bullets: again.bullets.map((bullet) => ({ ...bullet, name: "default:x", n: 1 })) })).toBe(rendered);
  });

  const runnable = vectors.scenarios.filter((scenario) => scenario.fields.every((field) => voiceFields.includes(field)) && (scenario.requires ?? []).every((need) => voiceCapabilities.includes(need)));

  test("Voice runs every scenario but those for a field or a capability it doesn't have", () => {
    expect(vectors.scenarios.filter((scenario) => !runnable.includes(scenario)).map((scenario) => scenario.id)).toEqual(["legacy-out-precheck"]);
  });

  test.each(runnable.map((scenario) => [scenario.id, scenario] as const))("%s", async (_id, scenario) => {
    const run = new ScenarioRun(scenario);
    for (const [index, step] of scenario.steps.entries()) {
      try {
        await run.run(step);
      } catch (error) {
        throw new Error(`step ${index + 1} (${JSON.stringify(step).slice(0, 200)}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
  });
});
