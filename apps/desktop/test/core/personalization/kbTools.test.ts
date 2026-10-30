// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../../../src/core/config.js";
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

/** A store whose writes are refused while `refusing`, nothing written. */
class RefusingStore extends MemoryStore {
  refusing = false;

  override set(key: string, value: unknown): boolean {
    return !this.refusing && super.set(key, value);
  }

  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    return !this.refusing && super.setAll(values);
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

  /** R22: a request whose key-down read found the knowledge base's upgrade unsaved holds no labels: its
   * kb_del reports the knowledge base could not be saved, never a deletion against labels the upgrade's
   * save does not use. A request read once it is saved deletes. */
  test("kb_del of a request read while the upgrade was unsaved reports it could not be saved (R22)", () => {
    const store = new RefusingStore({ [kbKey]: "- alpha.\n- beta." });
    store.refusing = true;
    const prompts = new UserPrompts(store);
    const refused = new KBTools(prompts, prompts.captureKnowledgeBase());
    store.refusing = false;

    expect(JSON.parse(refused.run("kb_del", { statement: "beta." }))).toEqual({ error: "failed to persist knowledge base" });
    expect(prompts.knowledgeBase).toBe("- alpha.\n- beta.");
    const next = new KBTools(prompts, prompts.captureKnowledgeBase());
    expect(JSON.parse(next.run("kb_del", { statement: "beta." }))).toBe("Removed from knowledge base.");
    expect(prompts.knowledgeBase).toBe("- alpha.");
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

  /** A newer device's bullet in a section this version doesn't show is kept, never shown, and never
   * makes kb_add of the same statement a duplicate: the check covers what the knowledge base shows. */
  test("a bullet in a section this version doesn't show never blocks kb_add, and is kept", () => {
    const { store, prompts, run, request } = setup("- alpha.");
    const writer = "ffffffff00000001";
    const snapshot = { type: "bullet_state", v: 1, field: "kb", sender: "ffffffffffffffff", snap: "1", part: 1, parts: 1, bullets: [["future", "[Pinned] Uses ABC.", writer, 1]], seen: { [writer]: 1 } };
    expect(prompts.sync.receive(snapshot)).toMatchObject({ kind: "merged", changed: true });
    request();
    expect(prompts.knowledgeBase).toBe("- alpha.");

    expect(run("kb_add", "Uses ABC.")).toBe("Added to knowledge base.");
    const fresh = new UserPrompts(new MemoryStore(store.snapshot()));
    expect(fresh.knowledgeBase).toBe("- alpha.\n- [Pinned] Uses ABC.");
    expect(fresh.sync.state("kb").bullets.filter((bullet) => bullet.section === "future")).toEqual([{ section: "future", text: "[Pinned] Uses ABC.", name: writer, n: 1 }]);
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
    // Another request removed it meanwhile: an agent's write leaves this one's capture current.
    expect(JSON.parse(new KBTools(prompts, prompts.captureKnowledgeBase()).run("kb_del", { statement: "alpha" }))).toBe("Removed from knowledge base.");
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

  /** Root ADR-035: a request's kb_add and kb_del write only while nothing was saved from Settings, and the
   * account didn't change, since its key-down; otherwise the model is told it wasn't saved, and nothing
   * changes. A request taken after writes. */
  const changes: [string, (prompts: UserPrompts, store: RefusingStore) => void][] = [
    ["a knowledge-base edit in Settings", (prompts) => expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), ["gamma."])).toBe(true)],
    ["a writing-style edit in Settings", (prompts) => expect(prompts.editCompositionSection("language", prompts.shown("composition", "language"), ["I write in German."])).toBe(true)],
    ["a reset of the knowledge base", (prompts) => expect(prompts.resetKnowledgeBase()).toBe(true)],
    ["a reset of the writing style", (prompts) => expect(prompts.resetComposition()).toBe(true)],
    ["a restore from the history", (prompts) => {
      expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), ["gamma."])).toBe(true);
      prompts.flushHistory();
      const entry = prompts.history.at(-1);
      if (entry === undefined) throw new Error("no history");
      expect(prompts.restore(entry.id)).toBe(true);
    }],
    ["the texts' file reset", (prompts, store) => prompts.resetFile(() => store.setAll(Object.fromEntries(Object.keys(store.snapshot()).map((key) => [key, undefined]))))],
    ["an account change", (prompts) => prompts.accountChanged()],
  ];
  describe.each(["kb_add", "kb_del"])("%s", (tool) => {
    test.each(changes)("isn't saved after %s since key-down", (_change, change) => {
      const store = new RefusingStore({ [kbKey]: "- alpha.\n- beta." });
      const prompts = new UserPrompts(store);
      const request = new KBTools(prompts, prompts.captureKnowledgeBase());
      change(prompts, store);
      const before = structuredClone(store.snapshot());
      const statement = tool === "kb_add" ? "Prefers tea" : "alpha";
      expect(JSON.parse(request.run(tool, { statement }))).toEqual({ error: config.kbChangedSinceRequest });
      expect(store.snapshot()).toEqual(before);
      // A request taken now writes.
      if (tool === "kb_del") expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), ["alpha."])).toBe(true);
      expect(JSON.parse(new KBTools(prompts, prompts.captureKnowledgeBase()).run(tool, { statement }))).toBe(tool === "kb_add" ? "Added to knowledge base." : "Removed from knowledge base.");
    });

    /** What leaves a request's knowledge base as it took it, as far as its writes go: a change from
     * Settings that couldn't be saved, and another request's write. */
    test.each<[string, (prompts: UserPrompts, store: RefusingStore) => void]>([
      ["a Settings edit that couldn't be saved", (prompts, store) => {
        store.refusing = true;
        expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), ["gamma."])).toBe(false);
        store.refusing = false;
      }],
      ["a reset that couldn't be saved", (prompts, store) => {
        store.refusing = true;
        expect(prompts.resetKnowledgeBase()).toBe(false);
        store.refusing = false;
      }],
      ["another request's write", (prompts) => expect(JSON.parse(new KBTools(prompts, prompts.captureKnowledgeBase()).run("kb_add", { statement: "Prefers coffee" }))).toBe("Added to knowledge base.")],
    ])("is saved after %s", (_change, change) => {
      const store = new RefusingStore({ [kbKey]: "- alpha.\n- beta." });
      const prompts = new UserPrompts(store);
      const request = new KBTools(prompts, prompts.captureKnowledgeBase());
      change(prompts, store);
      expect(JSON.parse(request.run(tool, { statement: tool === "kb_add" ? "Prefers tea" : "alpha" }))).toBe(tool === "kb_add" ? "Added to knowledge base." : "Removed from knowledge base.");
    });
  });
});
