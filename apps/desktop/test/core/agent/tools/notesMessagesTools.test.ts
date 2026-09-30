// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test } from "vitest";
import { type ScriptRunner, ScriptError } from "../../../../src/core/agent/connectors/appleScript.js";
import { ToolArgumentError } from "../../../../src/core/agent/tools/connectorTool.js";
import { isHandle, MessagesScripts, MessagesSendTool, messagesTools } from "../../../../src/core/agent/tools/messagesTools.js";
import { NotesCreateTool, NotesScripts, NotesSearchTool, notesTools } from "../../../../src/core/agent/tools/notesTools.js";
import * as config from "../../../../src/core/config.js";
import { LocalDateTime } from "../../../../src/core/util/localDateTime.js";

/** Notes and Messages as the Answer prompt's tools, against a fake script runner: the script each tool
 * runs and with what, what the user is asked to confirm, and what the model reads back (from the Swift
 * `NotesMessagesToolsTests`). No test here runs a script; `osascript.test.ts` runs osascript on
 * scripts that tell no app. */

/** Records each script run and answers with `result`, or fails with `failure`. */
class FakeScriptRunner implements ScriptRunner {
  result = "";
  failure: Error | null = null;
  readonly runs: { source: string; args: readonly string[]; signal: AbortSignal }[] = [];

  async run(source: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    this.runs.push({ source, args, signal });
    if (this.failure) throw this.failure;
    return this.result;
  }
}

let runner: FakeScriptRunner;
const signal = new AbortController().signal;

beforeEach(() => {
  runner = new FakeScriptRunner();
});

function record(...fields: string[]): string {
  return fields.join(NotesScripts.fieldSeparator);
}

