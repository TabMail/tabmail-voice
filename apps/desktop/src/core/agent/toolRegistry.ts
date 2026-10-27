// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ToolCall, ServerToolEvent } from "../backend/completions.js";
import type { BubbleKey } from "./bubbleOrder.js";
import { AgentError } from "./tools.js";

/** One callable tool. Execution and termination are data, never names in the loop. */
export interface RegisteredTool {
  readonly name: string;
  readonly terminal: boolean;
  readonly bubble?: BubbleKey;
  readonly progressLabel?: string;
  /** Confirmation/preparation happens before the effect starts its activity. */
  readonly deferredActivity?: boolean;
  readonly chatCaption?: string | null;
  /** A normal assistant reply is delivered through this tool, without advertising a model call. */
  readonly response?: boolean;
  readonly advertise?: boolean;
  /** Only the confirmation-answer tool preserves the question answered aloud. */
  readonly preservesConfirmation?: boolean;
  /** Absent for tools the backend executes itself. */
  readonly run?: (call: ToolCall, round: number) => Promise<string>;
}

export interface ToolExecution {
  tool: string;
  text: string;
  terminal: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly responseTool: RegisteredTool | undefined;

  constructor(definitions: readonly RegisteredTool[], private readonly activity: (tool: RegisteredTool, running: boolean, label?: string | null) => void = () => {}, private readonly beforeCall: (tool: RegisteredTool | undefined) => void = () => {}) {
    for (const tool of definitions) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
    const responses = definitions.filter((tool) => tool.response);
    if (responses.length > 1) throw new Error("Only one tool may deliver assistant replies.");
    this.responseTool = responses[0];
    if (this.responseTool && (!this.responseTool.terminal || !this.responseTool.run)) throw new Error("The response tool must be a local terminal handler.");
  }

  get names(): string[] {
    return [...this.tools.values()].filter((tool) => tool.advertise !== false).map((tool) => tool.name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  async execute(call: ToolCall, round: number): Promise<ToolExecution> {
    const tool = this.tools.get(call.function.name);
    this.beforeCall(tool);
    if (!tool?.run) return { tool: call.function.name, text: `Error: there is no tool named ${call.function.name}.`, terminal: false };
    const run = tool.run;
    const effect = () => run(call, round);
    const text = tool.deferredActivity ? await effect() : await this.perform(tool.name, effect);
    return { tool: tool.name, text, terminal: tool.terminal };
  }

  /** The same lifecycle for an already-confirmed effect, without asking the tool's question again. */
  async perform(name: string, effect: () => Promise<string>, label?: string): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool?.run) throw new Error(`No local tool: ${name}`);
    this.activity(tool, true, label);
    try {
      return await effect();
    } finally {
      this.activity(tool, false, label);
    }
  }

  respond(text: string, round: number): Promise<ToolExecution> {
    if (!this.responseTool) throw new AgentError("noText");
    return this.execute({ id: "assistant-reply", function: { name: this.responseTool.name, arguments: JSON.stringify({ text }) } }, round);
  }

  serverEvent(event: ServerToolEvent): void {
    const tool = this.tools.get(event.tool);
    if (tool && !tool.run) this.activity(tool, event.running, event.label ?? undefined);
  }
}
