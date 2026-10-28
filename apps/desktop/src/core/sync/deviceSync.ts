// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AccountModel } from "../backend/account.js";
import * as config from "../config.js";
import { errorName, log } from "../log.js";
import { compositionSections, extractBullets, extractSection, mergeFlatField, mergeSectionedField } from "../personalization/bulletMerge.js";
import { defaultComposition, defaultKnowledgeBase } from "../personalization/defaults.js";
import { type PromptField, type PromptSyncChange, promptFields, type UserPrompts } from "../personalization/prompts.js";
import { Observable } from "../util/observable.js";
import { ancestorTime, epochZero, isSyncTime, nextSyncTime } from "./time.js";

/** A connection to the Device Sync relay, as the transport opened it. */
export interface SyncSocket {
  send(text: string): void;
  close(): void;
}

/** What the transport tells of the connection it opened: each text message, and its close (with the
 * close code, or 1006 when it failed). */
export interface SyncSocketEvents {
  message(text: string): void;
  closed(code: number): void;
}

export type OpenSyncSocket = (url: string, events: SyncSocketEvents) => SyncSocket;

export interface DeviceSyncOptions {
  prompts: UserPrompts;
  account: Pick<AccountModel, "session" | "validToken">;
  /** Whether the user's settings let Device Sync run: read, consent given, and its switch on. */
  allowed: () => boolean;
  /** The relay's address, without the token. */
  url: () => string;
  open: OpenSyncSocket;
}

