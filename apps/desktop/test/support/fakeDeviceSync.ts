// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { vi } from "vitest";
import type { AccountModel } from "../../src/core/backend/account.js";
import * as config from "../../src/core/config.js";
import { extractBullets, extractSection, mergeFlatField, mergeSectionedField, replaceSection } from "../../src/core/personalization/bulletMerge.js";
import { defaultComposition, defaultKnowledgeBase } from "../../src/core/personalization/defaults.js";
import { type PromptField, promptFields, UserPrompts } from "../../src/core/personalization/prompts.js";
import { DeviceSync, type OpenSyncSocket, type SyncSocket, type SyncSocketEvents } from "../../src/core/sync/deviceSync.js";
import { epochZero } from "../../src/core/sync/time.js";
import { MemoryStore } from "../../src/core/util/keyValueStore.js";
import { Fixtures, signedIn } from "./stubs.js";

/** One end of the relay: what it was sent, waiting to be delivered in order. */
interface Endpoint {
  readonly name: string;
  readonly inbox: string[];
  deliver(text: string): void;
}

/** The message types the relay forwards (`tabmail-device-sync-worker`); it answers a ping itself. */
const relayedTypes = ["request_state", "prompt_state", "ai_cache_probe", "ai_cache_response"];
const ping = JSON.stringify({ type: "ping" });

/** The Device Sync relay as the worker runs it: each message forwarded to every other connected
 * device, in order per device, nothing kept; a message over 128 KiB dropped, saying nothing. Delivery
 * is the test's: all at once (`settle`), or one device's next message at a time (`deliverOne`). */
export class FakeRelay {
  private endpoints: Endpoint[] = [];
  /** Every message a device sent, pings aside, as sent. */
  readonly sent: { from: string; text: string }[] = [];
  /** The addresses Voice connected to. */
  readonly urls: string[] = [];
  private voiceEvents = new Map<Endpoint, SyncSocketEvents>();

  /** `DeviceSync`'s transport: connects at once, and says `connected` as the relay does. */
  open(name: string): OpenSyncSocket {
    return (url, events) => {
      this.urls.push(url);
      const endpoint: Endpoint = { name, inbox: [], deliver: (text) => events.message(text) };
      this.voiceEvents.set(endpoint, events);
      this.join(endpoint);
      return {
        send: (text) => this.send(endpoint, text),
        close: () => this.leave(endpoint),
      } satisfies SyncSocket;
    };
  }

  join(endpoint: Endpoint): void {
    this.endpoints.push(endpoint);
    endpoint.inbox.push(JSON.stringify({ type: "connected", userId: Fixtures.userID, timestamp: Date.now() }));
  }

  leave(endpoint: Endpoint): void {
    this.endpoints = this.endpoints.filter((other) => other !== endpoint);
    endpoint.inbox.length = 0;
  }

  /** The relay closes `name`'s connection with `code` (4001 for an expired token). */
  close(name: string, code: number): void {
    const endpoint = this.endpoints.find((candidate) => candidate.name === name);
    if (endpoint === undefined) return;
    this.leave(endpoint);
    this.voiceEvents.get(endpoint)?.closed(code);
  }

  isConnected(name: string): boolean {
    return this.endpoints.some((endpoint) => endpoint.name === name);
  }

  send(from: Endpoint, text: string): void {
    if (!this.endpoints.includes(from)) return;
    if (text === ping) {
      from.inbox.push(JSON.stringify({ type: "pong" }));
      return;
    }
    this.sent.push({ from: from.name, text });
    if (new TextEncoder().encode(text).length > config.deviceSyncMessageMaxBytes) return;
    const type = (JSON.parse(text) as { type?: unknown }).type;
    if (typeof type !== "string" || !relayedTypes.includes(type)) return;
    for (const other of this.endpoints) if (other !== from) other.inbox.push(text);
  }

  /** The messages `from` sent of `type`, parsed. */
  messages(from: string, type: string): Record<string, unknown>[] {
    return this.sent
      .filter((entry) => entry.from === from)
      .map((entry) => JSON.parse(entry.text) as Record<string, unknown>)
      .filter((message) => message.type === type);
  }

  /** Puts `text` in `name`'s inbox as if the relay forwarded it, whatever it is. */
  inject(name: string, text: string): void {
    this.endpoints.find((endpoint) => endpoint.name === name)?.inbox.push(text);
  }

