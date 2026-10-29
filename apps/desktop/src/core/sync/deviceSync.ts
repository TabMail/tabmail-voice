// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AccountModel } from "../backend/account.js";
import * as config from "../config.js";
import { errorName, log } from "../log.js";
import { type PromptField, promptFields, type UserPrompts } from "../personalization/prompts.js";
import { Observable } from "../util/observable.js";

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

/**
 * Device Sync of the knowledge base and the writing style (root ADR-021, ADR-DESK-066): this computer
 * joins the user's Thunderbird and iOS apps through the relay, which forwards each message to the
 * user's other connected devices and keeps nothing. The transport of the labelled-bullet sync
 * (`BulletSync`, through `UserPrompts.sync`): each field's full state is sent on connect, after a
 * local change, and after a merge whose incoming labels differed from this computer's (DS-SEND); no
 * request is ever sent (DS-NO-REQUEST, DS-VOICE). A released device's `prompt_state` is imported,
 * additions only (DS-LEGACY-IN); nothing is sent in that format. No timer decides what is kept: the
 * only timers keep the connection alive and try it again.
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
  private updating = false;
  private updateAgain = false;
  /** The fields last held back by DS-OVERSIZE. */
  private readonly oversize = new Set<PromptField>();

  constructor(private readonly options: DeviceSyncOptions) {
    super();
    options.prompts.onLocalChange = (field) => this.send(field);
  }

  /** The last time a field was to be sent, one of its bullets alone was over the relay's message size,
   * so it wasn't (DS-OVERSIZE): Settings says so. */
  get tooLarge(): boolean {
    return this.oversize.size > 0;
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
    this.setOversize(null);
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
    this.pingTimer = null;
    // DS-CHUNK: incomplete snapshots are dropped with the connection.
    this.options.prompts.sync.disconnected();
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
        // DS-SEND: each field's state on connect; a device that holds other labels answers.
        for (const field of promptFields) this.send(field);
        break;
      case "bullet_state":
        this.receiveBullets(message);
        break;
      case "prompt_state":
        // DS-LEGACY-IN: a released device's texts, additions only; what changed goes on to updated devices.
        for (const field of this.options.prompts.sync.receiveLegacy(message.data)) this.send(field as PromptField);
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

  private receiveBullets(message: Record<string, unknown>): void {
    const outcome = this.options.prompts.sync.receive(message);
    if (outcome.kind !== "merged") return;
    log.debug(`DeviceSync: ${outcome.field} merged (${outcome.changed ? "changed" : "unchanged"}${outcome.send ? ", answered" : ""})`);
    if (outcome.send) this.send(outcome.field as PromptField);
  }

  /** Sends `field`'s full state (DS-SEND), in parts when over the relay's budget (DS-CHUNK); nothing,
   * and Settings says so, when one bullet alone is over it (DS-OVERSIZE). */
  private send(field: PromptField): void {
    if (!this.ready) return;
    const outgoing = this.options.prompts.sync.outgoing(field);
    if (outgoing.kind === "oversize") {
      this.setOversize(field, true);
      return;
    }
    for (const message of outgoing.messages) if (!this.sendText(JSON.stringify(message))) return;
    this.setOversize(field, false);
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

  /** `field` held back by DS-OVERSIZE or not; null clears every field. */
  private setOversize(field: PromptField | null, value = false): void {
    const before = this.oversize.size;
    if (field === null) this.oversize.clear();
    else if (value) this.oversize.add(field);
    else this.oversize.delete(field);
    if ((before > 0) !== (this.oversize.size > 0)) this.changed();
  }
}
