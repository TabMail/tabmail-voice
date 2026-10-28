// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ScreenContext } from "../dictation/screenContext.js";
import { trimWhitespace } from "../util/text.js";
import type { ThunderbirdRelay } from "./connectors/thunderbird/relay.js";

/**
 * Where agent mode's text goes: the writing tools, Edit and Compose, the backend loop's only way to
 * paste (its `edit` and `compose` tools); Answer, the chat window its replies go to; and Thunderbird's
 * chat relay. A tool that hands the request to another app goes through that app's connector
 * (ADR-DESK-020). Each tool's bubble shows above the pill while agent mode listens, and its border
 * circles while it runs. Edit and Compose are never offered together: the selection decides which
 * (each definition's `available`). Edit and Compose (`switchableAgentToolIDs`) can be switched off in
 * Settings and the welcome wizard, and are on by default (owner, 2026-09-26). Answer has no switch and
 * is always offered (owner, 2026-10-27: "I don't think it should even exist"), so every request has
 * somewhere to go.
 */
export type AgentToolID = "edit" | "compose" | "thunderbird" | "answer";

export const agentToolIDs: readonly AgentToolID[] = ["edit", "compose", "thunderbird", "answer"];

/** The tools agent mode offers, and Settings and the welcome wizard list. Thunderbird's is left out
 * until the native connector to TabMail's add-on replaces its chat relay (owner, 2026-09-29: "right
 * now it's just clunky"), so the other tools can be tried without it; its code stays for that
 * connector (ADR-DESK-037). Offering it here again brings it back everywhere. */
export const offeredAgentToolIDs: readonly AgentToolID[] = agentToolIDs.filter((tool) => tool !== "thunderbird");

/** The offered tools the user can switch off, which Settings and the welcome wizard list: all but
 * Answer, which is always on. */
export const switchableAgentToolIDs: readonly AgentToolID[] = offeredAgentToolIDs.filter((tool) => tool !== "answer");

export function isAgentToolID(name: unknown): name is AgentToolID {
  return typeof name === "string" && (agentToolIDs as readonly string[]).includes(name);
}

/** Why a request could not be carried out, as the overlay says it. */
export type AgentErrorKind = "noText" | "secretInSelection";

const failureMessages: Record<AgentErrorKind, string> = {
  noText: "Couldn't write that. Try again.",
  /** The selection reached the app with secret-looking text taken out (ADR-DESK-046): a rewrite of
   * it, pasted over the selection, would put the placeholder where the secret was. */
  secretInSelection: "The selection holds what looks like a password or key, so it wasn't rewritten.",
};

export class AgentError extends Error {
  constructor(readonly kind: AgentErrorKind) {
    super(failureMessages[kind]);
    this.name = "AgentError";
  }

  get description(): string {
    return `AgentError.${this.kind}`;
  }
}

/** What a tool delivers its text with, for one agent request. */
export interface ToolContext {
  /** The email app mail and calendar requests go to, resolved from the settings the dictation
   * started with (ADR-DESK-017); null when there is none. */
  emailApp: string | null;
  /** Pastes into the app the user spoke over. When the user has gone to another app, it pastes nothing
   * and throws, the text kept for its note to copy when clicked (ADR-DESK-042). */
  paste(text: string): Promise<void>;
  thunderbird: ThunderbirdRelay;
  /** Shows a reply in the chat window, opening it if it is closed. */
  showAnswer(text: string): void;
  signal: AbortSignal;
}

/** Pastes `text` into the app the user spoke over. The request may have taken long enough for the user
 * to move on: the text belongs in that app, and is pasted nowhere else (`ToolContext.paste`). */
async function pasteIntoTargetApp(text: string, context: ToolContext): Promise<void> {
  await context.paste(text);
}

/** One of agent mode's tools: where the text the backend loop wrote goes. */
export interface AgentTool {
  /** Whether a completed handler ends this request. */
  terminal: boolean;
  /** A normal assistant reply is routed through this definition. */
  response?: boolean;
  closesChat: boolean;
  available(context: ScreenContext | null): boolean;
  /** Validate and fit model arguments before performing any delivery. */
  text(args: unknown, context: ScreenContext | null): string;
  displayName: string;
  /** The icon shown in the tool's bubble (an SF Symbol name on macOS), unless it shows the app's
   * icon (Thunderbird's). */
  symbolName: string;
  /** What the tool does, under its switch in Settings and the welcome wizard. */
  settingsDescription: string;
  /** What the tool did with its text, shown over it in the chat window; null for Answer, whose text
   * is the reply itself. */
  chatCaption: string | null;
  /** Puts the text where the tool puts it. Throws when it can't: then nothing is pasted, though Edit's
   * and Compose's text goes into the paste history and the note that copies it (ADR-DESK-042). */
  deliver(text: string, context: ToolContext): Promise<void>;
}

/** The selected text read at key-down; empty when nothing is selected or it could not be read. */
export function selection(context: ScreenContext | null): string {
  const selected = context?.selectedText ?? "";
  return trimWhitespace(selected) === "" ? "" : selected;
}

/** What the helpers put in place of text they don't give (`placeholder` in
 * `native/shared/privacy/redactors.json`). */
export const redactionPlaceholder = "[redacted]";

/** What the prompt gets as the selected text when the helper gave none of the selection, only the
 * placeholder (it could not read it, or all of it looked like a secret): that in words, so the model
 * doesn't take the placeholder for text the user selected. */
export const selectionUnreadNote = "[Not read: the user may have selected text here, but it is hidden for privacy or could not be read.]";