  /** Names of the devices with a message waiting. */
  waiting(): string[] {
    return this.endpoints.filter((endpoint) => endpoint.inbox.length > 0).map((endpoint) => endpoint.name);
  }

  /** Delivers `name`'s next message. */
  deliverOne(name: string): void {
    const endpoint = this.endpoints.find((candidate) => candidate.name === name);
    const text = endpoint?.inbox.shift();
    if (endpoint !== undefined && text !== undefined) endpoint.deliver(text);
  }

  /** Delivers everything, and lets the edits' send delays pass, until nothing more is sent. */
  async settle(): Promise<void> {
    for (let round = 0; round < 100; round += 1) {
      await vi.advanceTimersByTimeAsync(0);
      const names = this.waiting();
      if (names.length === 0) {
        await vi.advanceTimersByTimeAsync(Math.max(config.deviceSyncSendDelay, thunderbirdBroadcastDelay));
        if (this.waiting().length === 0) return;
        continue;
      }
      for (const name of names) this.deliverOne(name);
    }
    throw new Error(`the relay never settled: ${this.sent.slice(-12).map((entry) => `${entry.from} ${entry.text.slice(0, 120)}`).join("\n")}`);
  }
}

/** A Voice device: its texts' store, signed in, its `DeviceSync` on the relay, wired as the app wires
 * it (an update at every change of the texts). */
export class VoiceDevice {
  readonly prompts: UserPrompts;
  readonly sync: DeviceSync;
  readonly account: AccountModel;
  allowed = true;
  /** The relay's address, as debug mode picks it. */
  url = config.deviceSyncURL;

  constructor(
    relay: FakeRelay,
    readonly store: MemoryStore = new MemoryStore(),
    readonly name = "voice",
    userID = Fixtures.userID,
  ) {
    this.prompts = new UserPrompts(store);
    this.account = signedIn(undefined, Fixtures.session({ userID }));
    this.sync = new DeviceSync({ prompts: this.prompts, account: this.account, allowed: () => this.allowed, url: () => this.url, open: relay.open(name) });
    this.prompts.observe(() => this.sync.update());
    this.account.observe(() => this.sync.update());
  }

  get kb(): string[] {
    return extractBullets(this.prompts.knowledgeBase);
  }

  section(section: string): string[] {
    return extractBullets(extractSection(this.prompts.composition, section));
  }

  /** The user (or `kb_add`) adds `bullet` to the knowledge base. */
  addKB(bullet: string): void {
    this.prompts.updateKnowledgeBase((current) => `${current}\n- ${bullet}`);
  }

  removeKB(bullet: string): void {
    const shown = this.kb;
    this.prompts.editKnowledgeBase(shown, shown.filter((other) => other !== bullet));
  }

  addStyle(section: string, bullet: string): void {
    const shown = this.section(section);
    this.prompts.editCompositionSection(section, shown, [...shown, bullet]);
  }

  removeStyle(section: string, bullet: string): void {
    const shown = this.section(section);
    this.prompts.editCompositionSection(section, shown, shown.filter((other) => other !== bullet));
  }
}

/** A text as Thunderbird and iOS keep it for Device Sync. */
interface PeerField {
  text: string;
  time: string;
  peerBase: string | null;
  peerBaseTime: string;
}

/** Thunderbird's `BROADCAST_DEBOUNCE_MS`: an edit goes out this long after the last one. */
const thunderbirdBroadcastDelay = 500;

/**
 * Thunderbird's add-on (and iOS, whose rules are the same) as another device on the relay, its Device
 * Sync rules ported from `agent/modules/deviceSync.js` for the knowledge base and the writing style: on
 * `connected` it asks for every field when all its times are epoch zero, else sends them all; it
 * answers `request_state` with what it holds; and it merges a `prompt_state` by its six steps (epoch
 * zero skipped, a stale one skipped, a first sync last-writer-wins, a fast-forward, else a three-way
 * merge with the peer base, which is always the text received). It never sends a merge back. An edit
 * is stamped now and sent once edits stop for `thunderbirdBroadcastDelay`.
 */

export class ThunderbirdPeer implements Endpoint {
  readonly inbox: string[] = [];
  readonly fields: Record<PromptField, PeerField>;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly edited = new Set<PromptField>();

