// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { DesktopAgent } from "../src/core/agent/desktopAgent.js";
import { AgentFailure, type AgentTool, agentTools, EditTool } from "../src/core/agent/tools.js";
import { BackendError, CompletionsClient } from "../src/core/backend.js";
import { screen } from "./screens.js";
import { Fixtures, signedIn, StubTransport } from "./support.js";

const request = "make this friendlier";
const all = agentTools;

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

/** The agent's two backend calls: what each sends, and how its reply becomes a tool or text to
 * insert. Never the network. */
describe("DesktopAgent", () => {
  /** Every variable the backend prompt renders is sent, empty when unknown: the backend leaves a
   * missing one in the prompt as written. */
  test("without a screen every variable is sent empty", () => {
    const choose = DesktopAgent.chooseMessage(request, null, "");
    expect(choose.content).toBe("system_prompt_desktop_agent");
    expect(choose.vars).toEqual({ app_name: "", web_host: "", window_title: "", selected_text: "", user_request: request, conversation: "" });

    const edit = DesktopAgent.toolMessage("edit", request, null, "");
    expect(edit.content).toBe("system_prompt_desktop_edit");
    expect(Object.keys(edit.vars).sort()).toEqual(["app_name", "conversation", "screen_text", "selected_text", "user_request", "web_host", "window_title"]);

    const compose = DesktopAgent.toolMessage("compose", request, null, "");
    expect(compose.content).toBe("system_prompt_desktop_compose");
    expect(Object.keys(compose.vars).sort()).toEqual(["app_name", "conversation", "screen_text", "selected_text", "terminal_program", "user_request", "web_host", "window_title"]);

    const thunderbird = DesktopAgent.toolMessage("thunderbird", request, null, "");
    expect(thunderbird.content).toBe("system_prompt_desktop_thunderbird");
    expect(Object.keys(thunderbird.vars).sort()).toEqual(["app_name", "conversation", "screen_text", "selected_text", "user_request", "web_host", "window_title"]);

    const answer = DesktopAgent.toolMessage("answer", request, null, "");
    expect(answer.content).toBe("system_prompt_desktop_answer");
    expect(Object.keys(answer.vars).sort()).toEqual(["app_name", "conversation", "screen_text", "selected_text", "user_request", "web_host", "window_title"]);
  });

  /** The chat window's conversation goes with the agent's choice and every tool's prompt. */
  test.each(agentTools)("the conversation is sent with every prompt (%s)", (tool) => {
    const conversation = "User: when is the sync?\nTabMail: Thursdays at 10:00.";
    expect(DesktopAgent.chooseMessage(request, null, conversation).vars.conversation).toBe(conversation);
    expect(DesktopAgent.toolMessage(tool, request, null, conversation).vars.conversation).toBe(conversation);
  });

  test("a tool is sent the screen with the selection marked", () => {
    const message = DesktopAgent.toolMessage("compose", request, selectionScreen("Ship it Friday."), "");

    expect(message.vars.app_name).toBe("Example Notes");
    expect(message.vars.web_host).toBe("notes.example.com");
    expect(message.vars.terminal_program).toBe("example-shell");
    expect(message.vars.selected_text).toBe("Ship it Friday.");
    expect(message.vars.screen_text).toContain("## Agenda");
    expect(message.vars.screen_text).toContain("» Note: ‸Ship it Friday.‸");
  });

  /** A selection of only blank space is no text to edit. */
  test("a blank selection counts as none", () => {
    expect(DesktopAgent.chooseMessage(request, selectionScreen(" \n"), "").vars.selected_text).toBe("");
    expect(DesktopAgent.chooseMessage(request, selectionScreen("\n"), "").vars.selected_text).toBe("");
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
   * space, or no screen read) is Compose; Thunderbird joins them when an email app is available, and
   * Answer always. */
  test("the selection decides the writing tool", () => {
    expect(DesktopAgent.writingTool(selectionScreen("Ship it."))).toBe("edit");
    expect(DesktopAgent.writingTool(selectionScreen(""))).toBe("compose");
    expect(DesktopAgent.writingTool(selectionScreen(" \n"))).toBe("compose");
    expect(DesktopAgent.writingTool(null)).toBe("compose");
    expect(DesktopAgent.tools(selectionScreen("Ship it."), all, false)).toEqual(["edit", "answer"]);
    expect(DesktopAgent.tools(selectionScreen("Ship it."), all, true)).toEqual(["edit", "thunderbird", "answer"]);
    expect(DesktopAgent.tools(null, all, true)).toEqual(["compose", "thunderbird", "answer"]);
  });

  /** A tool switched off in Settings is never offered; the other writing tool does not stand in for
   * it, since its text would land on the selection (or the caret) wrongly. */
  test.each<[string, AgentTool[], AgentTool[]]>([
    ["Ship it.", ["compose", "thunderbird", "answer"], ["thunderbird", "answer"]],
    ["", ["edit", "thunderbird", "answer"], ["thunderbird", "answer"]],
    ["", ["compose", "answer"], ["compose", "answer"]],
    ["", ["compose", "thunderbird"], ["compose", "thunderbird"]],
    ["Ship it.", ["compose"], []],
    ["", [], []],
  ])("with selection %j and %j on, the agent offers %j", (selected, enabled, offered) => {
    expect(DesktopAgent.tools(selectionScreen(selected), enabled, true)).toEqual(offered);
  });

  /** With one tool offered there is nothing to choose between: no agent call. */
  test("a single offered tool is used unasked", async () => {
    const { completions, client, account } = setup();

    expect(await DesktopAgent.tool(request, ["edit"], selectionScreen("Ship it."), "", client, account, Fixtures.userId)).toBe("edit");
    expect(completions.requests).toHaveLength(0);
  });

  test("no offered tool fails without asking", async () => {
    const { completions, client, account } = setup();

    const error = await thrown(DesktopAgent.tool(request, [], null, "", client, account, Fixtures.userId));
    expect((error as AgentFailure).kind).toBe("noToolEnabled");
    expect((error as AgentFailure).message).toBe("Turn on an agent tool in Settings.");
    expect(completions.requests).toHaveLength(0);
  });

  /** The agent chooses among the offered tools, and the backend is told which they are
   * (`available_tools`), with the conversation. */
  test.each<[string, AgentTool]>([
    ["thunderbird", "thunderbird"],
    ["edit", "edit"],
    ["answer", "answer"],
  ])("the agent's %s is %s", async (reply, tool) => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply(reply));

    expect(await DesktopAgent.tool(request, ["edit", "thunderbird", "answer"], selectionScreen("Ship it."), "User: hi\nTabMail: Hello.", client, account, Fixtures.userId)).toBe(tool);
    expect(completions.requests).toHaveLength(1);
    expect(completions.body(0).available_tools).toEqual(["edit", "thunderbird", "answer"]);
    expect(completions.message(0)?.content).toBe("system_prompt_desktop_agent");
    expect(completions.message(0)?.user_request).toBe(request);
    expect(completions.message(0)?.selected_text).toBe("Ship it.");
    expect(completions.message(0)?.conversation).toBe("User: hi\nTabMail: Hello.");
  });

  /** A reply naming no tool, or a tool that was not offered, fails: the backend holds the agent to the
   * offered ones, and so does the app. */
  test.each(["", "rewrite", "compose", "Edit"])("a reply naming no offered tool fails (%j)", async (reply) => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply(reply));

    const error = await thrown(DesktopAgent.tool(request, ["edit", "answer"], selectionScreen("Ship it."), "", client, account, Fixtures.userId));
    expect((error as AgentFailure).kind).toBe("noTool");
  });

  /** Only the agent's choice tells the backend which tools there are: a tool's own prompt writes its
   * text and chooses nothing. */
  test("a tool's prompt is sent no available tools", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply("Thursdays at 10:00."));

    expect(await DesktopAgent.write("answer", "when is the sync", null, "", client, account, Fixtures.userId)).toBe("Thursdays at 10:00.");
    expect(completions.message(0)?.content).toBe("system_prompt_desktop_answer");
    expect(completions.body(0)).not.toHaveProperty("available_tools");
  });

  /** The Thunderbird tool's message is sent to TabMail's chat as it comes: no fitting to a
   * selection. */
  test("the Thunderbird tool writes a chat message", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply("  Find the invoice Sam sent last week.\n"));

    const message = await DesktopAgent.write("thunderbird", "find sam's invoice", selectionScreen(" Sam \n"), "", client, account, Fixtures.userId);

    expect(message).toBe("Find the invoice Sam sent last week.");
    expect(completions.message(0)?.content).toBe("system_prompt_desktop_thunderbird");
  });

  test("a tool that writes nothing fails", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply("  "));

    const error = await thrown(DesktopAgent.write("compose", request, null, "", client, account, Fixtures.userId));
    expect((error as AgentFailure).kind).toBe("noText");
  });

  test("a backend error is reported as itself", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(402, { error: "no_active_subscription" });

    const error = await thrown(DesktopAgent.write("edit", request, selectionScreen("Ship it."), "", client, account, Fixtures.userId));
    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).kind).toBe("subscriptionRequired");
  });
});
