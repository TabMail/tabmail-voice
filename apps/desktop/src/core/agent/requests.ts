// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AccountModel, withFreshToken } from "../backend/account.js";
import { BackendError } from "../backend/errors.js";
import { type CompletionsClient, type CompletionsMessage, type ServerToolEvent, type ToolCall } from "../backend/completions.js";
import * as config from "../config.js";
import { elapsed, log } from "../log.js";
import type { ScreenContext } from "../dictation/screenContext.js";
import { trimWhitespace } from "../util/text.js";
import { connectors } from "./connectors/index.js";
import { type ConnectorTool, isJSONObject, parsedJSON } from "./connectors/contract.js";
import { AgentError, type AgentToolID, agentTools, screenVariables, selection } from "./tools.js";

/** How a request ended: text pasted with a writing tool (`compose` or `edit`), or a reply for the chat
 * window (`answer`). */
export interface AgentOutcome {
  tool: AgentToolID;
  text: string;
}

/**
 * Agent mode on the backend: one tool loop (`run`), as the Thunderbird add-on's and the iOS app's
 * agents are. The model calls the tools it needs, here and on the backend, and ends either by calling
 * the writing tool, Compose or Edit, whose text is pasted, or with a reply for the chat window. The
 * instructions live in the backend prompt, shared by every desktop platform. No call has a deadline of
 * its own: the request takes as long as the model does (owner, 2026-09-26: agent mode has no timeout).
 */
export const DesktopAgent = {
  /** The tools agent mode offers for the screen read at key-down, among those the user has on
   * (`enabled`): the writing tool, Edit when text is selected and Compose when not (never the other:
   * its paste would land on the selection or the caret wrongly), and Answer, the chat window. */
  tools(context: ScreenContext | null, enabled: readonly AgentToolID[]): AgentToolID[] {
    const candidates: AgentToolID[] = [DesktopAgent.writingTool(context), "answer"];
    return candidates.filter((tool) => enabled.includes(tool));
  },

  /** Edit when text is selected, Compose when not. */
  writingTool(context: ScreenContext | null): "edit" | "compose" {
    return selection(context) === "" ? "compose" : "edit";
  },

  /** The tools the loop's model may call (`available_tools`): the writing tool among the `offered`
   * ones and, with Answer offered, the backend's date tools, the backend tools their apps bring (web
   * search), and `connectorTools`, those of the apps switched on that run on this computer, with the
   * tool that answers their questions for the user (`confirmationTool`) when there are any. An app with
   * no tools here (none off macOS) brings no backend tools either. */
  loopTools(offered: readonly AgentToolID[], connectorTools: readonly ConnectorTool[]): string[] {
    const writing = offered.filter(isWritingTool);
    if (!offered.includes("answer")) return writing;
    const serverTools = connectors.filter((connector) => connectorTools.some((tool) => tool.connector === connector.id)).flatMap((connector) => connector.serverTools ?? []);
    const answering = connectorTools.length > 0 ? [config.confirmationTool] : [];
    return [...config.answerServerTools, ...serverTools, ...answering, ...connectorTools.map((tool) => tool.name), ...writing];
  },

  /** Carries out `request` in the backend's tool loop: each round either replies, or calls tools,
   * which `runTool` runs here (told which round called them, counted from 0) (the backend runs its
   * own, which `onServerTool` hears of as they start and end); their results go back with the loop's
   * state for the next round. A call to the writing tool among `tools` ends the request (owner,
   * 2026-10-05): its text is what is pasted, and the round's other calls and any text are ignored. A
   * reply ends it too, for the chat window. The backend ends the loop at its round limit, counting
   * the rounds the app sends back (`current_round`), as the iOS app's `BackendClient` does.
   * `screenHidden`: the screen was not read for the user's privacy, which the model is told. */
  async run(
    request: string,
    context: ScreenContext | null,
    screenHidden: boolean,
    conversation: string,
    userName: string,
    tools: readonly string[],
    client: CompletionsClient,
    account: AccountModel,
    userID: string | null,
    runTool: (call: ToolCall, round: number) => Promise<string>,
    onServerTool: (event: ServerToolEvent) => void,
    signal?: AbortSignal,
  ): Promise<AgentOutcome> {
    const message = DesktopAgent.message(request, context, screenHidden, conversation, userName);
    let state: unknown;
    let round = 0;
    for (;;) {
      // A request canceled while a tool ran (the chat window closed as it asked) asks nothing more.
      signal?.throwIfAborted();
      const started = performance.now();
      const result = await withFreshToken(account, userID, (token) => client.round(message, tools, state, token, signal, onServerTool));
      log.debug(() => `DesktopAgent: round ${round} answered in ${elapsed(started)}`);
      if (result.kind === "reply") {
        const text = trimWhitespace(result.text);
        if (text === "") throw new AgentError("noText");
        log.content("DesktopAgent: answer wrote", text);
        return { tool: "answer", text };
      }
      const writing = result.calls.find((call) => isWritingTool(call.function.name) && tools.includes(call.function.name));
      if (writing !== undefined) return DesktopAgent.written(writing, context);
      const called = round;
      round += 1;
      // The state is JSON the round checked is there; its history must be a list to add to.
      const fields = result.state as Record<string, unknown>;
      if (!Array.isArray(fields.harmony_messages)) throw new BackendError("invalidResponse");
      const added: unknown[] = [...fields.harmony_messages];
      for (const call of result.calls) {
        signal?.throwIfAborted();
        const output = await runTool(call, called);
        added.push({ role: "tool", content: output, tool_call_id: call.id });
      }
      state = { ...fields, harmony_messages: added, current_round: round };
    }
  },

  /** The text a writing tool's `call` gives, ready to paste: for an edit, with the selection's own
   * leading and trailing blank space, so replacing a whole line keeps its line break. */
  written(call: ToolCall, context: ScreenContext | null): AgentOutcome {
    const tool = call.function.name as "edit" | "compose";
    // The selection as read is not the user's text: nothing replaces it.
    if (tool === "edit" && context?.selectionRedacted === true) throw new AgentError("secretInSelection");
    const args = parsedJSON(call.function.arguments);
    const text = isJSONObject(args) && typeof args.text === "string" ? trimWhitespace(args.text) : "";
    if (text === "") {
      log.error(`DesktopAgent: ${tool} called without text`);
      throw new AgentError("noText");
    }
    const fitted = agentTools[tool].fitted(text, context);
    log.content(`DesktopAgent: ${tool} wrote`, fitted);
    return { tool, text: fitted };
  },

  /** The agent's prompt and its variables, with the chat window's `conversation` (`chatTranscript`,
   * empty outside a follow-up) and the user's name (`userName`, empty when none is set), by which the
   * backend tells the user's own messages on screen from other people's. Every variable is sent, empty
   * when unknown: the backend leaves a missing one in the prompt as written. With `screenHidden` (no
   * `context` then) the screen's text says that the screen is hidden for privacy; the program running
   * in a terminal lets a command come out as that program takes it. */
  message(request: string, context: ScreenContext | null, screenHidden: boolean, conversation: string, userName: string): CompletionsMessage {
    return {
      role: "system",
      content: config.agentPrompt,
      vars: { ...screenVariables(request, context, screenHidden), terminal_program: context?.terminalProgram ?? "", conversation, user_name: userName },
    };
  },
};

function isWritingTool(name: string): name is "edit" | "compose" {
  return name === "edit" || name === "compose";
}
