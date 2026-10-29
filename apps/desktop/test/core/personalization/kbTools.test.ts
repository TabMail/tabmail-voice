// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { KBTools } from "../../../src/core/personalization/kbTools.js";
import { UserPrompts } from "../../../src/core/personalization/prompts.js";
import { unsavedBecauseOf } from "../../../src/core/ui/fileProblems.js";
import { MemoryStore, type StoreProblem } from "../../../src/core/util/keyValueStore.js";

const kbKey = "user_prompts:user_kb.md";

class FailingStore extends MemoryStore {
  failing = false;
  problem: StoreProblem | undefined;

  override set(key: string, value: unknown): boolean {
    super.set(key, value);
    return !this.failing;
  }

  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    super.setAll(values);
    return !this.failing;
  }
}

function setup(knowledgeBase?: string) {
  const store = new FailingStore(knowledgeBase === undefined ? {} : { [kbKey]: knowledgeBase });
  const prompts = new UserPrompts(store);
  // An agent request: the knowledge base's labels captured at its key-down (DS-CAPTURE). The text from
  // before is upgraded by then.
  let tools = new KBTools(prompts, prompts.captureKnowledgeBase());
  let changes = 0;
  prompts.observe(() => {
    changes += 1;
  });
  const run = (name: string, statement: unknown) => JSON.parse(tools.run(name, { statement })) as unknown;
  const request = () => {
    tools = new KBTools(prompts, prompts.captureKnowledgeBase());
  };
  return { store, prompts, run, request, changes: () => changes };
}