  constructor(
    private readonly relay: FakeRelay,
    readonly name = "thunderbird",
    texts: Partial<Record<PromptField, string>> = {},
  ) {
    const field = (text: string | undefined, fallback: string): PeerField => ({
      text: text ?? fallback,
      time: text === undefined ? epochZero : new Date().toISOString(),
      peerBase: null,
      peerBaseTime: epochZero,
    });
    this.fields = { composition: field(texts.composition, defaultComposition), kb: field(texts.kb, defaultKnowledgeBase) };
  }

  get kb(): string[] {
    return extractBullets(this.fields.kb.text);
  }

  section(section: string): string[] {
    return extractBullets(extractSection(this.fields.composition.text, section));
  }

  connect(): void {
    this.relay.join(this);
  }

  disconnect(): void {
    this.relay.leave(this);
  }

  /** The user edits `field` here: stamped now, and sent once edits stop for a while, as the texts are
   * then (Thunderbird's debounced broadcast). */
  edit(field: PromptField, text: string): void {
    this.fields[field] = { ...this.fields[field], text, time: new Date().toISOString() };
    this.edited.add(field);
    if (this.broadcastTimer !== null) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const fields = promptFields.filter((candidate) => this.edited.has(candidate));
      this.edited.clear();
      this.send({ type: "prompt_state", data: this.state(fields) });
    }, thunderbirdBroadcastDelay);
  }

  addKB(bullet: string): void {
    this.edit("kb", `${this.fields.kb.text}\n- ${bullet}`);
  }

  removeKB(bullet: string): void {
    this.edit("kb", this.kb.filter((other) => other !== bullet).map((other) => `- ${other}`).join("\n"));
  }

  addStyle(section: string, bullet: string): void {
    this.edit("composition", replaceSection(this.fields.composition.text, section, [...this.section(section), bullet].map((other) => `- ${other}`).join("\n")));
  }

  removeStyle(section: string, bullet: string): void {
    this.edit("composition", replaceSection(this.fields.composition.text, section, this.section(section).filter((other) => other !== bullet).map((other) => `- ${other}`).join("\n")));
  }

  /** Thunderbird's five-minute probe. */
  probe(): void {
    this.send({ type: "request_state", fields: ["composition", "action", "kb", "templates", "disabledReminders", "taskCache", "actionConfig"] });
  }

  deliver(text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
    switch (message.type) {
      case "connected":
        if (promptFields.every((field) => this.fields[field].time === epochZero)) this.probe();
        else this.send({ type: "prompt_state", data: this.state(promptFields) });
        break;
      case "request_state": {
        const asked = Array.isArray(message.fields) && message.fields.length > 0 ? promptFields.filter((field) => (message.fields as unknown[]).includes(field)) : promptFields;
        this.send({ type: "prompt_state", data: this.state(asked) });
        break;
      }
      case "prompt_state":
        this.receive(message.data as Record<string, unknown>);
        break;
      default:
        break;
    }
  }

  private receive(data: Record<string, unknown>): void {
    for (const field of promptFields) {
      const remote = data[field];
      if (typeof remote !== "string") continue;
      const incoming = (data[`${field}_updated_at`] || data.updatedAt || epochZero) as string;
      if (incoming === epochZero) continue;
      const local = this.fields[field];
      if (incoming <= local.peerBaseTime) continue;
      let result: string | null = null;
      if (local.peerBase === null) {
        if (incoming > local.time) result = remote;
      } else if (local.text === local.peerBase) {
        result = remote;
      } else {
        const merged = field === "kb" ? mergeFlatField(local.peerBase, local.text, remote) : mergeSectionedField(local.peerBase, local.text, remote);
        if (merged !== local.text) result = merged;
      }
      this.fields[field] = {
        text: result ?? local.text,
        time: result !== null && result !== local.text ? (incoming > local.time ? incoming : local.time) : local.time,
        peerBase: remote,
        peerBaseTime: incoming,
      };
    }
  }

  /** What Thunderbird's `readLocalState` sends: the fields asked for with their times, the deprecated
   * `updatedAt`, and an email-only field Voice ignores. */
  private state(fields: readonly PromptField[]): Record<string, unknown> {
    const data: Record<string, unknown> = { updatedAt: new Date().toISOString(), action: "- Example action rule", action_updated_at: new Date().toISOString() };
    for (const field of fields) {
      data[field] = this.fields[field].text;
      data[`${field}_updated_at`] = this.fields[field].time;
    }
    return data;
  }

  private send(message: Record<string, unknown>): void {
    this.relay.send(this, JSON.stringify(message));
  }
}

