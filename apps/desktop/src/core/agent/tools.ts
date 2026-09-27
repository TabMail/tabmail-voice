// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../config.js";
import type { ScreenContext } from "../screenContext.js";
import { trimWhitespace } from "../text.js";
import type { ThunderbirdRelay } from "./thunderbirdRelay.js";

/**
 * What agent mode can do with a spoken request: the registry of its tools, as the Thunderbird
 * add-on's `chat/tools/core.js` and the iOS app's `AgentToolRouter` are for theirs. The name is the
 * one the agent answers with; a tool that hands the request to another app goes through that app's
 * connector (ADR-DESK-020). Each tool is one backend prompt; its bubble shows above the pill while
 * agent mode listens, and its border circles while it runs. Edit and Compose are never offered
 * together: the selection decides which (`DesktopAgent.writingTool`).
 */
export type AgentTool = "edit" | "compose" | "thunderbird";

export const agentTools: readonly AgentTool[] = ["edit", "compose", "thunderbird"];

export function isAgentTool(name: string): name is AgentTool {
  return (agentTools as readonly string[]).includes(name);
}

/** Why a request could not be carried out, as the overlay says it. */
export type AgentFailureKind = "noTool" | "noText" | "appChanged";

export class AgentFailure extends Error {
  constructor(readonly kind: AgentFailureKind) {
    super(
      kind === "noTool" ? "Couldn't work out what to do. Try again."
        : kind === "noText" ? "Couldn't write that. Try again."
          : "You switched apps, so nothing was pasted.",
    );
    this.name = "AgentFailure";
  }

  get description(): string {
    return `AgentFailure.${this.kind}`;
  }
}

/** What a tool delivers its text with, for one agent request. */
export interface ToolContext {
  /** The email app mail and calendar requests go to, resolved from the settings the dictation
   * started with (ADR-DESK-017); null when there is none. */
  emailApp: string | null;
  /** Pastes into the focused field. */
  paste(text: string): Promise<void>;
  /** Whether the app in front at key-down still is. */
  isTargetAppFrontmost(): Promise<boolean>;
  thunderbird: ThunderbirdRelay;
  signal: AbortSignal;
}

/** Pastes `text` into the app the user spoke over. The request may have taken long enough for the
 * user to move on: the text belongs in that app, and is pasted nowhere else. */
async function pasteIntoTargetApp(text: string, context: ToolContext): Promise<void> {
  if (!(await context.isTargetAppFrontmost())) throw new AgentFailure("appChanged");
  // Cancelled while the app in front was read (the Swift app reads it synchronously): the text is
  // no longer wanted anywhere.
  if (context.signal.aborted) return;
  await context.paste(text);
}

/** One of agent mode's tools: the backend prompt that writes its text from the spoken request and
 * the screen, and where that text goes. */
export interface DesktopTool {
  displayName: string;
  /** The icon shown in the tool's bubble (an SF Symbol name on macOS), unless it shows the app's
   * icon (Thunderbird's). */
  symbolName: string;
  /** The backend prompt that writes the tool's text. */
  prompt: string;
  /** The prompt's variables. Every variable is sent, empty when unknown: the backend leaves a
   * missing one in the prompt as written. */
  variables(request: string, context: ScreenContext | null): Record<string, string>;
  /** The text the prompt wrote (trimmed, not empty), ready to deliver. */
  fitted(text: string, context: ScreenContext | null): string;
  /** Puts the text where the tool puts it. Throws when it can't, and then nothing is put anywhere. */
  deliver(text: string, context: ToolContext): Promise<void>;
}

/** The selected text read at key-down; empty when nothing is selected or it could not be read. */
export function selection(context: ScreenContext | null): string {
  const selected = context?.selectedText ?? "";
  return trimWhitespace(selected) === "" ? "" : selected;
}

/** The variables every tool's prompt gets: the request, the app, and the screen read at key-down. */
export function screenVariables(request: string, context: ScreenContext | null): Record<string, string> {
  return {
    app_name: context?.appName ?? "",
    web_host: context?.host ?? "",
    window_title: context?.windowTitle ?? "",
    screen_text: context?.renderedText ?? "",
    selected_text: selection(context),
    user_request: request,
  };
}

/** Leading and trailing blank space, as `trimWhitespace` has it. */
const leadingSpace = /^[\s\u0085]*/;
const trailingSpace = /[\s\u0085]*$/;

/** Rewrites the selected text in place, as asked; offered only when text is selected. */
export const EditTool = {
  displayName: "Edit",
  symbolName: "pencil",
  prompt: config.agentEditPrompt,
  variables: screenVariables,

  /** With the selection's own leading and trailing blank space, so replacing a whole line keeps its
   * line break. */
  fitted(text: string, context: ScreenContext | null): string {
    return EditTool.fittedToSelection(text, selection(context));
  },

  /** Pastes over the selection, which the non-activating overlay leaves in place. */
  deliver: pasteIntoTargetApp,

  /** `text` with the leading and trailing blank space of `selection` in place of its own. */
  fittedToSelection(text: string, selection: string): string {
    const leading = leadingSpace.exec(selection)?.[0] ?? "";
    // A selection of only blank space has it all as leading space; nothing is left to trail.
    const trailing = leading.length === selection.length ? "" : (trailingSpace.exec(selection)?.[0] ?? "");
    return leading + trimWhitespace(text) + trailing;
  },
} satisfies DesktopTool & { fittedToSelection(text: string, selection: string): string };

/** Writes new text at the caret, as asked; offered only when nothing is selected. */
export const ComposeTool: DesktopTool = {
  displayName: "Compose",
  symbolName: "square.and.pencil",
  prompt: config.agentComposePrompt,

  /** The screen, plus the program running in a terminal, so a command comes out as that program
   * takes it. */
  variables(request, context) {
    return { ...screenVariables(request, context), terminal_program: context?.terminalProgram ?? "" };
  },

  fitted: (text) => text,

  /** Pastes at the caret. */
  deliver: pasteIntoTargetApp,
};

/** Sends a mail or calendar request, restated as a chat message, to TabMail's chat in Thunderbird;
 * offered only when there is an email app for it (ADR-DESK-014). */
export const ThunderbirdTool: DesktopTool = {
  displayName: "Thunderbird",
  symbolName: "envelope",
  prompt: config.agentThunderbirdPrompt,
  variables: screenVariables,
  fitted: (text) => text,

  /** Hands the message to the Thunderbird connector, for the email app the dictation started with.
   * Not held to the app in front at key-down: the relay brings Thunderbird to the front itself, and
   * has its own focus checks. */
  async deliver(text, context) {
    await context.thunderbird.send(text, context.emailApp, context.signal);
  },
};

export const toolImplementations: Record<AgentTool, DesktopTool> = {
  edit: EditTool,
  compose: ComposeTool,
  thunderbird: ThunderbirdTool,
};
