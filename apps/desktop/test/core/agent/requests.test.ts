// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DesktopAgent } from "../../../src/core/agent/requests.js";
import type { ConnectorTool } from "../../../src/core/agent/connectors/contract.js";
import { AgentError, type AgentToolID, agentToolIDs, agentTools, EditTool, redactionPlaceholder, screenHiddenNote, selectionUnreadNote } from "../../../src/core/agent/tools.js";
import { BackendError } from "../../../src/core/backend/errors.js";
import { CompletionsClient, type ServerToolEvent, type ToolCall } from "../../../src/core/backend/completions.js";
import { screen } from "../../support/screens.js";
import { Fixtures, signedIn, StubTransport } from "../../support/stubs.js";

const request = "make this friendlier";
const all = agentToolIDs;

function selectionScreen(selected: string) {
  return screen({
    appName: "Example Notes",
    windowTitle: "Weekly sync",
    host: "notes.example.com",
    terminalProgram: "example-shell",
    textBeforeCaret: "Note: ",
    selectedText: selected,
    renderedText: `## Agenda\n» Note: ‸${selected}‸`,
  });
}

function setup() {
  const completions = new StubTransport();
  const client = new CompletionsClient("https://api.example.com", "v", completions.transport);
  return { completions, client, account: signedIn() };
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The agent's backend prompt: what it is sent, and which tools it is offered. Never the network. */
describe("DesktopAgent", () => {
  /** Every variable the backend prompt renders is sent, empty when unknown: the backend leaves a
   * missing one in the prompt as written. */
  test("without a screen every variable is sent empty", () => {
    const message = DesktopAgent.message(request, null, false, "", "");
    expect(message.content).toBe("system_prompt_desktop_agent");
    expect(message.vars).toEqual({ app_name: "", web_host: "", window_title: "", screen_text: "", selected_text: "", terminal_program: "", user_request: request, conversation: "", user_name: "" });
  });

  /** The user's name goes with the prompt, empty when none is set, so the backend can tell the user's
   * own messages on screen from other people's. */
  test("the user's name is sent", () => {
    expect(DesktopAgent.message(request, null, false, "", "Alex Example").vars.user_name).toBe("Alex Example");
    expect(DesktopAgent.message(request, null, false, "", "").vars.user_name).toBe("");
  });

  /** A screen hidden for privacy: the agent is told so where the screen's text goes, and nothing else
   * of the screen is sent. A screen that was only not read says nothing. */
  test("the agent is told when the screen is hidden for privacy", () => {
    const hidden = DesktopAgent.message(request, null, true, "", "").vars;
    expect(hidden.screen_text).toBe(screenHiddenNote);
    expect(hidden.screen_text).toMatch(/^\[Hidden for privacy: /);
    expect([hidden.app_name, hidden.web_host, hidden.window_title, hidden.selected_text, hidden.terminal_program]).toEqual(["", "", "", "", ""]);
    expect(DesktopAgent.message(request, null, false, "", "").vars.screen_text).toBe("");
  });

  /** The chat window's conversation goes with the request. */
  test("the conversation is sent", () => {
    const conversation = "User: when is the sync?\nTabMail: Thursdays at 10:00.";
    expect(DesktopAgent.message(request, null, false, conversation, "").vars.conversation).toBe(conversation);
  });

  test("the agent is sent the screen with the selection marked, and the program in a terminal", () => {
    const message = DesktopAgent.message(request, selectionScreen("Ship it Friday."), false, "", "");

    expect(message.vars.app_name).toBe("Example Notes");
    expect(message.vars.web_host).toBe("notes.example.com");
    expect(message.vars.window_title).toBe("Weekly sync");
    expect(message.vars.terminal_program).toBe("example-shell");
    expect(message.vars.selected_text).toBe("Ship it Friday.");
    expect(message.vars.screen_text).toContain("## Agenda");
    expect(message.vars.screen_text).toContain("» Note: ‸Ship it Friday.‸");
  });

  /** A selection of only blank space is no text to edit. */
  test("a blank selection counts as none", () => {
    expect(DesktopAgent.message(request, selectionScreen(" \n"), false, "", "").vars.selected_text).toBe("");
    expect(DesktopAgent.message(request, selectionScreen("\n"), false, "", "").vars.selected_text).toBe("");
  });

  /** A selection the helper could not give at all arrives as only its placeholder: the agent is
   * told so in words, never handed the placeholder as if the user had selected it. */
  test("an unread selection reaches the agent as a note, not as selected text", () => {
    const unread = { ...selectionScreen(redactionPlaceholder), selectionRedacted: true };
    expect(DesktopAgent.message(request, unread, false, "", "").vars.selected_text).toBe(selectionUnreadNote);
  });

  test("a selection with a secret taken out still reaches the agent as selected", () => {
    const partly = { ...selectionScreen(`token ${redactionPlaceholder} for the demo`), selectionRedacted: true };
    expect(DesktopAgent.message(request, partly, false, "", "").vars.selected_text).toBe(`token ${redactionPlaceholder} for the demo`);
    // Not redacted: the same text is the user's own, placeholder-looking or not.
    expect(DesktopAgent.message(request, selectionScreen(redactionPlaceholder), false, "", "").vars.selected_text).toBe(redactionPlaceholder);
  });

  test("the placeholder is the helpers' own", () => {
    const redactors = JSON.parse(readFileSync(join(__dirname, "../../../native/shared/privacy/redactors.json"), "utf8")) as { placeholder: string };
    expect(redactionPlaceholder).toBe(redactors.placeholder);
  });

  test.each([
    ["Ship it Friday.\n", "Could we ship Friday?", "Could we ship Friday?\n"],
    ["  indented line", "Rewritten line", "  Rewritten line"],
    ["plain", "\nRewritten\n", "Rewritten"],
    ["\n\nparagraph\n\n", "New paragraph", "\n\nNew paragraph\n\n"],
    [" \n", "Filled", " \nFilled"],
  ])("an edit keeps the selection's own surrounding space (%j)", (selection, edited, expected) => {
    expect(EditTool.fittedToSelection(edited, selection)).toBe(expected);
  });

  /** Edit and Compose are never offered together: text selected is Edit, nothing (or only blank
   * space, or no screen read) is Compose; Answer beside it. Thunderbird's relay has no backend tool. */
  test("the selection decides the writing tool", () => {
    expect(DesktopAgent.writingTool(selectionScreen("Ship it."))).toBe("edit");
    expect(DesktopAgent.writingTool(selectionScreen(""))).toBe("compose");
    expect(DesktopAgent.writingTool(selectionScreen(" \n"))).toBe("compose");
    expect(DesktopAgent.writingTool(null)).toBe("compose");
    expect(DesktopAgent.tools(selectionScreen("Ship it."), all)).toEqual(["edit", "answer"]);
    expect(DesktopAgent.tools(null, all)).toEqual(["compose", "answer"]);
  });

  /** A tool switched off in Settings is never offered; the other writing tool does not stand in for
   * it, since its text would land on the selection (or the caret) wrongly. */
  test.each<[string, AgentToolID[], AgentToolID[]]>([
    ["Ship it.", ["compose", "thunderbird", "answer"], ["answer"]],
    ["", ["edit", "thunderbird", "answer"], ["answer"]],
    ["", ["compose", "answer"], ["compose", "answer"]],
    ["", ["compose", "thunderbird"], ["compose"]],
    ["Ship it.", ["compose"], []],
    ["", [], []],
  ])("with selection %j and %j on, the agent offers %j", (selected, enabled, offered) => {
    expect(DesktopAgent.tools(selectionScreen(selected), enabled)).toEqual(offered);
  });
});

/** The agent's tool loop: each round's tool calls run here, and their results go back with the loop's
 * state until the model replies or calls the writing tool. Never the network. */
describe("the agent's tool loop", () => {
  const tools = ["date_to_day", "time_delta", "example_read"];
  const ignoreServerTools = () => {};

  /** The backend's own tools are heard of as they start and end, while the round's stream arrives,
   * each piece of it however it is cut: a piece may end mid-line, even inside a CRLF. Events without
   * the tool's name (a backend that sends it only in dev) and those that aren't JSON are skipped. */
  test.each([1, 7, Number.POSITIVE_INFINITY])("the backend's tools are heard of as they run (pieces of %d)", async (chunkSize) => {
    const { completions, client, account } = setup();
    completions.chunkSize = chunkSize;
    const events = [
      'event: tool_started\r\ndata: {"tool_name":"search_web","display_label":"Searching the web: example"}\r\n\r\n',
      'event: tool_started\ndata: {"display_label":"Unnamed"}\n\n',
      "event: tool_started\ndata: not json\n\n",
      'event: tool_failed\ndata: {"tool_name":"date_to_day"}\n\n',
      'event: tool_completed\ndata: {"tool_name":"search_web","display_label":"Searching the web: example","success":true}\n\n',
    ].join("");
    completions.enqueue(200, events + Fixtures.reply("Found it."));
    const heard: ServerToolEvent[] = [];

    const answer = await DesktopAgent.run("search it", null, false, "", "", tools, client, account, Fixtures.userID, async () => "", (event) => heard.push(event));

    expect(answer).toEqual({ tool: "answer", text: "Found it." });
    expect(heard).toEqual([
      { tool: "search_web", running: true, label: "Searching the web: example" },
      { tool: "date_to_day", running: false, label: null },
      { tool: "search_web", running: false, label: "Searching the web: example" },
    ]);
  });

  /** With Answer on, the loop is offered the backend's date tools, every tool that runs on this
   * computer and the writing tool; with it off, the writing tool alone. */
  test("the loop is offered the date tools, this computer's tools and the writing tool", () => {
    const tool = (name: string): ConnectorTool => ({ name, connector: "calendar", progressLabel: "", confirmation: () => null, run: async () => "" });
    expect(DesktopAgent.loopTools(["answer"], [])).toEqual(["date_to_day", "time_delta"]);
    expect(DesktopAgent.loopTools(["compose", "answer"], [tool("example_read"), tool("example_create")])).toEqual(["date_to_day", "time_delta", "confirmation_answer", "example_read", "example_create", "compose"]);
    expect(DesktopAgent.loopTools(["edit"], [tool("example_read")])).toEqual(["edit"]);
    expect(DesktopAgent.loopTools([], [tool("example_read")])).toEqual([]);
  });

  /** An app whose tools are offered brings the backend's own tools it has (the web, its search), after
   * the date tools, once however many of its tools there are; one with none of its tools offered
   * (switched off, or none on this computer), or an app with no backend tools, brings nothing. */
  test("an app switched on brings its backend tools", () => {
    const tool = (name: string, connector: ConnectorTool["connector"]): ConnectorTool => ({ name, connector, progressLabel: "", confirmation: () => null, run: async () => "" });
    expect(DesktopAgent.loopTools(["answer"], [tool("example_read", "calendar"), tool("web_read", "web"), tool("web_open", "web")])).toEqual(["date_to_day", "time_delta", "search_web", "confirmation_answer", "example_read", "web_read", "web_open"]);
    expect(DesktopAgent.loopTools(["answer"], [tool("example_read", "calendar"), tool("example_note", "notes")])).toEqual(["date_to_day", "time_delta", "confirmation_answer", "example_read", "example_note"]);
    expect(DesktopAgent.loopTools(["answer"], [])).toEqual(["date_to_day", "time_delta"]);
  });

  /** A call to the writing tool ends the request (owner, 2026-10-05): its text is what is pasted, the
   * round's other calls never run, the text the model wrote beside it is not used, and nothing more is
   * asked. */
  test("a compose call ends the loop with its text, running nothing else", async () => {
    const { completions, client, account } = setup();
    const call = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });
    completions.enqueue(200, Fixtures.completionsStream(JSON.stringify({
      assistant: "Here is what I will paste.",
      tool_calls: [call("call_a", "example_read", "{}"), call("call_b", "compose", '{"text":"  Lunch is at noon.\\n"}')],
      conversation_state: Fixtures.loopState(),
    })));
    completions.enqueue(200, Fixtures.reply("Never asked."));
    const ran: string[] = [];

    const outcome = await DesktopAgent.run("paste lunch time", null, false, "", "", [...tools, "compose"], client, account, Fixtures.userID, async (call) => {
      ran.push(call.id);
      return "";
    }, ignoreServerTools);

    expect(outcome).toEqual({ tool: "compose", text: "Lunch is at noon." });
    expect(ran).toEqual([]);
    expect(completions.requests).toHaveLength(1);
  });

  /** "Paste my next meeting": the lookup runs in one round, the paste ends the next. */
  test("a lookup runs, then the edit written from it ends the loop, fitted to the selection", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_a", name: "example_read", arguments: "{}" }]));
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_b", name: "edit", arguments: '{"text":"Sync on Thursday at 10:00."}' }]));
    const ran: string[] = [];

    const outcome = await DesktopAgent.run("replace this with my next meeting", selectionScreen("next meeting\n"), false, "", "", [...tools, "edit"], client, account, Fixtures.userID, async (call) => {
      ran.push(call.id);
      return "Sync, Thursday 10:00";
    }, ignoreServerTools);

    expect(outcome).toEqual({ tool: "edit", text: "Sync on Thursday at 10:00.\n" });
    expect(ran).toEqual(["call_a"]);
    expect(completions.requests).toHaveLength(2);
  });

  /** Only the writing tool the loop was offered ends it: a call to the other one is an ordinary call,
   * which the app has no tool for. */
  test("a call to the writing tool not offered runs as any other call", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_a", name: "edit", arguments: '{"text":"Over the selection."}' }]));
    completions.enqueue(200, Fixtures.reply("Done."));
    const ran: string[] = [];

    const outcome = await DesktopAgent.run("write it", null, false, "", "", [...tools, "compose"], client, account, Fixtures.userID, async (call) => {
      ran.push(call.function.name);
      return "Error: there is no tool named edit.";
    }, ignoreServerTools);

    expect(outcome).toEqual({ tool: "answer", text: "Done." });
    expect(ran).toEqual(["edit"]);
  });

  /** A writing call with no text to paste fails, pasting nothing. */
  test.each(['{"text":"  "}', "{}", '{"text":3}', "not json", "[]"])("a writing call with arguments %j fails", async (args) => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_a", name: "compose", arguments: args }]));

    const error = await thrown(DesktopAgent.run("write it", null, false, "", "", [...tools, "compose"], client, account, Fixtures.userID, async () => "", ignoreServerTools));
    expect((error as AgentError).kind).toBe("noText");
  });

  /** A selection the helper took a secret out of is not the user's text (ADR-DESK-046): an edit of it,
   * pasted over the selection, would put the placeholder where the secret was. */
  test("an edit of a selection that reached the app redacted is refused", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_a", name: "edit", arguments: '{"text":"connect with postgres"}' }]));
    const redacted = { ...selectionScreen("connect with postgres://app:[redacted]@db.example.com"), selectionRedacted: true };

    const error = await thrown(DesktopAgent.run(request, redacted, false, "", "", ["edit"], client, account, Fixtures.userID, async () => "", ignoreServerTools));

    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).kind).toBe("secretInSelection");
    expect((error as AgentError).message).toBe("The selection holds what looks like a password or key, so it wasn't rewritten.");
  });

  /** Only Edit replaces the selection: a reply still answers, from the redacted text. */
  test("a reply still answers with a redacted selection", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply("It connects to the database."));
    const redacted = { ...selectionScreen("postgres://app:[redacted]@db.example.com"), selectionRedacted: true };

    expect(await DesktopAgent.run("what is this", redacted, false, "", "", ["edit"], client, account, Fixtures.userID, async () => "", ignoreServerTools)).toEqual({ tool: "answer", text: "It connects to the database." });
  });

  test("a backend error is reported as itself", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(402, { error: "no_active_subscription" });

    const error = await thrown(DesktopAgent.run(request, selectionScreen("Ship it."), false, "", "", ["edit"], client, account, Fixtures.userID, async () => "", ignoreServerTools));
    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).kind).toBe("subscriptionRequired");
  });

  /** The first round offers the tools with tools on and sends no state; its reply, trimmed, is the
   * answer. */
  test("an answer offers its tools and returns the reply", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply("  Friday is the 3rd.\n"));
    const calls: ToolCall[] = [];

    const answer = await DesktopAgent.run("what day is friday", null, false, "User: hi\nTabMail: Hello.", "", tools, client, account, Fixtures.userID, async (call) => {
      calls.push(call);
      return "";
    }, ignoreServerTools);

    expect(answer).toEqual({ tool: "answer", text: "Friday is the 3rd." });
    expect(calls).toEqual([]);
    expect(completions.message(0)?.content).toBe("system_prompt_desktop_agent");
    expect(completions.message(0)?.conversation).toBe("User: hi\nTabMail: Hello.");
    expect(completions.body(0).available_tools).toEqual(tools);
    expect(completions.body(0).disable_tools).toBe(false);
    expect(completions.body(0)).not.toHaveProperty("conversation_state");
  });

  /** The tools a round calls run in order, and their results go back, each under its call's id, with
   * the rest of the loop's state as it came and the rounds the app has run (whatever round the state
   * says: the app's count is what reaches the backend's round limit). */
  test("the tools a round calls run, and their results go back", async () => {
    const { completions, client, account } = setup();
    const first = { ...Fixtures.loopState(), current_round: 4, tool_traces: [{ name: "date_to_day" }], ratio: 0.5, nothing: null };
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_a", name: "example_read", arguments: '{"n":1}' }, { id: "call_b", name: "example_other", arguments: "{}" }], first));
    const second = { ...Fixtures.loopState(), harmony_messages: [{ role: "user", content: "Second" }], current_round: 9 };
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_c", name: "example_read", arguments: '{"n":2}' }], second));
    completions.enqueue(200, Fixtures.reply("Both done."));
    const ran: string[] = [];

    const answer = await DesktopAgent.run("do both", null, false, "", "", tools, client, account, Fixtures.userID, async (call) => {
      ran.push(`${call.id} ${call.function.name} ${call.function.arguments}`);
      return `result of ${call.id}`;
    }, ignoreServerTools);

    expect(answer).toEqual({ tool: "answer", text: "Both done." });
    expect(ran).toEqual(['call_a example_read {"n":1}', "call_b example_other {}", 'call_c example_read {"n":2}']);
    expect(completions.body(1).conversation_state).toEqual({
      ...first,
      harmony_messages: [...(Fixtures.loopState().harmony_messages as unknown[]), { role: "tool", content: "result of call_a", tool_call_id: "call_a" }, { role: "tool", content: "result of call_b", tool_call_id: "call_b" }],
      current_round: 1,
    });
    expect(completions.body(2).conversation_state).toEqual({
      ...second,
      harmony_messages: [{ role: "user", content: "Second" }, { role: "tool", content: "result of call_c", tool_call_id: "call_c" }],
      current_round: 2,
    });
    expect(completions.requests).toHaveLength(3);
  });

  /** A round refused for an expired session is sent once more, the same, with a refreshed one: the
   * first round, or a later one, whose tools already ran and are not run again. */
  test.each([false, true])("a refused round is retried once with a fresh session (after a tool: %s)", async (afterTool) => {
    const auth = new StubTransport();
    const completions = new StubTransport();
    const client = new CompletionsClient("https://api.example.com", "v", completions.transport);
    const call = { id: "call_a", name: "example_read", arguments: '{"n":1}' };
    if (afterTool) completions.enqueue(200, Fixtures.toolCalls([call]));
    completions.enqueue(401, { error: "invalid_token" });
    completions.enqueue(200, Fixtures.reply("Done."));
    auth.enqueue(200, Fixtures.sessionJSON({ access: "access-2", refresh: "refresh-2" }));
    const ran: string[] = [];

    const answer = await DesktopAgent.run("read it", null, false, "", "", tools, client, signedIn(auth), Fixtures.userID, async (toolCall) => {
      ran.push(toolCall.id);
      return "read";
    }, ignoreServerTools);

    expect(answer).toEqual({ tool: "answer", text: "Done." });
    expect(ran).toEqual(afterTool ? ["call_a"] : []);
    expect(auth.requests).toHaveLength(1);
    const refused = afterTool ? 1 : 0;
    expect(completions.authorizations).toEqual([...(afterTool ? ["Bearer access-1"] : []), "Bearer access-1", "Bearer access-2"]);
    const { client_timestamp_ms: _sent, ...first } = completions.body(refused);
    const { client_timestamp_ms: _resent, ...again } = completions.body(refused + 1);
    expect(again).toEqual(first);
  });

  /** Refused again with the fresh session, the answer fails as unauthorized, sending no third time. */
  test("a round refused twice fails", async () => {
    const auth = new StubTransport();
    const completions = new StubTransport();
    const client = new CompletionsClient("https://api.example.com", "v", completions.transport);
    completions.enqueue(401, { error: "invalid_token" });
    completions.enqueue(401, { error: "invalid_token" });
    auth.enqueue(200, Fixtures.sessionJSON({ access: "access-2", refresh: "refresh-2" }));

    const error = await thrown(DesktopAgent.run("read it", null, false, "", "", tools, client, signedIn(auth), Fixtures.userID, async () => "", ignoreServerTools));

    expect((error as BackendError).kind).toBe("unauthorized");
    expect(completions.requests).toHaveLength(2);
    expect(auth.requests).toHaveLength(1);
  });

  /** State with no tool history to add to can't be continued: the request fails, running nothing. */
  test.each([{ current_round: 1 }, { harmony_messages: {} }, [], "state"])("a state of %j fails", async (state) => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_a", name: "example_read", arguments: "{}" }], state));
    let ran = 0;

    const error = await thrown(
      DesktopAgent.run("read it", null, false, "", "", tools, client, account, Fixtures.userID, async () => {
        ran += 1;
        return "";
      }, ignoreServerTools),
    );

    expect((error as BackendError).kind).toBe("invalidResponse");
    expect(ran).toBe(0);
    expect(completions.requests).toHaveLength(1);
  });

  /** An empty reply is a failure. */
  test("an empty answer fails", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply(" \n"));

    const error = await thrown(DesktopAgent.run("what now", null, false, "", "", tools, client, account, Fixtures.userID, async () => "", ignoreServerTools));
    expect((error as AgentError).kind).toBe("noText");
  });

  /** Canceled before it starts, the answer asks nothing. */
  test("a canceled answer asks nothing", async () => {
    const { completions, client, account } = setup();
    const abort = new AbortController();
    abort.abort();

    await thrown(DesktopAgent.run("what now", null, false, "", "", tools, client, account, Fixtures.userID, async () => "", ignoreServerTools, abort.signal));
    expect(completions.requests).toHaveLength(0);
  });

  /** Canceled while a tool runs (the chat window closed as it asked), the round's later calls don't
   * run and the model is asked nothing more. */
  test("canceled while a tool runs, it runs and asks nothing more", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_a", name: "example_read", arguments: "{}" }, { id: "call_b", name: "example_read", arguments: "{}" }]));
    completions.enqueue(200, Fixtures.reply("Never asked."));
    const abort = new AbortController();
    const ran: string[] = [];

    const error = await thrown(
      DesktopAgent.run("read it", null, false, "", "", tools, client, account, Fixtures.userID, async (call) => {
        ran.push(call.id);
        abort.abort();
        return "";
      }, ignoreServerTools, abort.signal),
    );

    expect((error as Error).name).toBe("AbortError");
    expect(ran).toEqual(["call_a"]);
    expect(completions.requests).toHaveLength(1);
  });

  /** Canceled after a round's last tool, the next round is not asked. */
  test("canceled after a round's tools, the next round is not asked", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_a", name: "example_read", arguments: "{}" }]));
    completions.enqueue(200, Fixtures.reply("Never asked."));
    const abort = new AbortController();

    await thrown(
      DesktopAgent.run("read it", null, false, "", "", tools, client, account, Fixtures.userID, async () => {
        abort.abort();
        return "";
      }, ignoreServerTools, abort.signal),
    );

    expect(completions.requests).toHaveLength(1);
  });
});

