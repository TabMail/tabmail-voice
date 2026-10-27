// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "vitest";
import type { ChatTurn } from "../../../src/core/agent/chat.js";
import { CompletionsClient } from "../../../src/core/backend/completions.js";
import * as config from "../../../src/core/config.js";
import { configureLog, type LogLevel } from "../../../src/core/log.js";
import { KBRefiner } from "../../../src/core/personalization/kbRefine.js";
import { KBTools } from "../../../src/core/personalization/kbTools.js";
import { UserPrompts } from "../../../src/core/personalization/prompts.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";
import { Fixtures, signedIn, StubTransport } from "../../support/stubs.js";

const kbKey = "user_prompts:user_kb.md";
/** User text no diagnostic may carry: in what is kept, what the tools are asked, the chat and the refine's reply. */
const kept = "Works with Quillon";
const asked = "Plays the oboe at Brightwater";
const said = "Request about Marrowfield";
const learned = "Lives near Ostervale";

class FailingStore extends MemoryStore {
  failing = false;

  override set(key: string, value: unknown): boolean {
    super.set(key, value);
    return !this.failing;
  }

  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    super.setAll(values);
    return !this.failing;
  }
}

afterEach(() => {
  configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
});

/** The knowledge base is user content: with debug logging on, the debug and error lines say what
 * happened (lengths, outcomes, error names), and only the content channel may carry its text
 * (ADR-DESK-015). */
describe("knowledge-base diagnostics", () => {
  test("the debug and error logs never carry the knowledge base, a statement or the chat", async () => {
    const lines: { level: LogLevel | "error sink"; text: string }[] = [];
    configureLog({
      isDebugBuild: true,
      sinks: {
        file: (level, text) => lines.push({ level, text }),
        error: (text) => lines.push({ level: "error sink", text }),
      },
    });
    const store = new FailingStore({ [kbKey]: `- ${kept}.` });
    const prompts = new UserPrompts(store);
    const tools = new KBTools(prompts);
    const run = (name: string, statement: string) => tools.run(name, { statement });

    // Edits from Settings, saved and not.
    expect(prompts.editKnowledgeBase([`${kept}.`], [`${kept}.`, `${asked}.`])).toBe(true);
    store.failing = true;
    expect(prompts.editKnowledgeBase([`${kept}.`, `${asked}.`], [`${kept}.`])).toBe(false);
    expect(run("kb_add", `${asked} again`)).toContain("error");
    store.failing = false;

    // The tools, each outcome.
    expect(run("kb_add", `${asked} twice`)).toBe(JSON.stringify("Added to knowledge base."));
    expect(run("kb_add", `${asked} twice`)).toBe(JSON.stringify("No change (duplicate or unchanged)."));
    expect(run("kb_del", `[Pinned] ${asked} twice`)).toBe(JSON.stringify("Removed from knowledge base."));
    expect(run("kb_del", `${asked} never kept`)).toContain("error");

    // A refine that learns something, and one that fails.
    const completions = new StubTransport();
    const client = new CompletionsClient("https://api.example.com", "v", completions.transport);
    const chat: ChatTurn[] = Array.from({ length: config.kbRefineMinUserTurns }, (_, id) => ({ id, request: `${said} ${id}`, tool: "answer" as const, reply: `Reply ${id}`, questions: [] }));
    completions.enqueue(200, Fixtures.completionsStream(JSON.stringify({ assistant: "", refined_kb: `${prompts.knowledgeBase}\n- ${learned}.` })));
    await new KBRefiner(prompts).refine(chat, client, signedIn(), Fixtures.userID);
    expect(prompts.knowledgeBase).toContain(learned);
    completions.enqueue(500, "{}");
    await new KBRefiner(prompts).refine(chat, client, signedIn(), Fixtures.userID);

    // What happened was logged, so the check below is not of an empty log.
    const diagnostics = lines.filter(({ level }) => level !== "CONTENT");
    expect(diagnostics.some(({ text }) => text.startsWith("UserPrompts: kb saved"))).toBe(true);
    expect(diagnostics.some(({ text }) => text === "UserPrompts: couldn't be saved")).toBe(true);
    expect(diagnostics.some(({ text }) => text.startsWith("KBTools: kb_del found nothing"))).toBe(true);
    expect(diagnostics.some(({ text }) => text.startsWith("KBRefiner: refine failed"))).toBe(true);
    expect(lines.some(({ level, text }) => level === "CONTENT" && text.includes(said))).toBe(true);
    for (const words of [kept, asked, said, learned]) {
      expect(diagnostics.filter(({ text }) => text.includes(words)), words).toEqual([]);
    }
  });
});
