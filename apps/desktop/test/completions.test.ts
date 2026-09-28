// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { BackendError, CompletionsClient, type CompletionsMessage } from "../src/core/backend.js";
import * as config from "../src/core/config.js";
import { Fixtures, StubTransport } from "./support.js";

const baseURL = "https://api.example.com";
const message: CompletionsMessage = { role: "system", content: "system_prompt_example", vars: { dictation: "hello world", app_name: "Example" } };

function makeClient(stub: StubTransport): CompletionsClient {
  return new CompletionsClient(baseURL, "test-version", stub.transport, () => "Europe/Example");
}

async function backendError(promise: Promise<unknown>): Promise<BackendError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BackendError) return error;
    throw error;
  }
  throw new Error("expected a BackendError");
}

describe("CompletionsClient", () => {
  test("sends the named prompt with its variables", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.completionsStream(`{"assistant":"Hello, world.","thinking":"","token_usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}`));

    const earliest = Date.now();
    const reply = await makeClient(stub).complete(message, "token-abc");
    const latest = Date.now();

    expect(reply).toBe("Hello, world.");
    const request = stub.requests[0];
    expect(request?.url).toBe("https://api.example.com/completions/chat");
    expect(request?.method).toBe("POST");
    expect(request?.timeout).toBe(config.completionsRequestTimeout);
    expect(request?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer token-abc",
      "X-Client-Type": "macos",
      "X-Client-Version": "test-version",
    });
    const body = stub.body(0);
    expect(body.disable_tools).toBe(true);
    expect(body.client_timezone).toBe("Europe/Example");
    expect(body.client_timestamp_ms).toBeGreaterThanOrEqual(earliest);
    expect(body.client_timestamp_ms).toBeLessThanOrEqual(latest);
    // Variables sit beside role and content, not nested: the backend reads them from there.
    expect(body.messages).toEqual([{ role: "system", content: "system_prompt_example", dictation: "hello world", app_name: "Example" }]);
  });

  test("the time zone is the system's by default", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.reply("Hello."));
    await new CompletionsClient(baseURL, "v", stub.transport).complete(message, "t");
    expect(stub.body(0).client_timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  /** A later keepalive must not hide an earlier stream error. */
  test("a stream error fails", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, ': primer\n\nevent: keepalive\ndata: {}\n\nevent: error\ndata: {"error":"internal_error"}\n\nevent: keepalive\ndata: {}\n\n');
    const error = await backendError(makeClient(stub).complete(message, "t"));
    expect([error.kind, error.status]).toEqual(["failed", 200]);
  });

  /** The backend reports a refused request (e.g. a prompt this client can't use) in `final`. */
  test("a final carrying an error fails", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.completionsStream(`{"error":"Requested prompt is not available for this client platform."}`));
    const error = await backendError(makeClient(stub).complete(message, "t"));
    expect([error.kind, error.status]).toEqual(["failed", 200]);
  });

  test("a stream without final is invalid", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, ": primer\n\nevent: keepalive\ndata: {}\n\n");
    expect((await backendError(makeClient(stub).complete(message, "t"))).kind).toBe("invalidResponse");
  });

  test.each([
    [401, "invalid_token", "unauthorized", undefined],
    [402, "no_active_subscription", "subscriptionRequired", undefined],
    [403, "consent_required", "accountSetupRequired", undefined],
    [403, "access_denied", "accessDenied", undefined],
    [429, "rate_limited", "rateLimited", undefined],
    [500, "internal_error", "failed", 500],
  ])("maps HTTP %i %s", async (status, code, kind, failedStatus) => {
    const stub = new StubTransport();
    stub.enqueue(status, { error: code });
    const error = await backendError(makeClient(stub).complete(message, "t"));
    expect([error.kind, error.status]).toEqual([kind, failedStatus]);
  });

  /** A proxy's plain-text error, or a JSON body without a code, still reports the HTTP failure. */
  test.each([
    [502, "upstream unavailable", "failed", 502],
    [403, "{}", "accessDenied", undefined],
  ])("an HTTP %i without an error code keeps its status", async (status, body, kind, failedStatus) => {
    const stub = new StubTransport();
    stub.enqueue(status, body);
    const error = await backendError(makeClient(stub).complete(message, "t"));
    expect([error.kind, error.status]).toEqual([kind, failedStatus]);
  });

  /** Selecting a result must filter by event name and use the last final payload. */
  test("uses the last final even when other events follow", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, `${Fixtures.completionsStream(`{"assistant":"Earlier."}`)}event: final\ndata: {"assistant":"Latest."}\n\nevent: keepalive\ndata: {}\n\n`);
    expect(await makeClient(stub).complete(message, "t")).toBe("Latest.");
  });

  /** A final event exists, but malformed JSON, a wrong field type or a missing reply cannot succeed. */
  test.each([
    ["{", "invalidResponse", undefined],
    [`{"assistant":42}`, "invalidResponse", undefined],
    ["{}", "failed", 200],
  ])("a final of %s fails", async (payload, kind, failedStatus) => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.completionsStream(payload));
    const error = await backendError(makeClient(stub).complete(message, "t"));
    expect([error.kind, error.status]).toEqual([kind, failedStatus]);
  });

  /** The backend's `JSON.stringify` leaves these unescaped; they are part of the reply, not line ends. */
  test.each(["\u0085", " ", " "])("keeps U+%s in the reply", async (separator) => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.completionsStream(`{"assistant":"Alpha${separator}beta"}`));
    expect(await makeClient(stub).complete(message, "t")).toBe(`Alpha${separator}beta`);
  });
});

describe("server-sent events", () => {
  test("events end at blank lines and skip comments", () => {
    const events = CompletionsClient.events(': primer\n\nevent: keepalive\n: comment inside the event\ndata: {}\n\ndata: outside an event\n\nevent: final\ndata: {"a":1}\n\n');
    expect(events).toEqual([{ name: "keepalive", data: "{}" }, { name: "final", data: '{"a":1}' }]);
  });

  /** Consecutive events without a blank line between them, and a last event without a trailing one. */
  test("events also end at the next event and at the end", () => {
    const events = CompletionsClient.events("event: \tkeepalive\t\ndata: first\nevent: final\ndata: last");
    expect(events).toEqual([{ name: "keepalive", data: "first" }, { name: "final", data: "last" }]);
  });

  test.each(["\n", "\r\n", "\r"])("events join data lines at every line end (%j)", (lineEnd) => {
    const body = ["event: final", "data: first", "data: second third", "", ""].join(lineEnd);
    expect(CompletionsClient.events(body)).toEqual([{ name: "final", data: "first\nsecond third" }]);
  });
});
