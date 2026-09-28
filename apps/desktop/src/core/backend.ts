// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "./config.js";
import type { HTTPRequest, HTTPResponse, HTTPTransport } from "./http.js";
import { log } from "./log.js";
import { base64, charCount } from "./text.js";

export type BackendErrorKind =
  | "unauthorized"
  | "subscriptionRequired"
  | "accountSetupRequired"
  | "accessDenied"
  | "rateLimited"
  | "recordingTooLong"
  | "failed"
  | "invalidResponse";

const messages: Record<BackendErrorKind, string> = {
  unauthorized: "Your TabMail session has ended. Sign in again in Settings.",
  subscriptionRequired: "Dictation needs an active TabMail subscription.",
  accountSetupRequired: "Finish setting up your TabMail account at tabmail.ai.",
  accessDenied: "This account can't use this TabMail server.",
  rateLimited: "Too many dictations right now. Try again in a moment.",
  recordingTooLong: "That recording was too long to transcribe.",
  failed: "Dictation failed. Please try again.",
  invalidResponse: "TabMail returned an unexpected response.",
};

/** A failed TabMail backend call; its message is what the overlay shows for it. */
export class BackendError extends Error {
  constructor(
    readonly kind: BackendErrorKind,
    /** For `failed`: the HTTP status. */
    readonly status?: number,
  ) {
    super(messages[kind]);
    this.name = "BackendError";
  }

  /** From an HTTP error status and the `error` code of its JSON body. */
  static fromStatus(status: number, code: string | undefined): BackendError {
    if (status === 401) return new BackendError("unauthorized");
    if (status === 402) return new BackendError("subscriptionRequired");
    if (status === 403) return new BackendError(code === "consent_required" ? "accountSetupRequired" : "accessDenied");
    if (status === 429) return new BackendError("rateLimited");
    if (status === 400 && code === "audio_too_large") return new BackendError("recordingTooLong");
    return new BackendError("failed", status);
  }

  /** For the log: the case, never user content. */
  get description(): string {
    return this.kind === "failed" ? `BackendError.failed(status: ${this.status})` : `BackendError.${this.kind}`;
  }
}

/** The `error` code of an HTTP error's JSON body. */
function errorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // A proxy's plain-text error: no code.
  }
  return undefined;
}

/** How a request to the backend and its reply read in the debug log file (`log.content`,
 * ADR-DESK-015): everything as sent and as received, except the access token. */
export const BackendLog = {
  /** Stands in for the access token in a logged `Authorization` header. */
  maskedAuthorization: "Bearer <access token, not logged>",

  /** The request as sent: method, URL, headers (the access token masked) and `body`, else the
   * request's own body. */
  request(request: HTTPRequest, body?: string): string {
    const headers = Object.entries(request.headers).map(([name, value]): [string, string] => [
      name,
      name.toLowerCase() === "authorization" ? BackendLog.maskedAuthorization : value,
    ]);
    return `${request.method} ${request.url}\n${lines(headers)}\n\n${body ?? request.body}`;
  },

  /** The reply as received: status, headers (Cloudflare's `cf-ray` finds the request in the
   * backend's logs) and the raw body. */
  response(response: HTTPResponse): string {
    return `HTTP ${response.status}\n${lines(Object.entries(response.headers))}\n\n${response.body}`;
  },
};

function lines(headers: [string, string][]): string {
  return [...headers]
    .sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : a[0].toLowerCase() > b[0].toLowerCase() ? 1 : 0))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/** A message naming a backend prompt: `content` is the prompt's name and `vars` its template
 * variables, flattened into top-level JSON keys beside `role` and `content` (as on iOS). */
export interface CompletionsMessage {
  role: string;
  content: string;
  vars: Record<string, string>;
}

/** A tool the model called that the app runs (the backend runs its own server tools). */
export interface ToolCall {
  id: string;
  function: {
    name: string;
    /** The arguments, as a JSON object in a string. */
    arguments: string;
  };
}

