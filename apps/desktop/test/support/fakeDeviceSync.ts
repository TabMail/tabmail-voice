// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { vi } from "vitest";
import type { AccountModel } from "../../src/core/backend/account.js";
import * as config from "../../src/core/config.js";
import { type PromptField, UserPrompts, type UserPromptsOptions } from "../../src/core/personalization/prompts.js";
import { DeviceSync, type OpenSyncSocket, type SyncSocket, type SyncSocketEvents } from "../../src/core/sync/deviceSync.js";
import { MemoryStore } from "../../src/core/util/keyValueStore.js";
import { Fixtures, signedIn, StubTransport } from "./stubs.js";

/** One end of the relay: what it was sent, waiting to be delivered in order. */
interface Endpoint {
  readonly name: string;
  readonly inbox: string[];
  deliver(text: string): void;
}

/** The message types the relay forwards (`tabmail-device-sync-worker`); it answers a ping itself. */
const relayedTypes = ["bullet_state", "request_state", "prompt_state", "ai_cache_probe", "ai_cache_response"];
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
  private events = new Map<Endpoint, SyncSocketEvents>();

  /** `DeviceSync`'s transport: connects at once, and says `connected` as the relay does. */
  open(name: string): OpenSyncSocket {
    return (url, events) => {
      this.urls.push(url);
      const endpoint: Endpoint = { name, inbox: [], deliver: (text) => events.message(text) };
      this.events.set(endpoint, events);
      this.join(endpoint);
      return {
        send: (text) => this.send(endpoint, text),
        close: () => this.leave(endpoint),
      } satisfies SyncSocket;
    };
  }

  /** Another device on the relay, run by the test: what it is sent waits in its inbox. */
  peer(name: string): Endpoint {
    const endpoint: Endpoint = { name, inbox: [], deliver: () => {} };
    this.endpoints.push(endpoint);
    return endpoint;
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
    this.events.get(endpoint)?.closed(code);
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
    if (new TextEncoder().encode(text).length > 128 * 1024) return;
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

  /** Delivers `name`'s next message. */
  deliverOne(name: string): void {
    const endpoint = this.endpoints.find((candidate) => candidate.name === name);
    const text = endpoint?.inbox.shift();
    if (endpoint !== undefined && text !== undefined) endpoint.deliver(text);
  }

  /** Delivers everything to the Voice devices until nothing more is sent; a test peer's inbox keeps
   * what it was sent. */
  async settle(): Promise<void> {
    for (let round = 0; round < 1_000; round += 1) {
      await vi.advanceTimersByTimeAsync(0);
      const names = this.endpoints.filter((endpoint) => this.events.has(endpoint) && endpoint.inbox.length > 0).map((endpoint) => endpoint.name);
      if (names.length === 0) return;
      for (const name of names) this.deliverOne(name);
    }
    throw new Error(`the relay never settled: ${this.sent.slice(-12).map((entry) => `${entry.from} ${entry.text.slice(0, 120)}`).join("\n")}`);
  }
}

/** A Voice device: its texts' store, signed in, its `DeviceSync` on the relay, wired as the app wires
 * it (an update at every change of the texts and of the account). */
export class VoiceDevice {
  readonly prompts: UserPrompts;
  readonly sync: DeviceSync;
  readonly account: AccountModel;
  /** The auth server: a test queues a session here to sign another account in. */
  readonly auth = new StubTransport();
  allowed = true;
  /** The relay's address, as debug mode picks it. */
  url = config.deviceSyncURL;

  constructor(
    relay: FakeRelay,
    readonly store: MemoryStore = new MemoryStore(),
    readonly name = "voice",
    userID = Fixtures.userID,
    options: UserPromptsOptions = {},
  ) {
    this.prompts = new UserPrompts(store, options);
    this.account = signedIn(this.auth, Fixtures.session({ userID }));
    this.sync = new DeviceSync({ prompts: this.prompts, account: this.account, allowed: () => this.allowed, url: () => this.url, open: relay.open(name) });
    this.prompts.observe(() => this.sync.update());
    this.account.observe(() => this.sync.update());
  }

  /** The texts of `field`'s live bullets in `section`, in order. */
  texts(field: PromptField, section = ""): string[] {
    return this.prompts.shown(field, section).map((bullet) => bullet.text);
  }

  add(field: PromptField, section: string, text: string): void {
    if (field === "kb") this.prompts.addKnowledge(text);
    else this.prompts.editCompositionSection(section, this.prompts.shown(field, section), [...this.texts(field, section), text]);
  }

  remove(field: PromptField, section: string, text: string): void {
    const shown = this.prompts.shown(field, section);
    const edited = shown.map((bullet) => bullet.text).filter((other) => other !== text);
    if (field === "kb") this.prompts.editKnowledgeBase(shown, edited);
    else this.prompts.editCompositionSection(section, shown, edited);
  }
}
