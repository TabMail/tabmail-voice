// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { type HTTPRequest, liveTransport, TransportError } from "../src/core/http.js";
import { sleep } from "../src/core/timeout.js";

/** `liveTransport` against a server on the loopback interface: never the network. */
describe("liveTransport", () => {
  let server: Server | undefined;
  /** The bodies the server received, in full. */
  let received: string[];

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    server = undefined;
  });

  /** A loopback server answering each request with `answer`; returns its URL. */
  async function serve(answer: (response: ServerResponse) => void): Promise<string> {
    received = [];
    server = createServer((request: IncomingMessage, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        received.push(body);
        answer(response);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  function post(url: string, options: { timeout?: number; signal?: AbortSignal } = {}): HTTPRequest {
    return { method: "POST", url, headers: {}, body: "recording", timeout: options.timeout ?? 5_000, signal: options.signal };
  }

  async function failure(request: Promise<unknown>): Promise<string | null> {
    try {
      await request;
      return null;
    } catch (error) {
      return error instanceof TransportError ? error.reason : String(error);
    }
  }

  test("answers with the status, headers and whole body", async () => {
    const url = await serve((response) => {
      response.writeHead(201, { "x-example": "yes" });
      response.end("done");
    });

    const response = await liveTransport(post(url));

    expect([response.status, response.headers["x-example"], response.body]).toEqual([201, "yes", "done"]);
    expect(received).toEqual(["recording"]);
  });

  /** A request whose dictation was cancelled before it went out (during a token refresh): nothing
   * is sent. */
  test("a request already cancelled sends nothing", async () => {
    const url = await serve((response) => response.end("done"));
    const controller = new AbortController();
    controller.abort();

    expect(await failure(liveTransport(post(url, { signal: controller.signal })))).toBe("cancelled");
    await sleep(100);
    expect(received).toEqual([]);
  });

  test("a request cancelled while it waits is cancelled at once", async () => {
    const url = await serve(() => {});
    const controller = new AbortController();
    const request = liveTransport(post(url, { signal: controller.signal }));
    await sleep(100);
    controller.abort();

    expect(await failure(request)).toBe("cancelled");
    expect(received).toEqual(["recording"]);
  });

  test("a server silent for the timeout times out", async () => {
    const url = await serve((response) => {
      response.writeHead(200);
      response.write("started");
    });

    expect(await failure(liveTransport(post(url, { timeout: 200 })))).toBe("timeout");
  });

  /** A streamed reply reaches `onChunk` a piece at a time as it arrives, before the whole body is
   * returned (the server waits to hear the first piece was heard); a character split across two
   * pieces arrives whole, and the pieces add up to the body. */
  test("a streamed reply's pieces are heard as they arrive", async () => {
    let firstHeard: () => void = () => {};
    const heardFirst = new Promise<void>((resolve) => (firstHeard = resolve));
    const url = await serve(async (response) => {
      response.writeHead(200);
      response.write("event: tool_started\n\n");
      await Promise.race([heardFirst, sleep(2_000)]);
      const accent = Buffer.from("é");
      response.write(accent.subarray(0, 1));
      await sleep(50);
      response.write(accent.subarray(1));
      response.end(" done");
    });
    const heard: string[] = [];

    const response = await liveTransport({
      ...post(url),
      onChunk: (text) => {
        heard.push(text);
        firstHeard();
      },
    });

    // Alone: the server sent nothing more until it was heard.
    expect(heard[0]).toBe("event: tool_started\n\n");
    expect(heard.join("")).toBe(response.body);
    expect(response.body).toBe("event: tool_started\n\né done");
    expect(heard.every((piece) => piece !== "" && !piece.includes("\uFFFD"))).toBe(true);
  });

  /** The timeout is for silence: a stream that keeps sending runs past it. */
  test("a stream that keeps sending outlasts the timeout", async () => {
    const url = await serve(async (response) => {
      response.writeHead(200);
      for (let beat = 0; beat < 5; beat += 1) {
        response.write("keepalive ");
        await sleep(100);
      }
      response.end("final");
    });

    const response = await liveTransport(post(url, { timeout: 300 }));

    expect(response.body).toBe("keepalive keepalive keepalive keepalive keepalive final");
  });

  test("a server that can't be reached is a network failure", async () => {
    const url = await serve(() => {});
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;

    expect(await failure(liveTransport(post(url)))).toBe("network");
  });
});