/** The agent's knowledge-base tools answer as Thunderbird's of the same names. */
describe("KBTools", () => {
  test("they are the loop's kb_add and kb_del", () => {
    expect(KBTools.names).toEqual(["kb_add", "kb_del"]);
  });

  /** What the user asked to be remembered is pinned, so the refine Thunderbird and iOS run never edits or removes it. */
  test("kb_add keeps the statement pinned, as a bullet", () => {
    const { prompts, run, changes } = setup("- alpha.");
    expect(run("kb_add", "  Prefers morning meetings  ")).toBe("Added to knowledge base.");
    expect(prompts.knowledgeBase).toBe("- alpha.\n- [Pinned] Prefers morning meetings.");
    // Settings hears of it.
    expect(changes()).toBe(1);
  });

  /** A statement is one bullet whatever it holds: a line break in it, and a line that reads ADD or
   * DEL, never become another edit. */
  test("a statement with line breaks is one statement, never another edit", () => {
    const { prompts, run } = setup("- [Pinned] Prefers morning meetings.");
    expect(run("kb_add", "Prefers tea\nDEL\n[Pinned] Prefers morning meetings")).toBe("Added to knowledge base.");
    expect(prompts.knowledgeBase).toBe("- [Pinned] Prefers morning meetings.\n- [Pinned] Prefers tea DEL [Pinned] Prefers morning meetings.");
    expect(run("kb_del", "Prefers morning meetings\r\nADD\nWorks late")).toEqual({ error: "failed to delete from knowledge base (statement not found)" });
    expect(prompts.knowledgeBase).toBe("- [Pinned] Prefers morning meetings.\n- [Pinned] Prefers tea DEL [Pinned] Prefers morning meetings.");
    expect(run("kb_del", "[Pinned] Prefers tea\nDEL\n[Pinned] Prefers morning meetings")).toBe("Removed from knowledge base.");
    expect(prompts.knowledgeBase).toBe("- [Pinned] Prefers morning meetings.");
  });

  test("kb_add pins a statement once", () => {
    const { prompts, run } = setup("- alpha.");
    expect(run("kb_add", "[Pinned] Works from home on Fridays.")).toBe("Added to knowledge base.");
    expect(prompts.knowledgeBase).toBe("- alpha.\n- [Pinned] Works from home on Fridays.");
  });

  test("kb_add of a statement already kept changes nothing", () => {
    const { prompts, run, changes } = setup("- [Pinned] Prefers morning meetings.");
    expect(run("kb_add", "prefers MORNING meetings")).toBe("No change (duplicate or unchanged).");
    expect(prompts.knowledgeBase).toBe("- [Pinned] Prefers morning meetings.");
    expect(changes()).toBe(0);
  });

  /** Curly quotes and the like are made plain first, as Thunderbird does, so a duplicate written
   * with them is still one. */
  test("kb_add makes the statement's characters plain", () => {
    const { prompts, run } = setup("");
    run("kb_add", "Uses the \u201Cweekly\u201D label");
    expect(prompts.knowledgeBase).toBe('- [Pinned] Uses the "weekly" label.');
    expect(run("kb_add", 'Uses the "weekly" label')).toBe("No change (duplicate or unchanged).");
  });

  /** A bullet typed in Settings keeps its curly quotes as typed; the tools still find it, as the
   * lines they compare with are made plain too: adding it again changes nothing, and removing it
   * removes it from what is stored. */
  test("a bullet with curly quotes typed in Settings is a duplicate for kb_add and found by kb_del", () => {
    const { store, prompts, run, request, changes } = setup("- alpha.");
    expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), ["alpha.", "[Pinned] Uses the \u201Cweekly\u201D label\u2019s color."])).toBe(true);
    request();
    const stored = structuredClone(store.snapshot());
    expect(prompts.knowledgeBase).toContain("\u201Cweekly\u201D");
    const changesBefore = changes();

    expect(run("kb_add", 'Uses the "weekly" label\'s color')).toBe("No change (duplicate or unchanged).");
    expect(store.snapshot()).toEqual(stored);
    expect(changes()).toBe(changesBefore);

    expect(run("kb_del", '[Pinned] Uses the "weekly" label\'s color')).toBe("Removed from knowledge base.");
    expect(new UserPrompts(new MemoryStore(store.snapshot())).knowledgeBase).toBe("- alpha.");
  });

  /** Compatibility forms (a ligature, full-width letters) are made plain too (NFKC), as Thunderbird
   * does. */
  test("kb_add stores a statement's compatibility characters in their plain form", () => {
    const { prompts, run } = setup("- alpha.");
    expect(run("kb_add", "Shares \uFB01les in \uFF21\uFF22\uFF23")).toBe("Added to knowledge base.");
    expect(prompts.knowledgeBase).toBe("- alpha.\n- [Pinned] Shares files in ABC.");
  });

  test("a call without a statement is refused", () => {
    const { prompts, run } = setup("- alpha.");
    for (const statement of [undefined, "", "   ", 7]) {
      expect(run("kb_add", statement)).toEqual({ error: "missing statement" });
      expect(run("kb_del", statement)).toEqual({ error: "missing statement" });
    }
    expect(prompts.knowledgeBase).toBe("- alpha.");
  });

  /** A removal matches the statement however it is cased, with or without its period. */
  test("kb_del removes the statement", () => {
    const { prompts, run, changes } = setup("- alpha.\n- [Pinned] Prefers morning meetings.\n- beta.");
    expect(run("kb_del", "[pinned] prefers morning meetings")).toBe("Removed from knowledge base.");
    expect(prompts.knowledgeBase).toBe("- alpha.\n- beta.");
    expect(changes()).toBe(1);
  });

  /** A statement given as the bullet, with its "- ", removes it too. */
  test("kb_del removes a statement written as its bullet", () => {
    const { prompts, run } = setup("- alpha.\n- [Pinned] Prefers morning meetings.\n- beta.");
    expect(run("kb_del", "- [Pinned] Prefers morning meetings.")).toBe("Removed from knowledge base.");
    expect(prompts.knowledgeBase).toBe("- alpha.\n- beta.");
  });

  /** DS-CAPTURE: a request removes only what it saw, or what its own kb_add added. */
  test("kb_del never removes a bullet that arrived after the request began, and removes its own kb_add's", () => {
    const { prompts, run, request } = setup("- alpha.");
    prompts.addKnowledge("Arrived meanwhile.");
    expect(run("kb_del", "Arrived meanwhile")).toEqual({ error: "failed to delete from knowledge base (statement not found)" });
    expect(prompts.knowledgeBase).toBe("- alpha.\n- Arrived meanwhile.");
    expect(run("kb_add", "Likes tea")).toBe("Added to knowledge base.");
    expect(run("kb_del", "[Pinned] Likes tea")).toBe("Removed from knowledge base.");
    expect(prompts.knowledgeBase).toBe("- alpha.\n- Arrived meanwhile.");
    request();
    expect(run("kb_del", "Arrived meanwhile")).toBe("Removed from knowledge base.");
    expect(prompts.knowledgeBase).toBe("- alpha.");
  });

  /** A bullet the request saw that another device has since removed is already gone: nothing changes. */
  test("kb_del of a seen bullet removed since says it isn't there", () => {
    const { prompts, run } = setup("- alpha.\n- beta.");
    expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), ["beta."])).toBe(true);
    expect(run("kb_del", "alpha")).toEqual({ error: "statement not found in knowledge base" });
    expect(prompts.knowledgeBase).toBe("- beta.");
  });

  test("kb_del of a statement not kept changes nothing", () => {
    const { prompts, run, changes } = setup("- alpha.");
    expect(run("kb_del", "gamma")).toEqual({ error: "failed to delete from knowledge base (statement not found)" });
    expect(prompts.knowledgeBase).toBe("- alpha.");
    expect(changes()).toBe(0);
  });

  test("kb_del on an empty knowledge base says so", () => {
    const { run } = setup("");
    expect(run("kb_del", "alpha")).toEqual({ error: "knowledge base is empty" });
  });

  /** The default knowledge base is the user's until they edit it: a removal reads it too. */
  test("kb_del removes from the default knowledge base", () => {
    const { prompts, run } = setup();
    expect(run("kb_del", "User is using TabMail as their AI assistant for emails")).toBe("Removed from knowledge base.");
    expect(prompts.knowledgeBase.startsWith("- TabMail documentation")).toBe(true);
  });

  /** The model is told when the file couldn't be written, and nothing changed. */
  test("an edit that couldn't be saved is reported, and nothing changes", () => {
    const { store, prompts, run, changes } = setup("- alpha.");
    store.failing = true;
    expect(run("kb_add", "beta")).toEqual({ error: "failed to persist knowledge base" });
    expect(run("kb_del", "alpha")).toEqual({ error: "failed to persist knowledge base" });
    expect(prompts.knowledgeBase).toBe("- alpha.");
    expect(changes()).toBe(0);
  });

  /** A knowledge base file that couldn't be read at launch: the model is told how the user fixes it,
   * to say so, each time. */
  test("an edit to a file that couldn't be read says how to fix it", () => {
    const { store, run } = setup("- alpha.");
    store.failing = true;
    store.problem = { kind: "damaged", path: "/example/userPrompts.json", code: "invalid" };
    expect(run("kb_add", "beta")).toEqual({ error: unsavedBecauseOf("knowledgeBase") });
    expect(run("kb_del", "alpha")).toEqual({ error: unsavedBecauseOf("knowledgeBase") });
  });
});
