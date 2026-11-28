// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";

/** One HTTP request as the backend clients build it. `timeout` is the longest the connection may
 * stay silent (a streamed reply's keepalives count), in milliseconds. */
export interface HTTPRequest {
  method: "POST" | "GET";
  url: string;
  headers: Record<string, string>;
  body: string;
  timeout: number;
  signal?: AbortSignal;
  /** Called with each piece of the body as it arrives (a streamed reply's events), before the whole
   * body is returned. */
  onChunk?: (text: string) => void;
}

export interface HTTPResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** HTTP transport, injectable so tests never touch the network. */
export type HTTPTransport = (request: HTTPRequest) => Promise<HTTPResponse>;

/** A request that timed out or failed to connect: no HTTP status. */
export class TransportError extends Error {
  constructor(readonly reason: "timeout" | "network" | "canceled") {
    super(
      reason === "timeout" ? "TabMail took too long to answer. Try again."
        : reason === "network" ? "Couldn't reach TabMail. Check your internet connection."
          : "Canceled.",
    );
    this.name = "TransportError";
  }

  /** For the log. */
  get description(): string {
    return `TransportError.${this.reason}`;
  }
}

/** A request to AI refused because AI features are off (`aiGatedTransport`); its message is the line
 * that says why, as a hold refused at its start shows it. Not a network failure: never tried again. */
export class AIOffError extends Error {
  constructor(line: string) {
    super(`${line}.`);
    this.name = "AIOffError";
  }
}

/** `transport` for the requests that reach AI (transcription, its warm-up, completions): each is
 * refused while `settings.aiOffLine` says AI features are off, asked as the request goes out, not
 * when its operation started. Opt Out of AI withdraws consent, so it is the one setting that applies
 * at every request (the AI-consent exception to the snapshot rule, as on iOS and in Thunderbird): an
 * operation under way stops at its next request, and a request already sent is not recalled. */
export function aiGatedTransport(transport: HTTPTransport, settings: { readonly aiOffLine: string | null }): HTTPTransport {
  return (request) => {
    const line = settings.aiOffLine;
    return line === null ? transport(request) : Promise.reject(new AIOffError(line));
  };
}

/** The real network, through fetch. The body is read as it arrives, and the request is abandoned
 * when nothing has arrived for `timeout`. Every request goes to TabMail's own servers (the backend,
 * sign-in), which never answer with a redirect, and most carry the access token or the refresh token:
 * a redirect is not followed, and fails as a network error, so nothing a request carries goes to
 * another address. */
export const liveTransport: HTTPTransport = async (request) => {
  // Canceled before it went out (during a token refresh): an abort listener added now would never
  // fire, so nothing would stop the upload.
  if (request.signal?.aborted) throw new TransportError("canceled");
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeout);
  };
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  arm();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? undefined : request.body,
      signal: controller.signal,
      redirect: "error",
    });
    const decoder = new TextDecoder();
    let body = "";
    if (response.body) {
      for await (const chunk of response.body) {
        arm();
        const text = decoder.decode(chunk, { stream: true });
        body += text;
        if (text !== "") request.onChunk?.(text);
      }
    }
    const rest = decoder.decode();
    body += rest;
    if (rest !== "") request.onChunk?.(rest);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return { status: response.status, headers, body };
  } catch (error) {
    if (timedOut) throw new TransportError("timeout");
    if (request.signal?.aborted) throw new TransportError("canceled");
    throw error instanceof TransportError ? error : new TransportError("network");
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
};

/** The headers of an authorized request to the backend. */
export function requestHeaders(accessToken: string, clientVersion: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "X-Client-Type": config.clientType,
    "X-Client-Version": clientVersion,
    "X-Client-Protocol": config.clientProtocol,
  };
}

/** `path` under `base`, with one slash between them. */
export function joinURL(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path}`;
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
