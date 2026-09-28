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
    // Only the agent's choice names the tools it may pick.
    expect(body).not.toHaveProperty("available_tools");
  });

  /** The agent's choice lists the tools on offer beside the messages, for the backend to choose
   * among. */
  test("sends the tools on offer", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.reply("answer"));

    await makeClient(stub).complete(message, "token-abc", undefined, ["compose", "answer"]);

    expect(stub.body(0).available_tools).toEqual(["compose", "answer"]);
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

describe("a tool-loop round", () => {
  const tools = ["date_to_day", "time_delta", "example_read"];

  /** A tool-loop round asks with tools on, offering the tools named; the first round sends no state. */
  test("a round offers its tools with tools on", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.reply("Friday is the 3rd."));

    expect(await makeClient(stub).round(message, tools, undefined, "token-abc")).toEqual({ kind: "reply", text: "Friday is the 3rd." });

    const body = stub.body(0);
    expect(body.disable_tools).toBe(false);
    expect(body.available_tools).toEqual(tools);
    expect(body).not.toHaveProperty("conversation_state");
    expect(body.messages).toEqual([{ role: "system", content: "system_prompt_example", dictation: "hello world", app_name: "Example" }]);
    expect(stub.requests[0]?.headers.Authorization).toBe("Bearer token-abc");
  });

  /** A round that calls tools returns them and the loop's state; the next round sends that state back
   * as it came, every field the app doesn't read kept, nulls and fractions too. */
  test("a round returns its tool calls, and the next sends the state back", async () => {
    const state = { ...Fixtures.loopState(), nothing: null, ratio: 0.25, nested: { list: [1, "two", null, 3.5] } };
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.toolCalls([{ id: "call_1", name: "example_read", arguments: '{"day":"friday"}' }], state));
    stub.enqueue(200, Fixtures.reply("Done."));
    const client = makeClient(stub);

    const round = await client.round(message, tools, undefined, "t");
    expect(round).toEqual({ kind: "toolCalls", calls: [{ id: "call_1", type: "function", function: { name: "example_read", arguments: '{"day":"friday"}' } }], state });
    if (round.kind !== "toolCalls") return;

    await client.round(message, tools, round.state, "t");
    expect(stub.body(1).conversation_state).toEqual(state);
    expect(stub.body(1).disable_tools).toBe(false);
  });

  /** Tool calls without the loop's state can't be continued: the request fails. */
  test.each([undefined, null])("tool calls with the state %s fail", async (state) => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.completionsStream(JSON.stringify({ tool_calls: [{ id: "call_1", function: { name: "example_read", arguments: "{}" } }], conversation_state: state })));
    expect((await backendError(makeClient(stub).round(message, tools, undefined, "t"))).kind).toBe("invalidResponse");
  });

  /** Tool calls the app can't read (an id, name or arguments missing or not a string) fail. */
  test.each([
    `{"tool_calls":{"id":"call_1"}}`,
    `{"tool_calls":[{"function":{"name":"example_read","arguments":"{}"}}]}`,
    `{"tool_calls":[{"id":"call_1","function":{"name":7,"arguments":"{}"}}]}`,
    `{"tool_calls":[{"id":"call_1","function":{"name":"example_read","arguments":{}}}]}`,
    `{"tool_calls":[{"id":"call_1"}]}`,
    `{"tool_calls":[null]}`,
  ])("a round calling %s fails", async (payload) => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.completionsStream(payload.replace(/}$/, `,"conversation_state":{"harmony_messages":[]}}`)));
    expect((await backendError(makeClient(stub).round(message, tools, undefined, "t"))).kind).toBe("invalidResponse");
  });

  /** No tool calls: the reply is the round's, and without one it fails as a prompt without tools
   * does. */
  test.each([
    [`{"tool_calls":[],"assistant":"Done."}`, "Done."],
    [`{"tool_calls":null,"assistant":"Done."}`, "Done."],
  ])("a round with %s replies", async (payload, text) => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.completionsStream(payload));
    expect(await makeClient(stub).round(message, tools, undefined, "t")).toEqual({ kind: "reply", text });
  });

  test.each([`{}`, `{"tool_calls":[]}`])("a round of %s without a reply fails", async (payload) => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.completionsStream(payload));
    const error = await backendError(makeClient(stub).round(message, tools, undefined, "t"));
    expect([error.kind, error.status]).toEqual(["failed", 200]);
  });

  /** An error in `final`, even beside tool calls, fails the round. */
  test("a round carrying an error fails", async () => {
    const stub = new StubTransport();
    stub.enqueue(200, Fixtures.completionsStream(`{"error":"Tool loop limit reached.","tool_calls":[{"id":"call_1","function":{"name":"example_read","arguments":"{}"}}],"conversation_state":{}}`));
    const error = await backendError(makeClient(stub).round(message, tools, undefined, "t"));
    expect([error.kind, error.status]).toEqual(["failed", 200]);
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
