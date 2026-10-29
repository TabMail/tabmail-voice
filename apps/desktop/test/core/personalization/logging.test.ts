// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "vitest";
import { configureLog, type LogLevel } from "../../../src/core/log.js";
import { KBTools } from "../../../src/core/personalization/kbTools.js";
import { UserPrompts } from "../../../src/core/personalization/prompts.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";

const kbKey = "user_prompts:user_kb.md";
/** User text no diagnostic may carry: in what is kept and what the tools are asked. */
const kept = "Works with Quillon";
const asked = "Plays the oboe at Brightwater";

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
  test("the debug and error logs never carry the knowledge base or a statement", () => {
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
    const tools = new KBTools(prompts, prompts.captureKnowledgeBase());
    const run = (name: string, statement: string) => tools.run(name, { statement });

    // Edits from Settings, saved and not.
    expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), [`${kept}.`, `${asked}.`])).toBe(true);
    store.failing = true;
    expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), [`${kept}.`])).toBe(false);
    expect(run("kb_add", `${asked} again`)).toContain("error");
    store.failing = false;

    // The tools, each outcome.
    expect(run("kb_add", `${asked} twice`)).toBe(JSON.stringify("Added to knowledge base."));
    expect(run("kb_add", `${asked} twice`)).toBe(JSON.stringify("No change (duplicate or unchanged)."));
    expect(run("kb_del", `[Pinned] ${asked} twice`)).toBe(JSON.stringify("Removed from knowledge base."));
    expect(run("kb_del", `${asked} never kept`)).toContain("error");

    // Device Sync: a merge, a refused snapshot (a label holding another text), a malformed one.
    const snapshot = (bullets: unknown[], snap: string) => ({ type: "bullet_state", v: 1, field: "kb", sender: "ffffffffffffffff", snap, part: 1, parts: 1, bullets, seen: { ffffffff00000001: 1 } });
    expect(prompts.sync.receive(snapshot([["", `${asked} from a peer`, "ffffffff00000001", 1]], "1"))).toMatchObject({ kind: "merged" });
    expect(prompts.sync.receive(snapshot([["", `${kept} reworded`, "ffffffff00000001", 1]], "2"))).toMatchObject({ kind: "conflict" });
    expect(prompts.sync.receive(snapshot([["", ` ${kept}`, "ffffffff00000001", 2]], "3"))).toMatchObject({ kind: "invalid" });

    // What happened was logged, so the check below is not of an empty log.
    const diagnostics = lines.filter(({ level }) => level !== "CONTENT");
    expect(diagnostics.some(({ text }) => text.startsWith("UserPrompts: kb saved"))).toBe(true);
    expect(diagnostics.some(({ text }) => text === "UserPrompts: couldn't be saved")).toBe(true);
    expect(diagnostics.some(({ text }) => text.startsWith("KBTools: kb_del found nothing"))).toBe(true);
    expect(diagnostics.some(({ text }) => text.startsWith("DeviceSync: kb refused"))).toBe(true);
    expect(diagnostics.some(({ text }) => text.startsWith("DeviceSync: a kb snapshot dropped"))).toBe(true);
    for (const words of [kept, asked]) {
      expect(diagnostics.filter(({ text }) => text.includes(words)), words).toEqual([]);
    }
  });
});