/** The relay closes a connection whose access token expired with this code. */
const tokenExpiredCode = 4001;
const ping = JSON.stringify({ type: "ping" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultText(field: PromptField): string {
  return field === "kb" ? defaultKnowledgeBase : defaultComposition;
}

function merge(field: PromptField, base: string, local: string, remote: string): string {
  return field === "kb" ? mergeFlatField(base, local, remote) : mergeSectionedField(base, local, remote);
}

/** Whether `a` and `b` hold the same bullets (in each of the writing style's sections), in any order. */
function sameBullets(field: PromptField, a: string, b: string): boolean {
  const bullets = (text: string) =>
    JSON.stringify(field === "kb" ? [...new Set(extractBullets(text))].sort() : compositionSections.map((section) => [...new Set(extractBullets(extractSection(text, section)))].sort()));
  return bullets(a) === bullets(b);
}

/**
 * Device Sync of the knowledge base and the writing style (root ADR-021): this computer joins the
 * user's Thunderbird and iOS apps through the relay, which forwards each message to the user's other
 * connected devices and keeps nothing. Only those two texts are sent and taken; the relay's other
 * fields are Thunderbird's and iOS's.
 *
 * Merged as Thunderbird and iOS merge them, with rules more, so that no device loses a bullet its user
 * didn't remove, and a bullet added on one reaches all (one removed may stay on a device that can't
 * tell a removal from a bullet it never had):
 * - A text never synced here (none, or after a reset) is never offered as the newest: it is sent at
 *   epoch zero, which no device takes over its own, and the first text another device sends is merged
 *   three ways with the default as the common ancestor, so its bullets and this computer's both stay.
 * - Each text sent goes after its merge ancestor (`sendState`), so a device that never synced
 *   merges it rather than taking it whole.
 * - When a merge leaves this computer holding other bullets than the device that sent, the result is
 *   sent back, once for each pair of texts until the next probe.
 * - After sending its edits, or a merge back, it asks for the texts back: what comes back is the
 *   ancestor the next merge needs, so a bullet another device removes afterwards is removed here too.
 * - Thunderbird and iOS send nothing in answer to a text, and this computer sends back only the merge
 *   above: no exchange runs on by itself. It sends no acknowledgement and never sends a text again
 *   under the time it came with: either would have another device take an older text over a newer
 *   one, and lose a bullet.
 */
export class DeviceSync extends Observable {
  private socket: SyncSocket | null = null;
  /** The account the connection, or the one being made, is for, and the relay's address. */
  private userID: string | null = null;
  private address = "";
  /** The relay said `connected`. */
  private ready = false;
  /** Bumped as a connection ends, so an older one's token or events are ignored. */
  private generation = 0;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly edited = new Set<PromptField>();
  /** Each text sent back, with the text it was sent back for, until the next probe. */
  private readonly sentBack = new Set<string>();
  private updating = false;
  private updateAgain = false;
  private tooLargeNow = false;

  constructor(private readonly options: DeviceSyncOptions) {
    super();
    options.prompts.onLocalChange = (field, kind) => this.localChange(field, kind);
  }

  /** The last time the texts were to be sent, they were over the relay's message size, so weren't:
   * Settings says so. */
  get tooLarge(): boolean {
    return this.tooLargeNow;
  }

  /** Brings the connection in line with the account and the settings: run on every change of either,
   * and of the texts. The texts are first made the signed-in account's (`UserPrompts.claim`), whether
   * sync is on or not; sync runs only for an account they belong to, from a texts file that could be
   * read, while `allowed`. */
  update(): void {
    if (this.updating) {
      this.updateAgain = true;
      return;
    }
    this.updating = true;
    try {
      do {
        this.updateAgain = false;
        this.reconcile();
      } while (this.updateAgain);
    } finally {
      this.updating = false;
    }
  }

  /** The computer woke, or came back online: connects afresh, with every attempt back. */
  wake(): void {
    this.stop();
    this.update();
  }

  /** Ends the connection: the app is quitting. */
  stop(): void {
    this.generation += 1;
    this.userID = null;
    this.attempts = 0;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.closeSocket();
    this.setTooLarge(false);
  }

  private reconcile(): void {
    const { prompts, account } = this.options;
    const session = account.session;
    const owned = session !== null && prompts.fileProblem === undefined && prompts.claim(session.userID);
    if (!owned || !this.options.allowed()) {
      if (this.userID !== null) log.debug("DeviceSync: off");
      this.stop();
      return;
    }
    // Another account signed in (its texts were just made its own), or debug mode switched the relay:
    // synced afresh.
    if (this.userID !== null && (this.userID !== session.userID || this.address !== this.options.url())) this.stop();
    // Connected, connecting, waiting to try again, or out of attempts until `wake`.
    if (this.userID !== null) return;
    this.userID = session.userID;
    this.address = this.options.url();
    void this.connect(false);
  }

  private async connect(forceRefresh: boolean): Promise<void> {
    const generation = this.generation;
    const userID = this.userID;
    let token: string | null;
    try {
      token = await this.options.account.validToken(forceRefresh);
    } catch (error) {
      if (generation !== this.generation) return;
      log.debug(`DeviceSync: no token (${errorName(error)})`);
      this.retry();
      return;
    }
    if (generation !== this.generation) return;
    // Signed out, or another account signed in, while the token came: `update` sees to it.
    if (token === null || this.options.account.session?.userID !== userID) return;
    log.debug(`DeviceSync: connecting (attempt ${this.attempts + 1})`);
    try {
      this.socket = this.options.open(`${this.address}?token=${encodeURIComponent(token)}`, {
        message: (text) => {
          if (generation === this.generation) this.received(text);
        },
        closed: (code) => {
          if (generation === this.generation) this.closed(code);
        },
      });
    } catch (error) {
      log.debug(`DeviceSync: couldn't connect (${errorName(error)})`);
      this.retry();
    }
  }

  private closed(code: number): void {
    log.debug(`DeviceSync: connection closed (${code})`);
    this.generation += 1;
    this.socket = null;
    this.endConnection();
    if (code === tokenExpiredCode && this.attempts < config.deviceSyncReconnectAttempts) {
      this.attempts += 1;
      void this.connect(true);
      return;
    }
    this.retry();
  }

  /** Tries again after the backoff, until the attempts run out; then waits for `wake` or a change. */
  private retry(): void {
    if (this.attempts >= config.deviceSyncReconnectAttempts) {
      log.debug("DeviceSync: no more attempts until the computer wakes or comes back online");
      return;
    }
    const delay = Math.min(config.deviceSyncReconnectBaseDelay * 2 ** this.attempts, config.deviceSyncReconnectMaxDelay);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect(false);
    }, delay);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.endConnection();
    socket?.close();
  }

  private endConnection(): void {
    this.ready = false;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.probeTimer !== null) clearInterval(this.probeTimer);
    if (this.sendTimer !== null) clearTimeout(this.sendTimer);
    this.pingTimer = null;
    this.probeTimer = null;
    this.sendTimer = null;
    this.edited.clear();
    this.sentBack.clear();
  }

  private received(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      log.debug("DeviceSync: a message that isn't JSON; ignored");
      return;
    }
    if (!isRecord(message)) return;
    switch (message.type) {
      case "connected":
        if (this.ready) break;
        log.debug("DeviceSync: connected");
        this.ready = true;
        this.attempts = 0;
        this.pingTimer = setInterval(() => this.sendText(ping), config.deviceSyncPingInterval);
        this.probeTimer = setInterval(() => {
          // What another device didn't take before may be taken now: it's sent again once more.
          this.sentBack.clear();
          this.requestState(promptFields);
        }, config.deviceSyncProbeInterval);
        // Ask before offering anything: what comes back is merged, and only then sent on.
        this.requestState(promptFields);
        break;
      case "request_state": {
        const asked = Array.isArray(message.fields) && message.fields.length > 0 ? promptFields.filter((field) => (message.fields as unknown[]).includes(field)) : promptFields;
        if (asked.length > 0) this.sendState(asked);
        break;
      }
      case "prompt_state":
        this.receiveState(message.data);
        break;
      case "ai_cache_probe":
        // Thunderbird and iOS ask every other device for an AI result they may hold, and wait for each
        // answer: none here, answered at once.
        if (typeof message.probeId === "string") this.sendText(JSON.stringify({ type: "ai_cache_response", results: {}, probeId: message.probeId }));
        break;
      default:
        break;
    }
  }

  /** Merges what another device sent (Thunderbird's rules, with the ones for a text never synced here),
   * saves it in one write, then sends back the texts it holds other bullets than. */
  private receiveState(data: unknown): void {
    if (!isRecord(data)) return;
    const changes: Partial<Record<PromptField, PromptSyncChange>> = {};
    const resend: PromptField[] = [];
    for (const field of promptFields) {
      const remote = data[field];
      if (typeof remote !== "string") continue;
      const time = data[`${field}_updated_at`] || data.updatedAt || epochZero;
      if (!isSyncTime(time)) {
        log.debug(`DeviceSync: ${field} sent without a valid time; ignored`);
        continue;
      }
      // Another computer's merge ancestor, for devices that never synced: this one merges a first text
      // with the default instead.
      if (time === ancestorTime) continue;
      const local = this.options.prompts.syncState(field);
      // Older than the last text it sent, or that text again. A device keeps the time of the text it
      // merged in, so another text at that same time is its merge, and new.
      const stale = time < local.peerBaseTime || (time === local.peerBaseTime && remote === local.peerBase);
      let merged: string;
      if (local.peerBase === null) {
        // The first text another device sent: merged with the default as the common ancestor, so its
        // bullets and this computer's additions both stay, and taken as sent when it holds them all.
        merged = merge(field, defaultText(field), local.text, remote);
        if (sameBullets(field, merged, remote)) merged = remote;
      } else if (time === epochZero) {
        // A device's default or reset text: never taken, as Thunderbird and iOS never take it.
        continue;
      } else if (stale) {
        // A text merged already, or older: what it lacks of this computer's is sent again.
        if (sameBullets(field, local.text, remote)) continue;
        merged = local.text;
      } else {
        merged = local.text === local.peerBase ? remote : merge(field, local.peerBase, local.text, remote);
      }
      const change: PromptSyncChange = {};
      // The next merge's ancestor is what the other device sent, never the merge.
      if (local.peerBase === null || !stale) change.peerBase = { text: remote, time };
      if (merged !== local.text) {
        change.text = merged;
        change.time = time > local.time ? time : local.time;
      }
      // Sent back once for each pair of texts: the other device may have removed those bullets, and
      // neither takes what the other sends back again, so sending it again would never end.
      const pair = `${field}\u0000${remote}\u0000${merged}`;
      const sendBack = !sameBullets(field, merged, remote) && !this.sentBack.has(pair);
      if (sendBack) {
        change.time = nextSyncTime(Date.now(), [time, local.time, local.peerBaseTime]);
        this.sentBack.add(pair);
        resend.push(field);
      }
      log.debug(`DeviceSync: ${field} received (${remote.length} chars): ${merged === local.text ? "unchanged" : "merged"}${sendBack ? ", sent back" : ""}`);
      changes[field] = change;
    }
    if (Object.keys(changes).length === 0) return;
    if (!this.options.prompts.applySync(changes)) return;
    if (resend.length > 0) {
      this.sendState(resend);
      this.requestState(resend);
    }
  }

  private localChange(field: PromptField, kind: "edit" | "reset"): void {
    if (!this.ready) return;
    if (kind === "reset") {
      // The reset text is never sent: other devices' copy comes back.
      this.requestState([field]);
      return;
    }
    this.edited.add(field);
    if (this.sendTimer !== null) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      const fields = promptFields.filter((candidate) => this.edited.has(candidate));
      this.edited.clear();
      // One never synced is merged with theirs first, and sent on from there.
      const synced = fields.filter((candidate) => this.options.prompts.syncState(candidate).peerBase !== null);
      if (synced.length > 0) this.sendState(synced);
      this.requestState(fields);
    }, config.deviceSyncSendDelay);
  }

  private requestState(fields: readonly PromptField[]): void {
    this.sendText(JSON.stringify({ type: "request_state", fields }));
  }

  /** Sends `fields` with their times; a text never synced here with epoch zero, so no device takes it
   * over its own. A synced one goes after its merge ancestor, the last text another device sent, at
   * `ancestorTime`: a device that never synced would take a newer text whole and lose an edit of its
   * own, and with the ancestor first it merges instead; every other device skips it. Nothing is sent,
   * and Settings says so, when a message is over the relay's size. */
  private sendState(fields: readonly PromptField[]): void {
    const messages: Record<string, string>[] = [];
    const data: Record<string, string> = {};
    for (const field of fields) {
      const state = this.options.prompts.syncState(field);
      data[field] = state.text;
      data[`${field}_updated_at`] = state.peerBase === null ? epochZero : state.time;
      // One message for each, as each arrived: together they could be over the relay's size.
      if (state.peerBase !== null) messages.push({ [field]: state.peerBase, [`${field}_updated_at`]: ancestorTime });
    }
    const texts = [...messages, data].map((message) => JSON.stringify({ type: "prompt_state", data: message }));
    const size = Math.max(...texts.map((text) => new TextEncoder().encode(text).length));
    if (size > config.deviceSyncMessageMaxBytes) {
      log.error(`DeviceSync: ${fields.join(", ")} not sent: ${size} bytes, over the relay's ${config.deviceSyncMessageMaxBytes}`);
      this.setTooLarge(true);
      return;
    }
    if (texts.every((text) => this.sendText(text))) this.setTooLarge(false);
  }

  private sendText(text: string): boolean {
    if (!this.ready || this.socket === null) return false;
    try {
      this.socket.send(text);
      return true;
    } catch (error) {
      log.debug(`DeviceSync: send failed (${errorName(error)})`);
      return false;
    }
  }

  private setTooLarge(value: boolean): void {
    if (this.tooLargeNow === value) return;
    this.tooLargeNow = value;
    this.changed();
  }
}