function isToolCall(value: unknown): value is ToolCall {
  if (!value || typeof value !== "object") return false;
  const { id, function: called } = value as { id?: unknown; function?: unknown };
  if (typeof id !== "string" || !called || typeof called !== "object") return false;
  const { name, arguments: args } = called as { name?: unknown; arguments?: unknown };
  return typeof name === "string" && typeof args === "string";
}

/** One round of the backend's tool loop: the reply, or the tools the app is to run before the next
 * round, and the loop's state (opaque JSON) to send back with their results. */
export type Round = { kind: "reply"; text: string } | { kind: "toolCalls"; calls: ToolCall[]; state: unknown };

/** One server-sent event. */
export interface SSEEvent {
  name: string;
  data: string;
}

function headers(accessToken: string, clientVersion: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "X-Client-Type": config.clientType,
    "X-Client-Version": clientVersion,
  };
}

function joinURL(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path}`;
}

/** Calls the TabMail backend's `POST /completions/chat` with one named prompt and returns the
 * model's reply. The backend answers with server-sent events (keepalives while the model works,
 * then `final`, or `error`); the whole stream is read, then parsed. */
export class CompletionsClient {
  constructor(
    readonly baseURL: string,
    readonly clientVersion: string,
    private readonly transport: HTTPTransport,
    /** The time zone the request says the user is in. */
    private readonly timeZone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {}

  /** `availableTools`: the agent tools the backend may offer this request (`available_tools`), for
   * the agent's choice; left out of the body for every other prompt. A prompt that calls no tools. */
  async complete(message: CompletionsMessage, accessToken: string, signal?: AbortSignal, availableTools?: readonly string[]): Promise<string> {
    const { reply, status } = await this.send(message, accessToken, signal, {
      disable_tools: true,
      ...(availableTools === undefined ? {} : { available_tools: availableTools }),
    });
    if (typeof reply.assistant !== "string") throw new BackendError("failed", status);
    return reply.assistant;
  }

  /** One round of a prompt that may call the `tools` named (`available_tools`, tools on): the loop's
   * first round with `conversationState` undefined, else the next one with the state the last round
   * returned and the tools' results added. */
  async round(message: CompletionsMessage, tools: readonly string[], conversationState: unknown, accessToken: string, signal?: AbortSignal): Promise<Round> {
    const { reply, status } = await this.send(message, accessToken, signal, {
      disable_tools: false,
      available_tools: tools,
      ...(conversationState === undefined ? {} : { conversation_state: conversationState }),
    });
    const calls = reply.tool_calls;
    if (calls !== undefined && calls !== null) {
      if (!Array.isArray(calls) || !calls.every(isToolCall)) throw new BackendError("invalidResponse");
      if (calls.length > 0) {
        if (reply.conversation_state === undefined || reply.conversation_state === null) throw new BackendError("invalidResponse");
        return { kind: "toolCalls", calls, state: reply.conversation_state };
      }
    }
    if (typeof reply.assistant !== "string") throw new BackendError("failed", status);
    return { kind: "reply", text: reply.assistant };
  }

  /** Sends `message` with the request's other `fields`, and returns the stream's `final` payload,
   * which carries no error, and the HTTP status. */
  private async send(
    message: CompletionsMessage,
    accessToken: string,
    signal: AbortSignal | undefined,
    fields: Record<string, unknown>,
  ): Promise<{ reply: Record<string, unknown>; status: number }> {
    const request: HTTPRequest = {
      method: "POST",
      url: joinURL(this.baseURL, config.completionsPath),
      timeout: config.completionsRequestTimeout,
      headers: headers(accessToken, this.clientVersion),
      body: JSON.stringify({
        messages: [{ role: message.role, content: message.content, ...message.vars }],
        client_timestamp_ms: Date.now(),
        client_timezone: this.timeZone(),
        ...fields,
      }),
      signal,
    };
    log.content(`Completions ${message.content} request`, () => BackendLog.request(request));
    log.content(`Completions ${message.content} variables`, () => CompletionsClient.describe(message));
    const response = await this.transport(request);
    log.content(`Completions ${message.content} response`, () => BackendLog.response(response));
    if (response.status !== 200) throw BackendError.fromStatus(response.status, errorCode(response.body));
    const events = CompletionsClient.events(response.body);
    if (events.some((event) => event.name === "error")) throw new BackendError("failed", response.status);
    const final = events.findLast((event) => event.name === "final");
    if (!final) throw new BackendError("invalidResponse");
    let reply: unknown;
    try {
      reply = JSON.parse(final.data);
    } catch {
      throw new BackendError("invalidResponse");
    }
    if (!reply || typeof reply !== "object") throw new BackendError("invalidResponse");
    const fieldsOf = reply as Record<string, unknown>;
    const { assistant, error } = fieldsOf;
    if ((assistant !== undefined && assistant !== null && typeof assistant !== "string") || (error !== undefined && error !== null && typeof error !== "string")) {
      throw new BackendError("invalidResponse");
    }
    if (error !== undefined && error !== null) throw new BackendError("failed", response.status);
    return { reply: fieldsOf, status: response.status };
  }

  /** The prompt's variables one after another, each whole under its name, for the log: the request
   * body carries them as escaped JSON strings, which hides the line breaks of a screen read. */
  static describe(message: CompletionsMessage): string {
    return [
      `prompt ${message.content} (role ${message.role})`,
      ...Object.keys(message.vars)
        .sort()
        .map((key) => `--- ${key} (${charCount(message.vars[key] ?? "")} chars) ---\n${message.vars[key] ?? ""}`),
    ].join("\n");
  }

  /** Splits a server-sent-events body into events, as iOS `BackendClient.parseSSELines` does: an
   * event ends at a blank line, at the next `event:` line or at the end of the body, and `:` lines
   * (the backend's buffer primer) are comments. Lines end at CR, LF or CRLF only: U+0085, U+2028 and
   * U+2029 are text, and the backend's JSON carries them unescaped. */
  static events(body: string): SSEEvent[] {
    const events: SSEEvent[] = [];
    let name: string | undefined;
    let dataLines: string[] = [];
    const flush = () => {
      if (name !== undefined) events.push({ name, data: dataLines.join("\n") });
      name = undefined;
      dataLines = [];
    };
    for (const line of body.split(/\r\n|\r|\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event: ")) {
        flush();
        name = line.slice(7).replace(/^[ \t]+|[ \t]+$/g, "");
      } else if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      } else if (line === "") {
        flush();
      }
    }
    flush();
    return events;
  }
}

/** Calls the TabMail backend's `POST /dictation/transcribe` (OpenRouter STT behind it). */
export class TranscriptionClient {
  constructor(
    readonly baseURL: string,
    readonly clientVersion: string,
    private readonly transport: HTTPTransport,
  ) {}

  /** `language`: the keyboard's at key-down, which picks the backend's model; null sends none (the
   * default model). */
  async transcribe(wav: Uint8Array, language: string | null, accessToken: string, signal?: AbortSignal): Promise<string> {
    const request: HTTPRequest = {
      method: "POST",
      url: joinURL(this.baseURL, config.transcribePath),
      timeout: config.transcriptionRequestTimeout,
      headers: headers(accessToken, this.clientVersion),
      body: JSON.stringify(TranscriptionClient.body(base64(wav), language)),
      signal,
    };
    log.content("Transcription request", () => BackendLog.request(request, TranscriptionClient.loggedBody(wav.length, language)));
    const response = await this.transport(request);
    log.content("Transcription response", () => BackendLog.response(response));
    if (response.status !== 200) throw BackendError.fromStatus(response.status, errorCode(response.body));
    let result: unknown;
    try {
      result = JSON.parse(response.body);
    } catch {
      throw new BackendError("invalidResponse");
    }
    if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string") {
      throw new BackendError("invalidResponse");
    }
    return result.text;
  }

  /** The request body as the log shows it: the audio's size in its place, never the audio. */
  static loggedBody(wavBytes: number, language: string | null): string {
    return JSON.stringify(TranscriptionClient.body(`<${wavBytes} bytes of WAV, not logged>`, language));
  }

  /** `language` is left out when null. */
  private static body(audio: string, language: string | null): Record<string, string> {
    return language === null ? { audio, format: "wav" } : { audio, format: "wav", language };
  }
}
