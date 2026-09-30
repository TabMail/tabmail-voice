// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../config.js";
import type { ScriptRunner } from "../connectors/appleScript.js";
import { isAddress } from "./emailTools.js";
import { Arguments, type LoopTool, LoopToolArgumentError } from "./loopTool.js";

/** The AppleScript behind `messages_send` (ADR-DESK-028), which takes its values as arguments
 * (`ScriptRunner`). */
export const MessagesScripts = {
  /** Sends `argv[2]` as an iMessage to the handle `argv[1]` (a phone number or email address). */
  send: `on run argv
    with timeout of ${config.appleScriptTimeoutSeconds} seconds
        tell application "Messages"
            set theAccount to 1st account whose service type = iMessage
            send (item 2 of argv) to participant (item 1 of argv) of theAccount
        end tell
    end timeout
end run`,
};

/** Whether `text` is a handle iMessage reaches: an email address, or a phone number (digits, with at
 * most a leading `+`, spaces, dashes, dots and brackets). */
export function isHandle(text: string): boolean {
  if (isAddress(text)) return true;
  if (!/^\+?[0-9 ()\-.]+$/.test(text)) return false;
  return (text.match(/[0-9]/g) ?? []).length >= config.phoneNumberMinDigits;
}

/** The Messages connector's tool. */
export function messagesTools(runner: ScriptRunner): LoopTool[] {
  return [new MessagesSendTool(runner)];
}

/** Sends an iMessage from Messages (`messages_send`), once the user confirms the recipient and text
 * the chat window shows: the question and the message come from the same draft. */
export class MessagesSendTool implements LoopTool {
  readonly name = "messages_send";
  readonly connector = "messages";
  readonly progressLabel = "Sending the message";

  constructor(private readonly runner: ScriptRunner) {}

  /** Null only for arguments `run` rejects before sending anything. */
  confirmation(args: Record<string, unknown>): string | null {
    let draft: { to: string; text: string };
    try {
      draft = MessagesSendTool.draft(args);
    } catch {
      return null;
    }
    return `Send this iMessage to ${draft.to}?\n${draft.text}`;
  }

  async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const draft = MessagesSendTool.draft(args);
    await this.runner.run(MessagesScripts.send, [draft.to, draft.text], signal);
    return `Sent the iMessage to ${draft.to}.`;
  }

  /** The recipient, one phone number or email address (a name goes back to the model to look up),
   * and the text. */
  static draft(args: Record<string, unknown>): { to: string; text: string } {
    const to = Arguments.text(args, "to");
    if (to === null) throw LoopToolArgumentError.missing("to");
    if (!isHandle(to)) throw new LoopToolArgumentError(`to takes a phone number or email address, not "${to}": find it with contacts_search, or ask the user.`);
    const text = Arguments.text(args, "text");
    if (text === null) throw LoopToolArgumentError.missing("text");
    return { to, text };
  }
}