/** `date` as the search script writes a note's last change: local time, to the second. */
function iso(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

describe("the connectors", () => {
  test("Notes has notes_search and notes_create, Messages messages_send", () => {
    expect(notesTools(runner).map((tool) => [tool.name, tool.connector])).toEqual([
      ["notes_search", "notes"],
      ["notes_create", "notes"],
    ]);
    expect(messagesTools(runner).map((tool) => [tool.name, tool.connector])).toEqual([["messages_send", "messages"]]);
  });
});

describe("the notes scripts", () => {
  /** Each note's four fields; a note missing one is left out, and a separator in the text stays in it. */
  test("the search result reads as notes", () => {
    const result = [record("Offsite", "Work", "2025-01-15T09:30:00", "Agenda\nRoom \u{1F} B"), record("Broken", "Work"), record("No text", "Work", "2025-01-15T09:30:00"), record("Undated", "Notes", "", "Text")].join(NotesScripts.noteSeparator);

    expect(NotesScripts.notes(result)).toEqual([
      { title: "Offsite", folder: "Work", changed: LocalDateTime.parse("2025-01-15T09:30:00")?.date, text: "Agenda\nRoom \u{1F} B" },
      { title: "Undated", folder: "Notes", changed: null, text: "Text" },
    ]);
    expect(NotesScripts.notes("")).toEqual([]);
  });

  /** The title is the note's heading and each line of the text its own line, shown as written. */
  test("the note body shows the text as written", () => {
    expect(NotesScripts.html("Q&A <draft>", 'Line "one"\r\n\nLine 3 > 2\rEnd')).toBe(
      "<div><h1>Q&amp;A &lt;draft&gt;</h1></div><div>Line &quot;one&quot;</div><div><br></div><div>Line 3 &gt; 2</div><div>End</div>",
    );
  });

  /** The scripts wait at most `appleScriptTimeoutSeconds` for the app. */
  test.each([NotesScripts.search, NotesScripts.create, MessagesScripts.send])("each script bounds its wait: %#", (source) => {
    expect(source).toContain(`with timeout of ${config.appleScriptTimeoutSeconds} seconds`);
  });
});

describe("notes_search", () => {
  /** The matches, newest first, each with its folder, last change and full text; nothing is asked. */
  test("the matching notes are read newest first", async () => {
    const now = new Date();
    const dayAgo = LocalDateTime.addingDays(now, -1);
    runner.result = [record("Older", "Work", iso(dayAgo), "First"), record("Undated", "Notes", "", "Middle"), record("Newer", "Work", iso(now), "Second\nline")].join(NotesScripts.noteSeparator);
    const tool = new NotesSearchTool(runner);

    const result = await tool.run({ query: " Offsite " }, signal);

    expect(runner.runs).toEqual([{ source: NotesScripts.search, args: ["Offsite"], signal }]);
    expect(tool.confirmation()).toBeNull();
    expect(result).toBe(
      [
        'Notes matching "Offsite", newest first:',
        `"Newer" (Work, changed ${LocalDateTime.describe(now)}):\nSecond\nline`,
        `"Older" (Work, changed ${LocalDateTime.describe(dayAgo)}):\nFirst`,
        '"Undated" (Notes):\nMiddle',
      ].join("\n\n"),
    );
  });

  test("no match says so", async () => {
    expect(await new NotesSearchTool(runner).run({ query: "offsite" }, signal)).toBe('No notes match "offsite".');
  });

  /** A search matching more than the model is shown stops at the newest ones and says there are more. */
  test("a search matching many is cut short and says so", async () => {
    const limit = config.notesSearchMaxResults;
    const now = new Date();
    runner.result = Array.from({ length: limit + 1 }, (_, index) => record(`Note ${index}`, "Notes", iso(new Date(now.getTime() - index * 60_000)), "Text"))
      .reverse()
      .join(NotesScripts.noteSeparator);

    const result = await new NotesSearchTool(runner).run({ query: "note" }, signal);

    const shown = result.split("\n\n").slice(1, -1);
    expect(shown.map((section) => section.split(" (")[0])).toEqual(Array.from({ length: limit }, (_, index) => `"Note ${index}"`));
    expect(result).not.toContain(`"Note ${limit}"`);
    expect(result.endsWith("(1 more notes match; search with more of the words.)")).toBe(true);
  });

  test("a search matching exactly the most is not cut short", async () => {
    const limit = config.notesSearchMaxResults;
    const now = new Date();
    runner.result = Array.from({ length: limit }, (_, index) => record(`Note ${index}`, "Notes", iso(new Date(now.getTime() - index * 60_000)), "Text")).join(NotesScripts.noteSeparator);

    const result = await new NotesSearchTool(runner).run({ query: "note" }, signal);

    expect(result.split("\n\n").slice(1).map((section) => section.split(" (")[0])).toEqual(Array.from({ length: limit }, (_, index) => `"Note ${index}"`));
    expect(result).not.toContain("more notes match");
  });

  test("a search without a query runs nothing", async () => {
    await expect(new NotesSearchTool(runner).run({ query: " " }, signal)).rejects.toEqual(ToolArgumentError.missing("query"));
    expect(runner.runs).toEqual([]);
  });

  /** Notes' refusal reaches the model as it was thrown, so the user hears where to allow it. */
  test("a refusal is passed on", async () => {
    runner.failure = ScriptError.noAccess("Notes");

    await expect(new NotesSearchTool(runner).run({ query: "offsite" }, signal)).rejects.toThrow("TabMail Voice can't use Notes. Allow it in System Settings › Privacy & Security › Automation.");
  });
});

describe("notes_create", () => {
  /** The user is asked with the note's title and text, and the note added is that one, in the
   * request's run. */
  test("the confirmed note is added", async () => {
    runner.result = record("Groceries", "Notes");
    const tool = new NotesCreateTool(runner);
    const args = { title: "Groceries", body: "Milk\nEggs" };

    const question = tool.confirmation(args);
    const result = await tool.run(args, signal);

    expect(question).toBe("Add this note?\nGroceries\nMilk\nEggs");
    expect(runner.runs).toEqual([{ source: NotesScripts.create, args: [NotesScripts.html("Groceries", "Milk\nEggs")], signal }]);
    expect(result).toBe('Added the note "Groceries" in the Notes folder.');
  });

  /** A note without a title or text asks nothing and adds nothing. */
  test.each([{ body: "Milk" }, { title: "Groceries" }, { title: "Groceries", body: " \n" }, { title: 7, body: "Milk" }])("%j adds nothing", async (args) => {
    const tool = new NotesCreateTool(runner);

    expect(tool.confirmation(args)).toBeNull();
    await expect(tool.run(args, signal)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(runner.runs).toEqual([]);
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

describe("a script's failure", () => {
  /** When macOS refuses the Apple Event (-1743), the error names the app the script tells and where to
   * allow it; any other error is osascript's, trimmed. */
  test.each([
    ["execution error: Not authorized to send Apple events to Notes. (-1743)", 'tell application "Notes"', "TabMail Voice can't use Notes. Allow it in System Settings › Privacy & Security › Automation.", "Notes"],
    ["execution error: Not authorized (-1743)\n", "return 1", "execution error: Not authorized (-1743)", null],
    ["  execution error: Example failure (-2700)\n", 'tell application "Notes"', "execution error: Example failure (-2700)", null],
  ])("%j", (errors, source, message, deniedApp) => {
    const failure = ScriptError.from(errors, source);

    expect(failure.message).toBe(message);
    expect(failure.deniedApp).toBe(deniedApp);
  });
});
