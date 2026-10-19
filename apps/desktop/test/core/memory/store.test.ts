// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { agentPart, memoryDate, memoryExchange, memoryRow, memorySessionID } from "../../../src/core/memory/store.js";

/** The rows memory keeps, shaped as Thunderbird's chat memory rows, so its search helper and its
 * memory tools read them as their own. */
describe("memory rows", () => {
  /** What the agent did: the reply as said, or the text written with where it went. */
  test("the agent's part is the reply, or the text with where it went", () => {
    expect(agentPart("answer", "It is sunny.", "Answered", "Mail")).toBe("It is sunny.");
    expect(agentPart("compose", "Dear team,\nThanks.", "Pasted at the cursor", "Mail")).toBe("Pasted at the cursor in Mail:\nDear team,\nThanks.");
    expect(agentPart("edit", "Fixed text", "Replaced the selection", null)).toBe("Replaced the selection:\nFixed text");
    expect(agentPart("compose", "Draft", null, "Mail")).toBe("Draft");
  });

  test("a row holds the request and the agent's part, filed under Voice's one session", () => {
    const dateMs = Date.now();
    expect(memoryRow("what's the weather", "It is sunny.", dateMs, "abc")).toEqual({
      memId: "turn:abc",
      role: "session",
      content: "[USER]: what's the weather\n\n[AGENT]: It is sunny.",
      sessionId: memorySessionID,
      turnIndex: 0,
      dateMs,
    });
  });

  /** Settings splits a row back into its two parts; text holding blank lines stays whole. */
  test("a row's content splits back into the request and the agent's part", () => {
    const request = "write to the team\n\nabout Friday";
    const agent = "Pasted at the cursor:\nHi all,\n\n[USER]: not a marker here";
    expect(memoryExchange(memoryRow(request, agent, Date.now(), "x").content)).toEqual({ request, agent });
    expect(memoryExchange("a row written by something else")).toEqual({ request: "", agent: "a row written by something else" });
  });

  test("a date shows as month, day, year and time; no date shows nothing", () => {
    expect(memoryDate(Date.now())).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}\s(AM|PM)$/);
    expect(memoryDate(0)).toBe("");
  });
});
