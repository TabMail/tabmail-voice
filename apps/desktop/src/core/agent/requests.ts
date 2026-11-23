// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AccountModel, withFreshToken } from "../backend/account.js";
import { BackendError } from "../backend/errors.js";
import { type CompletionsClient, type CompletionsMessage, type ServerToolEvent, type ToolCall } from "../backend/completions.js";
import * as config from "../config.js";
import { ToolRegistry } from "./toolRegistry.js";
import { elapsed, log } from "../log.js";
import type { ScreenContext } from "../dictation/screenContext.js";
import { trimWhitespace } from "../util/text.js";
import { AgentError, type AgentToolID, agentToolIDs, agentTools, screenVariables } from "./tools.js";

/** The user's knowledge base and writing style (`UserPrompts`), as they were when the request
 * started: a change meanwhile applies to the next one (ADR-DESK-063). */
export interface Personalization {
  knowledgeBase: string;
  writingStyle: string;
}

/** The terminal handler that completed the request, and the text it delivered. */
export interface AgentOutcome {
  tool: string;
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
  /** The tools agent mode offers for the screen read at key-down: the writing tool, if the user has it
   * on (`enabled`), Edit when text is selected and Compose when not (never the other: its paste would
   * land on the selection or the caret wrongly), and Answer, the chat window, always. */
  tools(context: ScreenContext | null, enabled: readonly AgentToolID[]): AgentToolID[] {
    return agentToolIDs.filter((tool) => (tool === "answer" || enabled.includes(tool)) && agentTools[tool].available(context));
  },

  /** Dispatch each round's calls through the flat registry, in order. Nonterminal results go back
   * to the model; a completed terminal handler ends the request. Plain assistant text goes through
   * the registered response handler. Backend tools report their activity as the round streams in.
   * Cancellation is checked before and after execution, and the backend enforces the round limit.
   * A round of terminal calls only runs its first one. A terminal call beside other tools (`kb_add`
   * with a Compose) is held instead: checked first, so one that can't complete fails before the
   * others run, then the others run and the loop goes on, the model told the call is held
   * (`agentWritingHeld`). A later terminal call replaces it, and once the loop ends the held call
   * runs, whatever the model replies (owner, 2026-10-19: "let the loop finish"). */
  async run(
    request: string,
    context: ScreenContext | null,
    screenHidden: boolean,
    conversation: string,
    userName: string,
    personalization: Personalization,
    tools: ToolRegistry,
    client: CompletionsClient,
    account: AccountModel,
    userID: string | null,
    onServerTool: (event: ServerToolEvent) => void,
    signal?: AbortSignal,
  ): Promise<AgentOutcome> {
    const message = DesktopAgent.message(request, context, screenHidden, conversation, userName, personalization, tools.names);
    let state: unknown;
    let round = 0;
    let held: { call: ToolCall; round: number } | undefined;
    const finish = async (call: ToolCall, called: number): Promise<AgentOutcome> => {
      const execution = await tools.execute(call, called);
      signal?.throwIfAborted();
      return { tool: execution.tool, text: execution.text };
    };
    for (;;) {
      // A request canceled while a tool ran (the chat window closed as it asked) asks nothing more.
      signal?.throwIfAborted();
      const started = performance.now();
      const result = await withFreshToken(account, userID, (token) => client.round(message, tools.names, state, token, signal, onServerTool));
      log.debug(() => `DesktopAgent: round ${round} answered in ${elapsed(started)}`);
      if (result.kind === "reply") {
        if (held !== undefined) return finish(held.call, held.round);
        const text = trimWhitespace(result.text);
        if (text === "") throw new AgentError("noText");
        const reply = await tools.respond(text, round);
        signal?.throwIfAborted();
        return { tool: reply.tool, text: reply.text };
      }
      const called = round;
      round += 1;
      const isTerminal = (call: ToolCall) => tools.get(call.function.name)?.terminal === true;
      const terminal = result.calls.find(isTerminal);
      if (terminal !== undefined) {
        if (result.calls.every(isTerminal)) return finish(terminal, called);
        tools.get(terminal.function.name)?.check?.(terminal);
        held = { call: terminal, round: called };
      }
      // The state is JSON the round checked is there; its history must be a list to add to.
      const fields = result.state as Record<string, unknown>;
      if (!Array.isArray(fields.harmony_messages)) throw new BackendError("invalidResponse");
      const added: unknown[] = [...fields.harmony_messages];
      for (const call of result.calls) {
        signal?.throwIfAborted();
        const output = isTerminal(call) ? config.agentWritingHeld : (await tools.execute(call, called)).text;
        signal?.throwIfAborted();
        added.push({ role: "tool", content: output, tool_call_id: call.id });
      }
      state = { ...fields, harmony_messages: added, current_round: round };
    }
  },

  /** The agent's prompt and its variables, with the chat window's `conversation` (`chatTranscript`,
   * empty outside a follow-up) and the user's name (`userName`, empty when none is set), by which the
   * backend tells the user's own messages on screen from other people's. Every variable is sent, empty
   * when unknown: the backend leaves a missing one in the prompt as written. With `screenHidden` (no
   * `context` then) the screen's text says that the screen is hidden for privacy; the program running
   * in a terminal lets a command come out as that program takes it. The knowledge base goes with every
   * request, the writing style only when the loop's `tools` can write (Compose or Edit), as
   * Thunderbird sends it only to its writing prompts (ADR-DESK-063). */
  message(request: string, context: ScreenContext | null, screenHidden: boolean, conversation: string, userName: string, personalization: Personalization, tools: readonly string[]): CompletionsMessage {
    return {
      role: "system",
      content: config.agentPrompt,
      vars: {
        ...screenVariables(request, context, screenHidden),
        terminal_program: context?.terminalProgram ?? "",
        conversation,
        user_name: userName,
        user_kb_content: personalization.knowledgeBase,
        user_composition_prompt: tools.some((tool) => tool === "compose" || tool === "edit") ? personalization.writingStyle : "",
      },
    };
  },
};