/** The same cases are projected by Rust's viewport suite; changing the native refusal
 * representation must not silently change which writing tool can request and paste. */
describe("terminal selection writing boundary", () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, "../../../native/shared/context/terminal-action-cases.json"), "utf8")) as {
    cases: { name: string; expected: { selectedText: string; selectionComplete: boolean } }[];
  };
  test("has refused and readable positive-control cases", () => {
    expect(fixture.cases).toHaveLength(5);
    expect(fixture.cases.filter((item) => item.expected.selectionComplete)).toHaveLength(1);
  });
  test.each(fixture.cases)("$name reaches the intended writing boundary", async ({ expected }) => {
    const context = screen({ selectedText: expected.selectedText, selectionRedacted: !expected.selectionComplete });
    const { completions, client, account } = setup();
    const offered = DesktopAgent.tools(context, ["edit", "compose"]);
    const [writing] = offered;
    completions.enqueue(200, Fixtures.toolCalls([{ id: "call_a", name: writing ?? "edit", arguments: '{"text":"friendlier text"}' }]));
    const pastes: string[] = [];
    const writeAndDeliver = async () => {
      const { tool, text } = await DesktopAgent.run(request, context, false, "", "", DesktopAgent.loopTools(offered, []), client, account, Fixtures.userID, async () => "", () => {});
      await agentTools[tool].deliver(text, { paste: async (value) => { pastes.push(value); }, emailApp: null,
        thunderbird: null as never, showAnswer: () => {}, signal: new AbortController().signal });
    };
    expect(offered).toEqual(["edit"]);
    if (expected.selectionComplete) {
      await writeAndDeliver();
      expect(completions.requests).toHaveLength(1);
      expect(completions.message(0)?.content).toBe("system_prompt_desktop_agent");
      expect(pastes).toEqual(["friendlier text"]);
    } else {
      const error = await thrown(writeAndDeliver());
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).kind).toBe("secretInSelection");
      expect(pastes).toEqual([]);
    }
  });
});
