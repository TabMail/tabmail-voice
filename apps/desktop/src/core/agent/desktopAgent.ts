// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AccountModel, withFreshToken } from "../account.js";
import { BackendError, type CompletionsClient, type CompletionsMessage, type ServerToolEvent, type ToolCall } from "../backend.js";
import * as config from "../config.js";
import { elapsed, log } from "../log.js";
import type { ScreenContext } from "../screenContext.js";
import { charCount, trimWhitespace } from "../text.js";
import { connectors as allConnectors, connectorServerTools } from "./connectors.js";
import type { LoopTool } from "./loopTool.js";
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
    userName: string,
    client: CompletionsClient,
    account: AccountModel,
    userId: string | null,
    signal?: AbortSignal,
  ): Promise<string> {
    const text = await complete(DesktopAgent.toolMessage(tool, request, context, conversation, userName), client, account, userId, signal);
    if (text === "") throw new AgentFailure("noText");
    const written = toolImplementations[tool].fitted(text, context);
    log.content(`DesktopAgent: ${tool} wrote`, written);
    return written;
  },

  /** The tools the Answer prompt's model may call (`available_tools`): the backend's date tools, the
   * backend tools their apps bring (web search), and `loopTools`, those of the apps switched on that
   * run on this computer. An app with no tools here (none off macOS) brings no backend tools either. */
  answerTools(loopTools: readonly LoopTool[]): string[] {
    const serverTools = allConnectors.filter((connector) => loopTools.some((tool) => tool.connector === connector)).flatMap((connector) => connectorServerTools[connector] ?? []);
    return [...config.answerServerTools, ...serverTools, ...loopTools.map((tool) => tool.name)];
  },

  /** The answer to `request`, from the backend's tool loop: each round either replies, or calls
   * tools, which `runTool` runs here (the backend runs its own, which `onServerTool` hears of as they
   * start and end); their results go back with the loop's state for the next round. The backend ends the loop at its round limit, counting the
   * rounds the app sends back (`current_round`), as the iOS app's `BackendClient` does. */
  async answer(
    request: string,
    context: ScreenContext | null,
    conversation: string,
    userName: string,
    tools: readonly string[],
    client: CompletionsClient,
    account: AccountModel,
    userId: string | null,
    runTool: (call: ToolCall) => Promise<string>,
    onServerTool: (event: ServerToolEvent) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const message = DesktopAgent.toolMessage("answer", request, context, conversation, userName);
    let state: unknown;
    let round = 0;
    for (;;) {
      // A request cancelled while a tool ran (the chat window closed as it asked) asks nothing more.
      signal?.throwIfAborted();
      const started = performance.now();
      const result = await withFreshToken(account, userId, (token) => client.round(message, tools, state, token, signal, onServerTool));
      log.debug(() => `DesktopAgent: ${message.content} round ${round} answered in ${elapsed(started)}`);
      if (result.kind === "reply") {
        const text = trimWhitespace(result.text);
        if (text === "") throw new AgentFailure("noText");
        log.content("DesktopAgent: answer wrote", text);
        return text;
      }
      round += 1;
      // The state is JSON the round checked is there; its history must be a list to add to.
      const fields = result.state as Record<string, unknown>;
      if (!Array.isArray(fields.harmony_messages)) throw new BackendError("invalidResponse");
      const added: unknown[] = [...fields.harmony_messages];
      for (const call of result.calls) {
        signal?.throwIfAborted();
        const output = await runTool(call);
        added.push({ role: "tool", content: output, tool_call_id: call.id });
      }
      state = { ...fields, harmony_messages: added, current_round: round };
    }
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

  /** A tool's prompt and its variables, with the chat window's `conversation` and the user's name
   * (`userName`, empty when none is set), by which the backend tells the user's own messages on screen
   * from other people's. */
  toolMessage(tool: AgentTool, request: string, context: ScreenContext | null, conversation: string, userName: string): CompletionsMessage {
    const implementation = toolImplementations[tool];
    return { role: "system", content: implementation.prompt, vars: { ...implementation.variables(request, context), conversation, user_name: userName } };
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
