// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** One HTTP request as the backend clients build it. `timeout` is the longest the connection may
 * stay silent (a streamed reply's keepalives count), in milliseconds. */
export interface HTTPRequest {
  method: "POST" | "GET";
  url: string;
  headers: Record<string, string>;
  body: string;
  timeout: number;
  signal?: AbortSignal;
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
  constructor(readonly reason: "timeout" | "network" | "cancelled") {
    super(
      reason === "timeout" ? "TabMail took too long to answer. Try again."
        : reason === "network" ? "Couldn't reach TabMail. Check your internet connection."
          : "Cancelled.",
    );
    this.name = "TransportError";
  }

  /** For the log. */
  get description(): string {
    return `TransportError.${this.reason}`;
  }
}

/** The real network, through fetch. The body is read as it arrives, and the request is abandoned
 * when nothing has arrived for `timeout`. */
export const liveTransport: HTTPTransport = async (request) => {
  // Cancelled before it went out (during a token refresh): an abort listener added now would never
  // fire, so nothing would stop the upload.
  if (request.signal?.aborted) throw new TransportError("cancelled");
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
    });
    const decoder = new TextDecoder();
    let body = "";
    if (response.body) {
      for await (const chunk of response.body) {
        arm();
        body += decoder.decode(chunk, { stream: true });
      }
    }
    body += decoder.decode();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return { status: response.status, headers, body };
  } catch (error) {
    if (timedOut) throw new TransportError("timeout");
    if (request.signal?.aborted) throw new TransportError("cancelled");
    throw error instanceof TransportError ? error : new TransportError("network");
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
};
