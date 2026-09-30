// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountModel, AuthClient, type SessionStore, type TabMailSession } from "../../src/core/backend/account.js";
import type { ScriptRunner } from "../../src/core/agent/connectors/appleScript.js";
import type { AudioCapture } from "../../src/core/audio/recorder.js";
import * as config from "../../src/core/config.js";
import { type HTTPRequest, type HTTPTransport, TransportError } from "../../src/core/backend/http.js";
import { observeContent } from "../../src/core/log.js";

/** Scripted HTTP transport: records every request, answers from a queue. With nothing queued it
 * fails as an unreachable server does. */
export class StubTransport {
  readonly requests: HTTPRequest[] = [];
  private readonly replies: { status: number; body: string }[] = [];
  /** Suspends each request until it resolves (for single-flight and cancellation tests). */
  gate: ((request: HTTPRequest) => Promise<void>) | undefined;
  /** Answers a canceled request as `liveTransport` does: one canceled before it goes out is never
   * sent, and one canceled while it waits fails. Off, a reply arrives however the request is
   * canceled (as one already on its way does). */
  honorsCancel = false;
  /** How much of a reply's body each piece streamed to `onChunk` holds. */
  chunkSize = Number.POSITIVE_INFINITY;

  enqueue(status: number, body: unknown): void {
    this.replies.push({ status, body: typeof body === "string" ? body : JSON.stringify(body) });
  }

  readonly transport: HTTPTransport = async (request) => {
    if (this.honorsCancel && request.signal?.aborted) throw new TransportError("canceled");
    this.requests.push(request);
    await this.gate?.(request);
    if (this.honorsCancel && request.signal?.aborted) throw new TransportError("canceled");
    const reply = this.replies.shift();
    if (!reply) throw new TransportError("network");
    // Streamed as `liveTransport` does, in pieces of `chunkSize` characters.
    for (let start = 0; start < reply.body.length; start += this.chunkSize) request.onChunk?.(reply.body.slice(start, start + this.chunkSize));
    return { status: reply.status, headers: {}, body: reply.body };
  };

  /** The `Authorization` header of each request. */
  get authorizations(): (string | undefined)[] {
    return this.requests.map((request) => request.headers.Authorization);
  }

  /** The JSON body of the `index`th request. */
  body(index: number): Record<string, unknown> {
    const request = this.requests[index];
    return request ? (JSON.parse(request.body) as Record<string, unknown>) : {};
  }

  /** The first message of the `index`th completions request. */
  message(index: number): Record<string, unknown> | undefined {
    return (this.body(index).messages as Record<string, unknown>[] | undefined)?.[0];
  }
}

export class InMemorySessionStore implements SessionStore {
  constructor(private session: TabMailSession | null = null) {}

  load(): TabMailSession | null {
    return this.session;
  }

  save(session: TabMailSession): void {
    this.session = session;
  }

  clear(): void {
    this.session = null;
  }
}

export const Fixtures = {
  userID: "user-1",
  email: "person@example.com",

  session(options: { access?: string; refresh?: string; expiresIn?: number; userID?: string } = {}): TabMailSession {
    return {
      accessToken: options.access ?? "access-1",
      refreshToken: options.refresh ?? "refresh-1",
      expiresAt: Math.floor(Date.now() / 1000) + (options.expiresIn ?? 3600),
      userID: options.userID ?? Fixtures.userID,
      userEmail: Fixtures.email,
    };
  },

  sessionJSON(options: { access: string; refresh: string; expiresIn?: number; userID?: string }): Record<string, unknown> {
    return {
      access_token: options.access,
      refresh_token: options.refresh,
      expires_at: Math.floor(Date.now() / 1000) + (options.expiresIn ?? 3600),
      user: { id: options.userID ?? Fixtures.userID, email: Fixtures.email },
    };
  },

  /** What `POST /completions/chat` streams: a comment primer, keepalives while the model works,
   * then a `final` event with the given payload. */
  completionsStream(final: string): string {
    return `: ${" ".repeat(20)}\n\nevent: keepalive\ndata: {}\n\nevent: keepalive\ndata: {}\n\nevent: final\ndata: ${final}\n\n`;
  },

  /** A completions stream whose reply is `assistant`. */
  reply(assistant: string): string {
    return Fixtures.completionsStream(JSON.stringify({ assistant }));
  },

  /** A completions stream whose tool-loop round calls `calls`, with the loop's `state`. */
  toolCalls(calls: { id: string; name: string; arguments: string }[], state: unknown = Fixtures.loopState()): string {
    return Fixtures.completionsStream(
      JSON.stringify({ tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })), conversation_state: state }),
    );
  },

  /** The loop's state as the backend returns it with a round's tool calls: its history so far, which
   * the app adds the tools' results to. */
  loopState(): Record<string, unknown> {
    return { harmony_messages: [{ role: "user", content: "Example request" }], tool_traces: [], current_round: 1, ts_ms: 1 };
  },

  /** An add-on (TabMail's unless `id` says otherwise) as a Thunderbird profile's `extensions.json`
   * lists it. */
  addon(options: { id?: string; userDisabled?: boolean; appDisabled?: boolean } = {}): Record<string, unknown> {
    return { id: options.id ?? config.tabMailAddonID, active: true, userDisabled: options.userDisabled ?? false, appDisabled: options.appDisabled ?? false };
  },

  /** A Thunderbird data folder in a new temporary directory: a `profiles.ini` listing one relative
   * profile per element of `profiles`, each with those add-ons in its `extensions.json`. */
  thunderbirdFolder(profiles: Record<string, unknown>[][]): string {
    const folder = mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"));
    let ini = "[General]\nStartWithLastProfile=1\n";
    profiles.forEach((addons, index) => {
      const path = `Profiles/test.profile-${index}`;
      ini += `\n[Profile${index}]\nName=profile-${index}\nIsRelative=1\nPath=${path}\n`;
      Fixtures.writeExtensions(addons, join(folder, path));
    });
    writeFileSync(join(folder, "profiles.ini"), ini);
    return folder;
  },

  writeExtensions(addons: Record<string, unknown>[], profile: string): void {
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "extensions.json"), JSON.stringify({ schemaVersion: 36, addons }));
  },
};


