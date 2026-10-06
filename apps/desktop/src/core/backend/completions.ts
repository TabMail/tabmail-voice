// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.


import * as config from "../config.js";
import { BackendError, errorCode } from "./errors.js";
import { BackendLog, type HTTPRequest, type HTTPTransport, joinURL, requestHeaders } from "./http.js";
import { elapsed, log } from "../log.js";
import { charCount } from "../util/text.js";

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

/** A backend tool (`search_web`, the date tools) started or ended within a round: it runs on the
 * backend, which says so in the stream as it goes (`tool_started`, then `tool_completed` or
 * `tool_failed`). `label` is what it is doing ("Searching the web: …"). */
export interface ServerToolEvent {
  tool: string;
  running: boolean;
  label: string | null;
}

/** The server tool `event` is about; null for any other event, or one without the tool's name (a
 * backend from before it named the tool in every build). */
function serverToolEvent(event: SSEEvent): ServerToolEvent | null {
  if (event.name !== "tool_started" && event.name !== "tool_completed" && event.name !== "tool_failed") return null;
  let data: unknown;
  try {
    data = JSON.parse(event.data);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { tool_name: tool, display_label: label } = data as Record<string, unknown>;
  if (typeof tool !== "string") return null;
  return { tool, running: event.name === "tool_started", label: typeof label === "string" ? label : null };
}

/** One server-sent event. */
export interface SSEEvent {
  name: string;
  data: string;
}

/** Calls the TabMail backend's `POST /completions/chat` with one named prompt and returns the
 * model's reply. The backend answers with server-sent events (keepalives while the model works,
 * then `final`, or `error`); the whole stream is read, then parsed, a tool loop's round also hearing
 * of the backend's own tools as they run. */
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
   * returned and the tools' results added. `onServerTool` hears of each backend tool as it starts and
   * ends, while the round runs. */
  async round(
    message: CompletionsMessage,
    tools: readonly string[],
    conversationState: unknown,
    accessToken: string,
    signal?: AbortSignal,
    onServerTool?: (event: ServerToolEvent) => void,
  ): Promise<Round> {
    const onEvent =
      onServerTool &&
      ((event: SSEEvent) => {
        const tool = serverToolEvent(event);
        if (tool) onServerTool(tool);
      });
    const { reply, status } = await this.send(message, accessToken, signal, {
      disable_tools: false,
      available_tools: tools,
      // The backend refuses web search, and `web_read` and `web_open`, unless this says so.
      web_search_enabled: tools.includes(config.webSearchTool),
      ...(conversationState === undefined ? {} : { conversation_state: conversationState }),
    }, onEvent);
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
   * which carries no error, and the HTTP status. `onEvent` hears each event as it arrives. */
  private async send(
    message: CompletionsMessage,
    accessToken: string,
    signal: AbortSignal | undefined,
    fields: Record<string, unknown>,
    onEvent?: (event: SSEEvent) => void,
  ): Promise<{ reply: Record<string, unknown>; status: number }> {
    const parser = new SSEParser();
    const request: HTTPRequest = {
      method: "POST",
      url: joinURL(this.baseURL, config.completionsPath),
      timeout: config.completionsRequestTimeout,
      headers: requestHeaders(accessToken, this.clientVersion),
      body: JSON.stringify({
        messages: [{ role: message.role, content: message.content, ...message.vars }],
        client_timestamp_ms: Date.now(),
        client_timezone: this.timeZone(),
        ...fields,
      }),
      signal,
      ...(onEvent ? { onChunk: (text: string) => parser.push(text).forEach(onEvent) } : {}),
    };
    log.content(`Completions ${message.content} request`, () => BackendLog.request(request));
    log.content(`Completions ${message.content} variables`, () => CompletionsClient.describe(message));
    const sent = performance.now();
    const response = await this.transport(request);
    log.debug(() => `Completions: HTTP ${response.status} in ${elapsed(sent)}`);
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

  /** Splits a server-sent-events body into events (`SSEParser`). */
  static events(body: string): SSEEvent[] {
    const parser = new SSEParser();
    return [...parser.push(body), ...parser.end()];
  }
}

/**
 * Splits a server-sent-events body into events as it arrives, as iOS `BackendClient.parseSSELines`
 * does: an event ends at a blank line, at the next `event:` line or at the end of the body, and `:`
 * lines (the backend's buffer primer) are comments. Lines end at CR, LF or CRLF only: U+0085, U+2028
 * and U+2029 are text, and the backend's JSON carries them unescaped. `push` each piece of the body,
 * then `end`; a piece may end anywhere, even between a CRLF's two characters.
 */
export class SSEParser {
  /** Text after the last complete line. */
  private pending = "";
  private name: string | undefined;
  private dataLines: string[] = [];

  /** The events `text` completes. */
  push(text: string): SSEEvent[] {
    this.pending += text;
    // A CR at the end may be a CRLF's first half: its line ends with the next piece.
    const complete = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
    const lines: string[] = [];
    let start = 0;
    for (const lineEnd of complete.matchAll(/\r\n|\r|\n/g)) {
      lines.push(complete.slice(start, lineEnd.index));
      start = lineEnd.index + lineEnd[0].length;
    }
    this.pending = this.pending.slice(start);
    return this.read(lines);
  }

  /** The events the body's end completes. */
  end(): SSEEvent[] {
    const rest = this.pending;
    this.pending = "";
    const events = this.read(rest === "" ? [] : rest.split(/\r\n|\r|\n/));
    this.flush(events);
    return events;
  }

  private read(lines: readonly string[]): SSEEvent[] {
    const events: SSEEvent[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event: ")) {
        this.flush(events);
        this.name = line.slice(7).replace(/^[ \t]+|[ \t]+$/g, "");
      } else if (line.startsWith("data: ")) {
        this.dataLines.push(line.slice(6));
      } else if (line === "") {
        this.flush(events);
      }
    }
    return events;
  }

  private flush(events: SSEEvent[]): void {
    if (this.name !== undefined) events.push({ name: this.name, data: this.dataLines.join("\n") });
    this.name = undefined;
    this.dataLines = [];
  }
}