/** The selection as the prompt gets it: `selection`, or `selectionUnreadNote` when only the
 * placeholder came. */
export function selectedTextVariable(context: ScreenContext | null): string {
  const selected = selection(context);
  return context?.selectionRedacted === true && trimWhitespace(selected) === redactionPlaceholder ? selectionUnreadNote : selected;
}

/** What the prompt gets as the screen's text when the screen was not read for the user's
 * privacy (`ScreenHidden`): that it is hidden, so the model does not take the screen for empty, or
 * for the one an earlier request in the conversation was about. */
export const screenHiddenNote =
  "[Hidden for privacy: the user keeps the app or website now in front out of screen reading, so nothing on screen was read. " +
  "The user is no longer on any screen the conversation so far was about.]";

/** The prompt's variables for the screen: the request, the app, and the screen read at key-down
 * (`screenHiddenNote` in its place when it was hidden: there is no `context` then). */
export function screenVariables(request: string, context: ScreenContext | null, screenHidden: boolean): Record<string, string> {
  return {
    app_name: context?.appName ?? "",
    web_host: context?.host ?? "",
    window_title: context?.windowTitle ?? "",
    screen_text: screenHidden ? screenHiddenNote : (context?.renderedText ?? ""),
    selected_text: selectedTextVariable(context),
    user_request: request,
  };
}

/** Leading and trailing blank space, as `trimWhitespace` has it. */
const leadingSpace = /^[\s\u0085]*/;
const trailingSpace = /[\s\u0085]*$/;

/** Writes in place of the selected text, as asked; offered only when text is selected. */
export const EditTool = {
  terminal: true,
  closesChat: true,
  available: (context: ScreenContext | null) => selection(context) !== "",
  text(args: unknown, context: ScreenContext | null): string {
    if (context?.selectionRedacted === true) throw new AgentError("secretInSelection");
    return EditTool.fittedToSelection(outputText(args), selection(context));
  },
  displayName: "Edit",
  symbolName: "pencil",
  settingsDescription: "Rewrites the text you selected, as you ask: friendlier, shorter, translated, fixed.",
  chatCaption: "Replaced the selection",

  /** Pastes over the selection, which the non-activating overlay leaves in place. */
  deliver: pasteIntoTargetApp,

  /** `text` with the leading and trailing blank space of `selection` in place of its own. */
  fittedToSelection(text: string, selection: string): string {
    const leading = leadingSpace.exec(selection)?.[0] ?? "";
    // A selection of only blank space has it all as leading space; nothing is left to trail.
    const trailing = leading.length === selection.length ? "" : (trailingSpace.exec(selection)?.[0] ?? "");
    return leading + trimWhitespace(text) + trailing;
  },
} satisfies AgentTool & { fittedToSelection(text: string, selection: string): string };

/** Writes new text at the caret, as asked; offered only when nothing is selected. */
export const ComposeTool: AgentTool = {
  terminal: true,
  closesChat: true,
  available: (context) => selection(context) === "",
  text: (args) => outputText(args),
  displayName: "Compose",
  symbolName: "square.and.pencil",
  settingsDescription: "Writes new text where your cursor is: a reply, a message, a note, a command.",
  chatCaption: "Pasted at the cursor",

  /** Pastes at the caret. */
  deliver: pasteIntoTargetApp,
};

/** Sends a mail or calendar request, restated as a chat message, to TabMail's chat in Thunderbird
 * (ADR-DESK-014). Never offered: the backend loop has no tool for it until the native connector to
 * TabMail's add-on replaces this relay (ADR-DESK-037). */
export const ThunderbirdTool: AgentTool = {
  terminal: true,
  closesChat: true,
  available: () => false,
  text: (args) => outputText(args),
  displayName: "Thunderbird",
  symbolName: "envelope",
  settingsDescription: "Sends mail and calendar requests to TabMail’s chat in Thunderbird.",
  chatCaption: "Sent to TabMail in Thunderbird",

  /** Hands the message to the Thunderbird connector, for the email app the dictation started with.
   * Not held to the app in front at key-down: the relay brings Thunderbird to the front itself, and
   * has its own focus checks. */
  async deliver(text, context) {
    await context.thunderbird.send(text, context.emailApp, context.signal);
  },
};

/** Answers the user in the chat window the pill grows into, when the loop replies rather than writes
 * into the app (a question, an explanation of what is on screen, a follow-up). Always on: through it
 * the loop also reaches the user's apps and the web. Its bubble runs, and its chat window opens,
 * only when the agent answers (owner, 2026-10-07). */
export const AnswerTool: AgentTool = {
  terminal: true,
  response: true,
  closesChat: false,
  available: () => true,
  text: (args) => outputText(args),
  displayName: "Answer",
  symbolName: "text.bubble",
  settingsDescription: "Answers you in a chat window beside the app. Hold the key again while it’s open to follow up: your earlier requests and its replies go with the follow-up.",
  chatCaption: null,

  /** Shows the reply in the chat window, whatever app is in front: it is not pasted anywhere. */
  async deliver(text, context) {
    context.showAnswer(text);
  },
};

export const agentTools: Record<AgentToolID, AgentTool> = {
  edit: EditTool,
  compose: ComposeTool,
  thunderbird: ThunderbirdTool,
  answer: AnswerTool,
};

/** Output tools accept one nonempty text argument before delivery. */
function outputText(args: unknown): string {
  const text = args !== null && typeof args === "object" && "text" in args && typeof args.text === "string" ? trimWhitespace(args.text) : "";
  if (text === "") throw new AgentError("noText");
  return text;
}
