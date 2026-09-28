// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AccountModel, withFreshToken } from "../account.js";
import type { CompletionsClient, CompletionsMessage } from "../backend.js";
import * as config from "../config.js";
import { elapsed, log } from "../log.js";
import type { ScreenContext } from "../screenContext.js";
import { charCount, trimWhitespace } from "../text.js";
import { AgentFailure, type AgentTool, isAgentTool, selection, toolImplementations } from "./tools.js";

/**
 * Agent mode on the backend: the tool for the spoken request is chosen (`tool`), then has the
 * backend write the text the app inserts, sends to Thunderbird, or shows in the chat window. The
 * instructions live in the
 * backend prompts, shared by every desktop platform. No call has a deadline of its own: the request
 * takes as long as the model does (owner, 2026-09-26: agent mode has no timeout).
 */
export const DesktopAgent = {
  /** The tools agent mode offers for the screen read at key-down, among those the user has on
   * (`enabled`): Edit when text is selected, Compose when not (never the other: its paste would land
   * on the selection or the caret wrongly), Thunderbird when an email app is set up for it, and
   * Answer. */
  tools(context: ScreenContext | null, enabled: readonly AgentTool[], emailAppAvailable: boolean): AgentTool[] {
    const candidates: AgentTool[] = [DesktopAgent.writingTool(context), "thunderbird", "answer"];
    return candidates.filter((tool) => enabled.includes(tool) && (tool !== "thunderbird" || emailAppAvailable));
  },

  /** Edit when text is selected, Compose when not. */
  writingTool(context: ScreenContext | null): AgentTool {
    return selection(context) === "" ? "compose" : "edit";
  },

  /** The tool for `request`, among the `offered` ones: the only one without asking, else the one
   * the agent, asked under the account `userId` and told which it may choose (`available_tools`),
   * picks. */
  async tool(
    request: string,
    offered: readonly AgentTool[],
    context: ScreenContext | null,
    conversation: string,
    client: CompletionsClient,
    account: AccountModel,
    userId: string | null,
    signal?: AbortSignal,
  ): Promise<AgentTool> {
    const [first] = offered;
    if (first === undefined) throw new AgentFailure("noToolEnabled");
    if (offered.length === 1) return first;
    const reply = await complete(DesktopAgent.chooseMessage(request, context, conversation), client, account, userId, signal, offered);
    if (!isAgentTool(reply) || !offered.includes(reply)) {
      log.error(`DesktopAgent: reply named no offered tool (${charCount(reply)} chars)`);
      throw new AgentFailure("noTool");
    }
    return reply;
  },

  /** The text `tool` writes for `request`, ready to insert (for Thunderbird, to send): for an edit,
   * with the selection's own leading and trailing blank space, so replacing a whole line keeps its
   * line break. */
  async write(
    tool: AgentTool,
    request: string,
    context: ScreenContext | null,
    conversation: string,
    client: CompletionsClient,
    account: AccountModel,
    userId: string | null,
    signal?: AbortSignal,
  ): Promise<string> {
    const text = await complete(DesktopAgent.toolMessage(tool, request, context, conversation), client, account, userId, signal);
    if (text === "") throw new AgentFailure("noText");
    const written = toolImplementations[tool].fitted(text, context);
    log.content(`DesktopAgent: ${tool} wrote`, written);
    return written;
  },

  /** The agent's prompt and its variables. Every variable is sent, empty when unknown: the backend
   * leaves a missing one in the prompt as written. `conversation` is the chat window's
   * (`chatTranscript`), empty outside a follow-up. */
  chooseMessage(request: string, context: ScreenContext | null, conversation: string): CompletionsMessage {
    return {
      role: "system",
      content: config.agentPrompt,
      vars: {
        app_name: context?.appName ?? "",
        web_host: context?.host ?? "",
        window_title: context?.windowTitle ?? "",
        selected_text: selection(context),
        user_request: request,
        conversation,
      },
    };
  },

  /** A tool's prompt and its variables, with the chat window's `conversation`. */
  toolMessage(tool: AgentTool, request: string, context: ScreenContext | null, conversation: string): CompletionsMessage {
    const implementation = toolImplementations[tool];
    return { role: "system", content: implementation.prompt, vars: { ...implementation.variables(request, context), conversation } };
  },
};

async function complete(
  message: CompletionsMessage,
  client: CompletionsClient,
  account: AccountModel,
  userId: string | null,
  signal: AbortSignal | undefined,
  /** The agent tools the backend may offer this request, for the agent's choice. */
  availableTools?: readonly AgentTool[],
): Promise<string> {
  const started = performance.now();
  const reply = await withFreshToken(account, userId, (token) => client.complete(message, token, signal, availableTools));
  log.debug(() => `DesktopAgent: ${message.content} answered in ${elapsed(started)} (${charCount(reply)} chars)`);
  return trimWhitespace(reply);
}
