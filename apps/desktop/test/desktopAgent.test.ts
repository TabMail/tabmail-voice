// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { DesktopAgent } from "../src/core/agent/desktopAgent.js";
import { AgentFailure, type AgentTool, EditTool } from "../src/core/agent/tools.js";
import { BackendError, CompletionsClient } from "../src/core/backend.js";
import { screen } from "./screens.js";
import { Fixtures, signedIn, StubTransport } from "./support.js";

const request = "make this friendlier";

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
    const choose = DesktopAgent.chooseMessage(request, null);
    expect(choose.content).toBe("system_prompt_desktop_agent");
    expect(choose.vars).toEqual({ app_name: "", web_host: "", window_title: "", selected_text: "", user_request: request });

    const edit = DesktopAgent.toolMessage("edit", request, null);
    expect(edit.content).toBe("system_prompt_desktop_edit");
    expect(Object.keys(edit.vars).sort()).toEqual(["app_name", "screen_text", "selected_text", "user_request", "web_host", "window_title"]);

    const compose = DesktopAgent.toolMessage("compose", request, null);
    expect(compose.content).toBe("system_prompt_desktop_compose");
    expect(Object.keys(compose.vars).sort()).toEqual(["app_name", "screen_text", "selected_text", "terminal_program", "user_request", "web_host", "window_title"]);

    const thunderbird = DesktopAgent.toolMessage("thunderbird", request, null);
    expect(thunderbird.content).toBe("system_prompt_desktop_thunderbird");
    expect(Object.keys(thunderbird.vars).sort()).toEqual(["app_name", "screen_text", "selected_text", "user_request", "web_host", "window_title"]);
  });

  test("a tool is sent the screen with the selection marked", () => {
    const message = DesktopAgent.toolMessage("compose", request, selectionScreen("Ship it Friday."));

    expect(message.vars.app_name).toBe("Example Notes");
    expect(message.vars.web_host).toBe("notes.example.com");
    expect(message.vars.terminal_program).toBe("example-shell");
    expect(message.vars.selected_text).toBe("Ship it Friday.");
    expect(message.vars.screen_text).toContain("## Agenda");
    expect(message.vars.screen_text).toContain("» Note: ‸Ship it Friday.‸");
  });

  /** A selection of only blank space is no text to edit. */
  test("a blank selection counts as none", () => {
    expect(DesktopAgent.chooseMessage(request, selectionScreen(" \n")).vars.selected_text).toBe("");
    expect(DesktopAgent.chooseMessage(request, selectionScreen("\n")).vars.selected_text).toBe("");
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
   * space, or no screen read) is Compose; Thunderbird joins them when an email app is available. */
  test("the selection decides the writing tool", () => {
    expect(DesktopAgent.writingTool(selectionScreen("Ship it."))).toBe("edit");
    expect(DesktopAgent.writingTool(selectionScreen(""))).toBe("compose");
    expect(DesktopAgent.writingTool(selectionScreen(" \n"))).toBe("compose");
    expect(DesktopAgent.writingTool(null)).toBe("compose");
    expect(DesktopAgent.tools(selectionScreen("Ship it."), false)).toEqual(["edit"]);
    expect(DesktopAgent.tools(selectionScreen("Ship it."), true)).toEqual(["edit", "thunderbird"]);
    expect(DesktopAgent.tools(null, true)).toEqual(["compose", "thunderbird"]);
  });

  /** Without an email app there is nothing to choose between: no agent call. */
  test("without an email app the writing tool is used unasked", async () => {
    const { completions, client, account } = setup();

    expect(await DesktopAgent.tool(request, selectionScreen("Ship it."), false, client, account, Fixtures.userId)).toBe("edit");
    expect(completions.requests).toHaveLength(0);
  });

  /** With an email app, the agent decides only whether the request goes there; its pick of a
   * writing tool gives way to the selection's. */
  test.each<[string, string, AgentTool]>([
    ["thunderbird", "Ship it.", "thunderbird"],
    ["edit", "Ship it.", "edit"],
    ["compose", "Ship it.", "edit"],
    ["edit", "", "compose"],
    ["compose", "", "compose"],
  ])("the agent's %s with selection %j is %s", async (reply, selected, tool) => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply(reply));

    expect(await DesktopAgent.tool(request, selectionScreen(selected), true, client, account, Fixtures.userId)).toBe(tool);
    expect(completions.requests).toHaveLength(1);
    expect(completions.message(0)?.content).toBe("system_prompt_desktop_agent");
    expect(completions.message(0)?.user_request).toBe(request);
    expect(completions.message(0)?.selected_text).toBe(selected);
  });

  /** The backend returns nothing when the reply named no tool it has. */
  test.each(["", "rewrite"])("a reply naming no tool fails (%j)", async (reply) => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply(reply));

    const error = await thrown(DesktopAgent.tool(request, selectionScreen("Ship it."), true, client, account, Fixtures.userId));
    expect((error as AgentFailure).kind).toBe("noTool");
  });

  /** The Thunderbird tool's message is sent to TabMail's chat as it comes: no fitting to a
   * selection. */
  test("the Thunderbird tool writes a chat message", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply("  Find the invoice Sam sent last week.\n"));

    const message = await DesktopAgent.write("thunderbird", "find sam's invoice", selectionScreen(" Sam \n"), client, account, Fixtures.userId);

    expect(message).toBe("Find the invoice Sam sent last week.");
    expect(completions.message(0)?.content).toBe("system_prompt_desktop_thunderbird");
  });

  test("a tool that writes nothing fails", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(200, Fixtures.reply("  "));

    const error = await thrown(DesktopAgent.write("compose", request, null, client, account, Fixtures.userId));
    expect((error as AgentFailure).kind).toBe("noText");
  });

  test("a backend error is reported as itself", async () => {
    const { completions, client, account } = setup();
    completions.enqueue(402, { error: "no_active_subscription" });

    const error = await thrown(DesktopAgent.write("edit", request, selectionScreen("Ship it."), client, account, Fixtures.userId));
    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).kind).toBe("subscriptionRequired");
  });
});