export function signedIn(auth = new StubTransport(), session: TabMailSession | null = Fixtures.session()): AccountModel {
  return new AccountModel(new AuthClient(auth.transport, "https://auth.example.com", "publishable-key"), new InMemorySessionStore(session));
}

/** The `log.content` entries logged while `body` runs (ADR-DESK-015). */
export async function loggedContent(body: () => Promise<void> | void): Promise<{ label: string; text: string }[]> {
  const entries: { label: string; text: string }[] = [];
  const stop = observeContent((label, text) => entries.push({ label, text }));
  try {
    await body();
  } finally {
    stop();
  }
  return entries;
}

/** Polls `condition` until it holds, for up to five seconds. */
export async function eventually(condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

/** A promise and the function that resolves it. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** `seconds` of a sine at `amplitude`, as the audio window delivers it (16 kHz mono floats). */
export function tone(seconds: number, amplitude = 0.5, sampleRate = config.recordingSampleRate): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let frame = 0; frame < samples.length; frame += 1) samples[frame] = amplitude * Math.sin((2 * Math.PI * 440 * frame) / sampleRate);
  return samples;
}

/** A microphone that logs each start and stop, in order, and records nothing or (`hears`) a tenth
 * of a second of tone as it starts, or later (`hear`). It can fail to start after the fact, as a real one reports it,
 * or be lost once started (its helper exited). */
export class CountingCapture implements AudioCapture {
  readonly events: string[] = [];
  private completion: ((error: Error | null) => void) | undefined;
  private readonly onLosts: ((() => void) | undefined)[] = [];
  private onChunk: ((samples: Float32Array) => void) | undefined;

  constructor(private readonly hears = false) {}

  get starts(): number {
    return this.events.filter((event) => event === "start").length;
  }

  get stops(): number {
    return this.events.filter((event) => event === "stop").length;
  }

  prepare(): void {}

  start(onChunk: (samples: Float32Array) => void, completion: (error: Error | null) => void, onLost: () => void): void {
    this.events.push("start");
    this.completion = completion;
    this.onLosts.push(onLost);
    this.onChunk = onChunk;
    if (this.hears) onChunk(tone(0.1));
  }

  /** The last start's microphone hears a tone. */
  hear(): void {
    this.onChunk?.(tone(0.1));
  }

  stop(): void {
    this.events.push("stop");
  }

  /** The last start's completion, with an error. */
  fail(): void {
    this.completion?.(new Error("unavailable"));
  }

  /** The microphone of the `start`th start (by default the last) stopped by itself. */
  lose(start = this.onLosts.length): void {
    this.onLosts[start - 1]?.();
  }
}

/** Records each script run and answers with `result`, or fails with `failure`. */
export class FakeScriptRunner implements ScriptRunner {
  result = "";
  failure: Error | null = null;
  readonly runs: { source: string; args: readonly string[]; signal: AbortSignal }[] = [];

  async run(source: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    this.runs.push({ source, args, signal });
    if (this.failure) throw this.failure;
    return this.result;
  }
}
