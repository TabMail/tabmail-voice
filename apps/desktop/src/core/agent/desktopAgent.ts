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
 * backend write the text the app inserts, or sends to Thunderbird. The instructions live in the
 * backend prompts, shared by every desktop platform. No call has a deadline of its own: the request
 * takes as long as the model does (owner, 2026-09-26: agent mode has no timeout).
 */
export const DesktopAgent = {
  /** The tools agent mode offers for the screen read at key-down: Edit when text is selected,
   * Compose when not, and Thunderbird when an email app is set up for it. */
  tools(context: ScreenContext | null, emailAppAvailable: boolean): AgentTool[] {
    return [DesktopAgent.writingTool(context), ...(emailAppAvailable ? (["thunderbird"] as const) : [])];
  },

  /** Edit when text is selected, Compose when not. */
  writingTool(context: ScreenContext | null): AgentTool {
    return selection(context) === "" ? "compose" : "edit";
  },

  /** The tool for `request`: the writing tool, unless an email app is available and the agent,
   * asked under the account `userId`, sends the request there. */
  async tool(
    request: string,
    context: ScreenContext | null,
    emailAppAvailable: boolean,
    client: CompletionsClient,
    account: AccountModel,
    userId: string | null,
    signal?: AbortSignal,
  ): Promise<AgentTool> {
    const writing = DesktopAgent.writingTool(context);
    if (!emailAppAvailable) return writing;
    const reply = await complete(DesktopAgent.chooseMessage(request, context), client, account, userId, signal);
    if (!isAgentTool(reply)) {
      log.error(`DesktopAgent: reply named no tool (${charCount(reply)} chars)`);
      throw new AgentFailure("noTool");
    }
    return reply === "thunderbird" ? "thunderbird" : writing;
  },

  /** The text `tool` writes for `request`, ready to insert (for Thunderbird, to send): for an edit,
   * with the selection's own leading and trailing blank space, so replacing a whole line keeps its
   * line break. */
  async write(
    tool: AgentTool,
    request: string,
    context: ScreenContext | null,
    client: CompletionsClient,
    account: AccountModel,
    userId: string | null,
    signal?: AbortSignal,
  ): Promise<string> {
    const text = await complete(DesktopAgent.toolMessage(tool, request, context), client, account, userId, signal);
    if (text === "") throw new AgentFailure("noText");
    const written = toolImplementations[tool].fitted(text, context);
    log.content(`DesktopAgent: ${tool} wrote`, written);
    return written;
  },

  /** The agent's prompt and its variables. Every variable is sent, empty when unknown: the backend
   * leaves a missing one in the prompt as written. */
  chooseMessage(request: string, context: ScreenContext | null): CompletionsMessage {
    return {
      role: "system",
      content: config.agentPrompt,
      vars: {
        app_name: context?.appName ?? "",
        web_host: context?.host ?? "",
        window_title: context?.windowTitle ?? "",
        selected_text: selection(context),
        user_request: request,
      },
    };
  },

  /** A tool's prompt and its variables. */
  toolMessage(tool: AgentTool, request: string, context: ScreenContext | null): CompletionsMessage {
    const implementation = toolImplementations[tool];
    return { role: "system", content: implementation.prompt, vars: implementation.variables(request, context) };
  },
};

async function complete(
  message: CompletionsMessage,
  client: CompletionsClient,
  account: AccountModel,
  userId: string | null,
  signal: AbortSignal | undefined,
): Promise<string> {
  const started = performance.now();
  const reply = await withFreshToken(account, userId, (token) => client.complete(message, token, signal));
  log.debug(() => `DesktopAgent: ${message.content} answered in ${elapsed(started)} (${charCount(reply)} chars)`);
  return trimWhitespace(reply);
}
