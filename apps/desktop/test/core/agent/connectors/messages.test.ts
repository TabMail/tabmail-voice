// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test } from "vitest";
import { ScriptError } from "../../../../src/core/agent/connectors/macos/appleScript.js";
import { ToolArgumentError } from "../../../../src/core/agent/connectors/contract.js";
import { isHandle, MessagesScripts, messagesConnector, MessagesSendTool } from "../../../../src/core/agent/connectors/macos/messages.js";
import * as config from "../../../../src/core/config.js";
import { FakeScriptRunner } from "../../../support/stubs.js";

/** Messages as the Answer prompt's tool, against a fake script runner: the script it runs and with
 * what, what the user is asked to confirm, and what the model reads back (from the Swift
 * `NotesMessagesToolsTests`). No test here runs a script; `osascript.test.ts` runs osascript on
 * scripts that tell no app. */

let runner: FakeScriptRunner;
const signal = new AbortController().signal;

beforeEach(() => {
  runner = new FakeScriptRunner();
});

describe("the connector", () => {
  test("Messages has messages_send", () => {
    expect(messagesConnector.tools({ scriptRunner: runner }).map((tool) => [tool.name, tool.connector])).toEqual([["messages_send", "messages"]]);
  });

  /** The script waits at most `appleScriptTimeoutSeconds` for the app. */
  test("the script bounds its wait", () => {
    expect(MessagesScripts.send).toContain(`with timeout of ${config.appleScriptTimeoutSeconds} seconds`);
  });
});

describe("messages_send", () => {
  /** The user is asked with the recipient and the text, and the message sent is that one, in the
   * request's run. */
  test("the confirmed message is sent", async () => {
    const tool = new MessagesSendTool(runner);
    const args = { to: "+1 (555) 010-0100", text: "Running late, there by 6." };

    const question = tool.confirmation(args);
    const result = await tool.run(args, signal);

    expect(question).toBe("Send this iMessage to +1 (555) 010-0100?\nRunning late, there by 6.");
    expect(runner.runs).toEqual([{ source: MessagesScripts.send, args: ["+1 (555) 010-0100", "Running late, there by 6."], signal }]);
    expect(result).toBe("Sent the iMessage to +1 (555) 010-0100.");
  });

  test.each(["+15550100", "555.010.0100", "(555) 010-0100", "sam@example.com"])("%j is a handle", (text) => {
    expect(isHandle(text)).toBe(true);
  });

  /** A phone number has at least phoneNumberMinDigits digits. */
  test("the fewest digits a phone number has", () => {
    expect(isHandle("5".repeat(config.phoneNumberMinDigits))).toBe(true);
    expect(isHandle("5".repeat(config.phoneNumberMinDigits - 1))).toBe(false);
  });

  test.each(["Sam", "555", "+1 555", "555-0100 ext 2", "1+5550100", "sam@example", ""])("%j is not a handle", (text) => {
    expect(isHandle(text)).toBe(false);
  });

  /** A message without a handle or text asks nothing and sends nothing; a name goes back to the model
   * to look up. */
  test.each([{ text: "Hi" }, { to: "sam@example.com" }, { to: "sam@example.com", text: " " }, { to: "Sam", text: "Hi" }])("%j sends nothing", async (args) => {
    const tool = new MessagesSendTool(runner);

    expect(tool.confirmation(args)).toBeNull();
    await expect(tool.run(args, signal)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(runner.runs).toEqual([]);
  });

  test("a name is sent back to look up", async () => {
    await expect(new MessagesSendTool(runner).run({ to: "Sam", text: "Hi" }, signal)).rejects.toEqual(
      new ToolArgumentError('to takes a phone number or email address, not "Sam": find it with contacts_search, or ask the user.'),
    );
  });

  /** A script's failure fails the send, so the model never says it was sent. */
  test("a failed send is not reported as sent", async () => {
    runner.failure = ScriptError.failed("execution error: Messages got an error (-1728)");

    await expect(new MessagesSendTool(runner).run({ to: "sam@example.com", text: "Hi" }, signal)).rejects.toThrow("Messages got an error");
  });
});
