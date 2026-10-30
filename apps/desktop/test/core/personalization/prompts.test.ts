// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { defaultComposition } from "../../../src/core/personalization/defaults.js";
import { personalizationState } from "../../../src/core/personalization/page.js";
import { holdsSectionMarker, type ShownBullet, UserPrompts } from "../../../src/core/personalization/prompts.js";
import { defaultCatalog } from "../../../src/core/sync/bullets.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";

/** A store whose file can't be written while `failing`: every write is refused and nothing changes,
 * as the file-backed store's. */
class FailingStore extends MemoryStore {
  failing = false;
  writes = 0;

  override set(key: string, value: unknown): boolean {
    if (this.failing) return false;
    this.writes += 1;
    return super.set(key, value);
  }

  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    if (this.failing) return false;
    this.writes += 1;
    return super.setAll(values);
  }
}

/** A store whose first `refusals` writes are refused, nothing written, as a disk with room again
 * after them. */
class RecoveringStore extends MemoryStore {
  refusals = 0;

  override set(key: string, value: unknown): boolean {
    if (this.refusals > 0) {
      this.refusals -= 1;
      return false;
    }
    return super.set(key, value);
  }

  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    if (this.refusals > 0) {
      this.refusals -= 1;
      return false;
    }
    return super.setAll(values);
  }
}

/** A store kept in a file that is written whole, as `JSONFileStore`: `disk` is what a relaunch reads.
 * The first `writesLeft` writes succeed and the rest fail, as when the disk fills up partway. */
class DiskStore extends MemoryStore {
  disk: Record<string, unknown> = {};
  writesLeft = Number.POSITIVE_INFINITY;

  private written(): boolean {
    if (this.writesLeft <= 0) return false;
    this.writesLeft -= 1;
    this.disk = structuredClone(this.snapshot());
    return true;
  }

  override set(key: string, value: unknown): boolean {
    const before = this.get(key);
    super.set(key, value);
    if (this.written()) return true;
    super.set(key, before);
    return false;
  }

  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    const before = Object.fromEntries(Object.keys(values).map((key) => [key, this.get(key)]));
    super.setAll(values);
    if (this.written()) return true;
    super.setAll(before);
    return false;
  }
}

const kbKey = "user_prompts:user_kb.md";
const compositionKey = "user_prompts:user_composition.md";
const kbStateKey = "bullet_state:kb";
const compositionStateKey = "bullet_state:composition";
const kbDefaults = defaultCatalog.defaults.filter((entry) => entry.field === "kb").map((entry) => entry.text);
const defaultKB = kbDefaults.map((text) => `- ${text}`).join("\n");
/** Thunderbird's default writing style as the default bullets render it (one trailing space trimmed). */
const defaultStyle = defaultComposition.replace("not too formal. ", "not too formal.");
const general = "general";
const language = "language";
const links = "links";

function setup(values: Record<string, unknown> = {}, newName?: () => string) {
  const store = new FailingStore(values);
  const prompts = new UserPrompts(store, newName === undefined ? {} : { newName });
  let changes = 0;
  prompts.observe(() => {
    changes += 1;
  });
  const sent: string[] = [];
  prompts.onLocalChange = (field) => sent.push(field);
  return { store, prompts, changes: () => changes, sent };
}

/** Writer names in order, as the vectors name them. */
function names(): () => string {
  let k = 0;
  return () => `00000001${(++k).toString(16).padStart(8, "0")}`;
}

function texts(shown: readonly ShownBullet[]): string[] {
  return shown.map((bullet) => bullet.text);
}

function shownSection(prompts: UserPrompts, section: string): ShownBullet[] {
  return personalizationState(prompts).writingStyle.find((shown) => shown.section === section)?.bullets ?? [];
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UserPrompts", () => {
  /** The user's factory reset (ADR-DESK-063): both texts read their defaults from then on, the change
   * is told and sent, and edits are saved again; a reset that fails changes nothing. */
  test("a reset texts file reads its defaults, is told and sent, and saves again", () => {
    const store = new (class extends FailingStore {
      problem: { kind: "damaged"; path: string; code: string } | undefined = { kind: "damaged", path: "/example/userPrompts.json", code: "invalid" };
      moveAside(): void {
        this.values.clear();
        this.problem = undefined;
        this.failing = false;
      }
    })({ [kbKey]: "- Held this session." });
    store.failing = true;
    const prompts = new UserPrompts(store);
    const sent: string[] = [];
    prompts.onLocalChange = (field) => sent.push(field);
    let changes = 0;
    prompts.observe(() => {
      changes += 1;
    });
    expect(() =>
      prompts.resetFile(() => {
        throw new Error("not moved");
      }),
    ).toThrow("not moved");
    expect([changes, prompts.fileProblem?.kind, prompts.knowledgeBase, sent]).toEqual([0, "damaged", "- Held this session.", []]);

    prompts.resetFile(() => store.moveAside());
    expect([changes, prompts.fileProblem, prompts.knowledgeBase, prompts.composition, sent]).toEqual([1, undefined, defaultKB, defaultStyle, ["kb", "composition"]]);
    expect(prompts.resetKnowledgeBase()).toBe(true);
  });

  /** DS-DEFAULT: a text never written is its catalog defaults, and reading it stores nothing. */
  test("the defaults are read, never stored", () => {
    const { store, prompts } = setup();
    expect(prompts.composition).toBe(defaultStyle);
    expect(prompts.knowledgeBase).toBe(defaultKB);
    expect(prompts.personalization.knowledgeBase).toBe(defaultKB);
    expect(personalizationState(prompts).writingStyle.map(({ bullets }) => bullets.length)).toEqual([4, 1, 2]);
    expect(personalizationState(prompts).knowledgeBase[0]?.labels).toEqual([["default:kb-1", 1]]);
    expect(store.snapshot()).toEqual({});
  });

  /** DS-UPGRADE: a text kept before labelled bullets is labelled at its first read, in one write that
   * removes the old key; a catalog default keeps its own label. */
  test("a text from before is upgraded at its first read, its old key gone", () => {
    const { store, prompts } = setup({ [kbKey]: `- ${kbDefaults[0] as string}\n-  Mine.\nplain`, "device_sync_ts:kb": "2099-01-01T00:00:00.000Z" }, names());
    expect(texts(prompts.shown("kb", ""))).toEqual([kbDefaults[0], "Mine.", "plain"]);
    expect(store.get(kbKey)).toBeUndefined();
    expect(store.get("device_sync_ts:kb")).toBeUndefined();
    expect(store.get(kbStateKey)).toEqual({
      head: [],
      tail: [],
      bullets: [
        ["", kbDefaults[0], "default:kb-1", 1],
        ["", "Mine.", "0000000100000001", 1],
        ["", "plain", "0000000100000001", 2],
      ],
      seen: { "default:kb-1": 1, "0000000100000001": 2 },
    });
    expect(store.writes).toBe(1);
  });

  test("an upgrade that couldn't be saved is shown, and nothing else is saved until it is", () => {
    const { store, prompts, sent } = setup({ [kbKey]: "- alpha" });
    store.failing = true;
    expect(texts(prompts.shown("kb", ""))).toEqual(["alpha"]);
    expect(prompts.addKnowledge("beta").outcome).toBe("unsaved");
    expect(sent).toEqual([]);
    store.failing = false;
    expect(prompts.addKnowledge("beta").outcome).toBe("saved");
    expect(texts(prompts.shown("kb", ""))).toEqual(["alpha", "beta"]);
    expect(store.get(kbKey)).toBeUndefined();
  });

  /** R22: bullets Settings showed while the upgrade was unsaved carry labels its later save does not
   * use, and an edit from them would be reported saved and delete nothing. They carry none then, the
   * edit is refused, and one from bullets shown once the upgrade is saved is applied. */
  test("an edit of bullets shown while an upgrade was unsaved is refused, and one shown once it is saved is applied (R22)", () => {
    const { store, prompts } = setup({ [kbKey]: "- alpha\n- beta" });
    store.failing = true;
    const shown = prompts.shown("kb", "");
    expect(texts(shown)).toEqual(["alpha", "beta"]);
    store.failing = false;

    const edited = prompts.editKnowledgeBase(shown, ["alpha"]);
    expect(edited && texts(prompts.shown("kb", "")).includes("beta")).toBe(false);
    expect(edited).toBe(false);
    expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), ["alpha"])).toBe(true);
    expect(texts(prompts.shown("kb", ""))).toEqual(["alpha"]);
  });

  /** R22: a restore whose read found the upgrade unsaved is refused, at whichever write the store has
   * room again: one reported saved has put the entry's texts back. */
  test.each(Array.from({ length: 8 }, (_, refusals) => refusals))("a restore with the first %i writes refused is reported saved only with the entry's texts back (R22)", (refusals) => {
    const entry = { id: "a", timestamp: new Date().toISOString(), source: "reset", fields: ["kb"], composition: defaultStyle, kb: "- alpha" };
    const store = new RecoveringStore({ [kbKey]: "- alpha\n- beta", prompt_history: [entry] });
    store.refusals = refusals;
    const prompts = new UserPrompts(store);

    const restored = prompts.restore("a");
    expect(restored && prompts.knowledgeBase !== "- alpha").toBe(false);
    store.refusals = 0;
    expect(prompts.restore("a")).toBe(true);
    expect(prompts.knowledgeBase).toBe("- alpha");
  });

  /** DS-NAME with the app's own writer names (nothing injected): independent devices, one restarted and
   * one copied from another's store each add under a name of their own, so every addition reaches every
   * device. */
  test("the app's own writer names keep every device's additions, after a restart and from a copy (DS-NAME)", () => {
    const aStore = new MemoryStore();
    const bStore = new MemoryStore();
    const a = new UserPrompts(aStore);
    expect(new UserPrompts(bStore).addKnowledge("Second note").outcome).toBe("saved");
    expect(a.addKnowledge("First note").outcome).toBe("saved");
    const copy = new UserPrompts(new MemoryStore(structuredClone(aStore.snapshot())));
    expect(copy.addKnowledge("Copied note").outcome).toBe("saved");
    const b = new UserPrompts(bStore);
    expect(b.addKnowledge("After restart").outcome).toBe("saved");
    const devices = [a, b, copy];
    for (let round = 0; round < 3; round += 1) {
      for (const from of devices) {
        const outgoing = from.sync.outgoing("kb");
        if (outgoing.kind !== "messages") throw new Error(outgoing.kind);
        for (const to of devices) if (to !== from) for (const message of outgoing.messages) to.sync.receive(message);
      }
    }
    for (const device of devices) {
      expect(texts(device.shown("kb", "")).filter((text) => text.includes("note") || text === "After restart").sort()).toEqual(["After restart", "Copied note", "First note", "Second note"]);
    }
  });

  /** The style document is shared with Thunderbird and iOS, which find its sections by these exact
   * headings: the rendered text keeps them as they are, never the name Settings shows. */
  test("the writing style renders Thunderbird's headings and layout", () => {
    const { prompts } = setup();
    expect(prompts.editCompositionSection(language, shownSection(prompts, language), ["I write in English and French."])).toBe(true);
    expect(prompts.editCompositionSection(links, shownSection(prompts, links), ["[Example](https://example.com)"])).toBe(true);
    expect(prompts.composition).toBe(
      defaultStyle
        .replace("- I write in English Only.", "- I write in English and French.")
        .replace("- [TabMail Website](https://tabmail.ai)\n- [TabMail Support](https://tabmail.ai/support)", "- [Example](https://example.com)"),
    );
    expect(personalizationState(prompts).writingStyle.map(({ title }) => title)).toEqual([
      "General writing style",
      "Language",
      "Useful links to personal website and other resources",
    ]);
  });

  /** A request is sent the writing style's sections, each under a plain heading, and none of
   * Thunderbird's wrapper around them: its "Strictly follow these instructions in future responses"
   * would govern chat replies too. A section holding nothing is left out. */
  test("a request is sent the writing style's sections only", () => {
    const { prompts } = setup();
    const lines = (section: string) =>
      defaultCatalog.defaults
        .filter((entry) => entry.field === "composition" && entry.section === section)
        .map((entry) => `- ${entry.text}`)
        .join("\n");
    expect(prompts.personalization.writingStyle).toBe(
      [`# General writing style\n${lines(general)}`, `# Language\n${lines(language)}`, `# Useful links to personal website and other resources\n${lines(links)}`].join("\n\n"),
    );
    expect(prompts.personalization.writingStyle).not.toContain("DO NOT EDIT");
    expect(prompts.personalization.writingStyle).not.toContain("Strictly follow");

    prompts.editCompositionSection(language, shownSection(prompts, language), []);
    expect(prompts.personalization.writingStyle).not.toContain("# Language");
    prompts.editCompositionSection(general, shownSection(prompts, general), []);
    prompts.editCompositionSection(links, shownSection(prompts, links), []);
    expect(prompts.personalization.writingStyle).toBe("");
  });

  /** DS-TEXT: the bullets are kept in the order the user left them, each one line, trimmed, an empty
   * one left out. */
  test("an edit keeps the user's order and makes each bullet one line", () => {
    const { store, prompts } = setup({ [kbKey]: "- alpha\n- beta" });
    expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), ["beta", "  ", "gamma\r\nwith a second line ", "alpha"])).toBe(true);
    expect(texts(prompts.shown("kb", ""))).toEqual(["alpha", "beta", "gamma with a second line"]);
    // The emptied row is not stored as a bullet with no text.
    expect((store.get("bullet_state:kb") as { bullets: [string, string, string, number][] }).bullets.map((bullet) => bullet[1])).toEqual(["alpha", "beta", "gamma with a second line"]);
  });

  /** DS-CAPTURE: what `kb_add` kept after Settings showed the knowledge base survives the user's
   * edit of what was shown. */
  test("a bullet added after the page showed survives an edit", () => {
    const { prompts } = setup({ [kbKey]: "- alpha\n- beta" });
    const shown = prompts.shown("kb", "");
    expect(prompts.addKnowledge("[Pinned] Added meanwhile.").outcome).toBe("saved");
    expect(prompts.editKnowledgeBase(shown, ["alpha"])).toBe(true);
    expect(texts(prompts.shown("kb", ""))).toEqual(["alpha", "[Pinned] Added meanwhile."]);
  });

  /** DS-EDIT: a reworded bullet gets a new label; an untouched one keeps its own. */
  test("an edit of one bullet keeps an untouched one's label", () => {
    const { prompts } = setup({ [kbKey]: "- Alpha.\n- Beta." }, names());
    const shown = prompts.shown("kb", "");
    expect(prompts.editKnowledgeBase(shown, ["Alpha, edited.", "Beta."])).toBe(true);
    expect(prompts.shown("kb", "")).toEqual([
      { text: "Beta.", labels: [["0000000100000001", 2]], epoch: 0 },
      { text: "Alpha, edited.", labels: [["0000000100000001", 3]], epoch: 0 },
    ]);
  });

  test("an edit that changes nothing writes nothing, tells no one, sends nothing and records nothing", () => {
    const { store, prompts, changes, sent } = setup();
    expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), kbDefaults)).toBe(true);
    expect(prompts.editCompositionSection(language, shownSection(prompts, language), ["I write in English Only."])).toBe(true);
    expect(prompts.addKnowledge(kbDefaults[0] as string).outcome).toBe("unchanged");
    expect(store.snapshot()).toEqual({});
    expect([changes(), sent]).toEqual([0, []]);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod);
    expect(prompts.history).toEqual([]);
  });

  /** The user can clear the whole knowledge base: it is then empty, never its defaults again. */
  test("a knowledge base cleared in Settings stays empty", () => {
    const { store, prompts } = setup();
    const shown = prompts.shown("kb", "");
    expect(prompts.editKnowledgeBase(shown, ["", ...texts(shown).slice(1)])).toBe(true);
    expect(texts(prompts.shown("kb", ""))).toEqual(kbDefaults.slice(1));
    expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), [])).toBe(true);
    expect(prompts.knowledgeBase).toBe("");
    expect(prompts.personalization.knowledgeBase).toBe("");
    expect(new UserPrompts(new MemoryStore(store.snapshot())).knowledgeBase).toBe("");
    expect(prompts.editKnowledgeBase([], ["Likes short replies."])).toBe(true);
    expect(texts(prompts.shown("kb", ""))).toEqual(["Likes short replies."]);
  });

  /** A bullet that starts with another section's name ("Language: …") is a bullet, never that
   * section's header; editing the section it names leaves it where it is. */
  test("a bullet naming another section isn't taken for its header", () => {
    const composition = defaultComposition.replace("- ALWAYS start with a greeting.", "- ALWAYS start with a greeting.\n- Language: keep it formal with clients.");
    const { prompts } = setup({ [compositionKey]: composition });
    const generalBefore = texts(shownSection(prompts, general));
    expect(generalBefore).toContain("Language: keep it formal with clients.");
    expect(texts(shownSection(prompts, language))).toEqual(["I write in English Only."]);

    expect(prompts.editCompositionSection(language, shownSection(prompts, language), ["I write in French."])).toBe(true);
    expect(texts(shownSection(prompts, general))).toEqual(generalBefore);
    expect(texts(shownSection(prompts, language))).toEqual(["I write in French."]);
  });

  /** An edit is of one section: a bullet of another section, even the same text, is untouched. */
  test("a writing-style edit changes only its section", () => {
    const { prompts } = setup();
    expect(prompts.editCompositionSection(general, shownSection(prompts, general), [...texts(shownSection(prompts, general)), "I write in English Only."])).toBe(true);
    expect(prompts.editCompositionSection(language, shownSection(prompts, language), [])).toBe(true);
    expect(texts(shownSection(prompts, general)).at(-1)).toBe("I write in English Only.");
    expect(shownSection(prompts, language)).toEqual([]);
    expect(texts(shownSection(prompts, links))).toHaveLength(2);
  });

  test("an edit of a section that isn't one is refused", () => {
    const { store, prompts } = setup();
    expect(prompts.editCompositionSection("General writing style", [], ["anything"])).toBe(false);
    expect(prompts.editCompositionSection("", [], ["anything"])).toBe(false);
    expect(store.snapshot()).toEqual({});
  });

  /** DS-ATOMIC, DS-NAME-ABANDON: a write the file refused leaves every text as it was, tells no one,
   * sends and records nothing; each abandons its writer name, so the next save uses a fresh one. */
  test("an edit that couldn't be saved changes nothing, and the next one uses a fresh name", () => {
    const { store, prompts, changes, sent } = setup({ [kbKey]: "- alpha" }, names());
    expect(texts(prompts.shown("kb", ""))).toEqual(["alpha"]);
    // R20: the upgrade the first read saved is sent.
    expect(sent.splice(0)).toEqual(["kb"]);
    store.failing = true;

    expect(prompts.editKnowledgeBase(prompts.shown("kb", ""), ["beta"])).toBe(false);
    expect(prompts.addKnowledge("gamma").outcome).toBe("unsaved");
    expect(prompts.editCompositionSection(language, shownSection(prompts, language), ["French"])).toBe(false);

    expect(prompts.knowledgeBase).toBe("- alpha");
    expect(prompts.composition).toBe(defaultStyle);
    expect(store.get(compositionStateKey)).toBeUndefined();
    expect([changes(), sent]).toEqual([1, []]);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod);
    expect(prompts.history).toEqual([]);

    store.failing = false;
    expect(prompts.addKnowledge("gamma").outcome).toBe("saved");
    expect(prompts.shown("kb", "").at(-1)?.labels).toEqual([["0000000100000004", 1]]);
  });

  /** Edits are recorded once they stop, as one entry holding the texts after them, as on iOS. */
  test("edits are recorded once they stop for the quiet period", () => {
    const { prompts, changes } = setup({ [kbKey]: "- alpha" });
    expect(prompts.knowledgeBase).toBe("- alpha");
    const before = changes();
    prompts.editKnowledgeBase(prompts.shown("kb", ""), ["alpha", "beta"]);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod - 1);
    prompts.editCompositionSection(language, shownSection(prompts, language), ["I write in French."]);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod - 1);
    expect(prompts.history).toEqual([]);
    expect(changes() - before).toBe(2);

    vi.advanceTimersByTime(1);

    const history = prompts.history;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ source: "local_edit", fields: ["kb", "composition"], kb: "- alpha\n- beta", composition: prompts.composition });
    // Settings hears of the entry to list it.
    expect(changes() - before).toBe(3);
  });

  /** DS-RESET: a reset records the texts as they were, then puts the defaults back, and is sent. */
  test("a reset records the text it replaces, and is sent", () => {
    const { prompts, sent } = setup({ [kbKey]: "- alpha" });
    expect(prompts.knowledgeBase).toBe("- alpha");
    expect(sent.splice(0)).toEqual(["kb"]);
    expect(prompts.resetKnowledgeBase()).toBe(true);

    expect(prompts.knowledgeBase).toBe(defaultKB);
    expect(prompts.history).toHaveLength(1);
    expect(prompts.history[0]).toMatchObject({ source: "reset", fields: ["kb"], kb: "- alpha" });
    expect(sent).toEqual(["kb"]);

    expect(prompts.resetComposition()).toBe(true);
    expect(prompts.history[1]).toMatchObject({ source: "reset", fields: ["composition"], composition: defaultStyle });
    expect(sent).toEqual(["kb", "composition"]);
  });

  test("a reset that couldn't be saved changes nothing and sends nothing", () => {
    const { store, prompts, sent } = setup({ [kbKey]: "- alpha" });
    expect(prompts.knowledgeBase).toBe("- alpha");
    expect(sent.splice(0)).toEqual(["kb"]);
    store.failing = true;
    expect(prompts.resetKnowledgeBase()).toBe(false);
    expect(prompts.knowledgeBase).toBe("- alpha");
    expect(sent).toEqual([]);
  });

  /** An edit still waiting for its quiet period is recorded before a reset, so the history holds it. */
  test("a reset records an edit waiting for its quiet period first", () => {
    const { prompts } = setup({ [kbKey]: "- alpha" });
    prompts.editKnowledgeBase(prompts.shown("kb", ""), ["beta"]);
    prompts.resetKnowledgeBase();

    expect(prompts.history.map((entry) => [entry.source, entry.kb])).toEqual([
      ["local_edit", "- beta"],
      ["reset", "- beta"],
    ]);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod);
    expect(prompts.history).toHaveLength(2);
  });

  /** R6: a restore is a user edit of the sections Settings shows, from what they hold now to what
   * the entry held; it records them as they were first, so a restore can be undone, and is sent. */
  test("a restore puts back both texts' shown sections and records what it replaced", () => {
    const { prompts, sent } = setup({ [kbKey]: "- alpha" });
    prompts.editKnowledgeBase(prompts.shown("kb", ""), ["beta"]);
    prompts.flushHistory();
    const entry = prompts.history[0];
    prompts.editKnowledgeBase(prompts.shown("kb", ""), ["gamma"]);
    prompts.editCompositionSection(language, shownSection(prompts, language), ["I write in French."]);
    const composition = prompts.composition;
    sent.length = 0;

    expect(prompts.restore(entry?.id ?? "")).toBe(true);

    expect(prompts.knowledgeBase).toBe("- beta");
    expect(prompts.composition).toBe(defaultStyle);
    expect(sent.sort()).toEqual(["composition", "kb"]);
    const history = prompts.history;
    expect(history.map((item) => item.source)).toEqual(["local_edit", "local_edit", "reset"]);
    expect(history[2]).toMatchObject({ fields: ["kb", "composition"], kb: "- gamma", composition });
    expect(prompts.restore("no-such-entry")).toBe(false);
  });

  /** R23: a writing-style line holding the section-header mark or the END marker would be read back as a
   * header or the skeleton, so Settings refuses the edit (main's `editWritingStyle`, whose test sends
   * these), whichever line of a pasted bullet holds it. */
  test.each([
    ["the header mark", "Language (DO NOT EDIT/DELETE THIS SECTION HEADER)"],
    ["the header mark without its parentheses", "Keep DO NOT EDIT/DELETE THIS SECTION HEADER here"],
    ["the END marker", "Use ====END USER INSTRUCTIONS==== in the example"],
    ["the header mark on a pasted bullet's second line", "First line\nKeep DO NOT EDIT/DELETE THIS SECTION HEADER here"],
  ])("a line holding %s is found (R23)", (_, line) => {
    expect(holdsSectionMarker([line])).toBe(true);
    expect(holdsSectionMarker(["Plain rule", line, "Keep this in general"])).toBe(true);
    expect(holdsSectionMarker(["Plain rule", "DO NOT EDIT this"])).toBe(false);
  });

  /** DS-SKELETON: the lines around the sections of a released app's writing style, the user's own
   * among them, are kept by its upgrade and by every merge after it (a snapshot carries no skeleton). */
  test("the writing style's own title and closing lines are kept by its upgrade and by a merge", () => {
    const custom = defaultStyle
      .replace("# User provided composition instructions", "# My own composition notes\n- A line I typed before the sections.")
      .replace("Now, acknowledge these user instructions and do not deviate from them.", "Now acknowledge these, my way.");
    const { store, prompts } = setup({ [compositionKey]: custom }, names());
    expect(prompts.composition).toBe(custom);
    expect(store.get(compositionKey)).toBeUndefined();

    const message = { type: "bullet_state", v: 1, field: "composition", sender: "ffffffffffffffff", snap: "1", part: 1, parts: 1, bullets: [["general", "Peer rule", "ffffffff00000001", 1]], seen: { ffffffff00000001: 1 } };
    expect(prompts.sync.receive(message)).toMatchObject({ kind: "merged", changed: true });
    expect(texts(shownSection(prompts, general))).toContain("Peer rule");
    expect(prompts.composition.startsWith("# My own composition notes\n- A line I typed before the sections.\n")).toBe(true);
    expect(prompts.composition.endsWith("\nNow acknowledge these, my way.")).toBe(true);
    expect(new UserPrompts(store).composition).toBe(prompts.composition);
  });

  /** DS-DEDUP and DS-RENDER: a text this device holds, arriving under a smaller label, keeps its place
   * in the order the user left it. */
  test("a text arriving under a smaller label keeps its place", () => {
    const { prompts } = setup({ [kbKey]: "- alpha\n- beta\n- gamma" }, names());
    const message = { type: "bullet_state", v: 1, field: "kb", sender: "ffffffffffffffff", snap: "1", part: 1, parts: 1, bullets: [["", "beta", "0000000000000001", 1]], seen: { "0000000000000001": 1 } };
    prompts.sync.receive(message);
    expect(prompts.shown("kb", "")).toEqual([
      { text: "alpha", labels: [["0000000100000001", 1]], epoch: 0 },
      { text: "beta", labels: [["0000000000000001", 1]], epoch: 0 },
      { text: "gamma", labels: [["0000000100000001", 3]], epoch: 0 },
    ]);
    expect(prompts.knowledgeBase).toBe("- alpha\n- beta\n- gamma");
  });

  /** R23: a history entry recorded before, holding a line with the header mark in a section, restores
   * every other line and makes no bullet of that one. */
  test("a restore makes no bullet of a line holding the header mark (R23)", () => {
    const line = "Keep DO NOT EDIT/DELETE THIS SECTION HEADER here";
    const composition = defaultStyle.replace("- I write in English Only.", `- I write in English Only.\n- ${line}\n- Plain rule`);
    const entry = { id: "a", timestamp: new Date().toISOString(), source: "reset", fields: ["composition"], composition, kb: "" };
    const { prompts } = setup({ prompt_history: [entry] });

    expect(prompts.restore("a")).toBe(true);
    const texts = prompts.sync.state("composition").bullets.map((bullet) => bullet.text);
    expect(texts).toContain("Plain rule");
    expect(texts.filter((text) => text.includes("DO NOT EDIT"))).toEqual([]);
  });

  /** R6: a bullet in a section Settings doesn't show (a newer app's) is kept by a restore. */
  test("a restore keeps a section Settings doesn't show", () => {
    const { prompts } = setup();
    prompts.flushHistory();
    prompts.editCompositionSection(language, shownSection(prompts, language), ["French"]);
    prompts.flushHistory();
    const id = prompts.history[0]?.id ?? "";
    expect(prompts.sync.receive({ type: "bullet_state", v: 1, field: "composition", sender: "ffffffffffffffff", snap: "1", part: 1, parts: 1, bullets: [["signature", "Sig", "ffffffff00000001", 1]], seen: { ffffffff00000001: 1 } })).toMatchObject({ kind: "merged" });
    prompts.editCompositionSection(language, shownSection(prompts, language), ["German"]);
    prompts.flushHistory();
    expect(prompts.restore(id)).toBe(true);
    expect(texts(shownSection(prompts, language))).toEqual(["French"]);
    expect(prompts.sync.state("composition").bullets.filter((bullet) => bullet.section === "signature").map((bullet) => bullet.text)).toEqual(["Sig"]);
  });

  test("a restore that couldn't be saved changes neither text", () => {
    const { store, prompts } = setup({ [kbKey]: "- alpha" });
    prompts.editKnowledgeBase(prompts.shown("kb", ""), ["beta"]);
    prompts.flushHistory();
    const id = prompts.history[0]?.id ?? "";
    prompts.editKnowledgeBase(prompts.shown("kb", ""), ["gamma"]);
    store.failing = true;

    expect(prompts.restore(id)).toBe(false);

    expect(prompts.knowledgeBase).toBe("- gamma");
    expect(prompts.composition).toBe(defaultStyle);
    expect(store.get(compositionStateKey)).toBeUndefined();
  });

  /** Whatever writes fail partway through a restore, what a relaunch reads is what the restore
   * reported: both texts put back, or both as they were. */
  test.each([0, 1, 2, 3])("a restore whose writes fail after %i of them leaves the file as it reported", (writesLeft) => {
    const store = new DiskStore();
    const prompts = new UserPrompts(store);
    prompts.editCompositionSection(language, prompts.shown("composition", language), ["I write in French."]);
    prompts.editKnowledgeBase(prompts.shown("kb", ""), ["Works with Sam."]);
    prompts.flushHistory();
    const entry = prompts.history.at(-1);
    const id = entry?.id ?? "";
    const [historyComposition, historyKB] = [entry?.composition, entry?.kb];
    expect(historyComposition).toContain("- I write in French.");
    prompts.editCompositionSection(language, prompts.shown("composition", language), ["I write in German."]);
    prompts.editKnowledgeBase(prompts.shown("kb", ""), ["Works with Sam and Ana."]);
    prompts.flushHistory();
    const [currentComposition, currentKB] = [prompts.composition, prompts.knowledgeBase];
    store.writesLeft = writesLeft;

    const restored = prompts.restore(id);

    const relaunched = new UserPrompts(new MemoryStore(store.disk));
    const expected = restored ? [historyComposition, historyKB] : [currentComposition, currentKB];
    expect([prompts.composition, prompts.knowledgeBase]).toEqual(expected);
    expect([relaunched.composition, relaunched.knowledgeBase]).toEqual(expected);
  });

  /** What Device Sync merged is recorded before it applies, when it changed a text, and is never
   * sent as a local change. */
  test("a merge that changes a text is recorded as received, and isn't a local change", () => {
    const { prompts, sent } = setup();
    const message = { type: "bullet_state", v: 1, field: "kb", sender: "ffffffffffffffff", snap: "1", part: 1, parts: 1, bullets: [["", "Peer fact", "ffffffff00000001", 1]], seen: { ffffffff00000001: 1 } };
    expect(prompts.sync.receive(message)).toMatchObject({ kind: "merged", changed: true });
    expect(prompts.sync.receive({ ...message, snap: "2" })).toMatchObject({ kind: "merged", changed: false });
    expect(prompts.history.map((entry) => [entry.source, entry.kb])).toEqual([["sync_receive", defaultKB]]);
    expect(prompts.knowledgeBase).toBe(`${defaultKB}\n- Peer fact`);
    expect(sent).toEqual([]);
  });

  /** A stored field read back keeps what is well formed and leaves out the rest. */
  test("a stored field's malformed entries are left out", () => {
    const { prompts } = setup({
      [kbStateKey]: {
        head: "not lines",
        tail: [],
        bullets: [["", "Good", "0000000100000001", 1], ["", " Padded", "0000000100000001", 2], ["", "Bad name", "NAME", 1], ["", "Bad n", "0000000100000001", 0], ["", "Line\nbreak", "0000000100000001", 3], "not a bullet"],
        seen: { "0000000100000001": 1, other: -1 },
      },
    });
    expect(prompts.sync.state("kb")).toEqual({ head: [], tail: [], bullets: [{ section: "", text: "Good", name: "0000000100000001", n: 1 }], seen: new Map([["0000000100000001", 1]]) });
  });

  /** iOS ADR-IOS-089: the texts are taken by the first account that signs in, kept for it, and back
   * at their defaults, with no history, for another. */
  test("the texts belong to an account", () => {
    const { store, prompts } = setup({ [kbKey]: "- alpha" });
    expect(prompts.claim("user-1")).toBe(true);
    expect(prompts.owner).toBe("user-1");
    expect(prompts.knowledgeBase).toBe("- alpha");
    prompts.resetComposition();
    expect(prompts.claim("user-1")).toBe(true);
    expect(prompts.history).toHaveLength(1);

    store.failing = true;
    expect(prompts.claim("user-2")).toBe(false);
    expect(prompts.knowledgeBase).toBe("- alpha");
    store.failing = false;
    expect(prompts.claim("user-2")).toBe(true);
    expect([prompts.owner, prompts.knowledgeBase, prompts.history]).toEqual(["user-2", defaultKB, []]);
  });

  /** Another account's texts from before, not upgraded yet (nothing read them since it claimed them), are
   * cleared with its states: they never become the new account's bullets or reach its devices. */
  test("another account's texts from before go with its claim", () => {
    const { store, prompts } = setup({
      device_sync_owner_user_id: "user-1",
      [kbKey]: "- one's private note",
      [compositionKey]: "# Language (DO NOT EDIT/DELETE THIS SECTION HEADER)\n- one's private style",
    });
    expect(prompts.claim("user-2")).toBe(true);
    const relaunched = new UserPrompts(new MemoryStore(store.snapshot()));
    for (const reader of [prompts, relaunched]) {
      expect([reader.knowledgeBase, reader.composition]).toEqual([defaultKB, defaultStyle]);
    }
    expect(Object.keys(store.snapshot()).filter((key) => key.startsWith("user_prompts:"))).toEqual([]);
  });

  /** R30: nothing captured under one account is committed after another signs in, nor anything captured
   * before a reset of its field or of the texts' file: an edit Settings showed, or an agent request's
   * capture, from before is refused at commit with nothing written. */
  test.each<[string, (prompts: UserPrompts, store: FailingStore) => void]>([
    ["another account signs in", (prompts) => expect(prompts.claim("user-2")).toBe(true)],
    ["the knowledge base is reset", (prompts) => expect(prompts.resetKnowledgeBase()).toBe(true)],
    ["the texts' file is reset", (prompts, store) => prompts.resetFile(() => store.setAll(Object.fromEntries(Object.keys(store.snapshot()).map((key) => [key, undefined]))))],
  ])("nothing captured before %s is committed after it", (_, end) => {
    const { store, prompts } = setup({ [kbKey]: `- one's private note\n- ${kbDefaults[0]}` });
    expect(prompts.claim("user-1")).toBe(true);
    const shown = prompts.shown("kb", "");
    const captured = prompts.captureKnowledgeBase();
    expect(captured).not.toBeNull();
    end(prompts, store);
    const after = store.snapshot();
    // Settings' edit of what it showed before: every text it showed, one added.
    expect(prompts.editKnowledgeBase(shown, [...shown.map((bullet) => bullet.text), "added"])).toBe(false);
    // An agent request's kb_del of a default text, which the defaults after it also hold.
    expect(prompts.removeKnowledge(captured!, { section: "", text: kbDefaults[0]! }).outcome).toBe("unsaved");
    expect(store.snapshot()).toEqual(after);
    expect(prompts.knowledgeBase).toBe(defaultKB);
  });

  /** R30 is per field: a reset of the writing style leaves a capture of the knowledge base good. */
  test("a reset of one field leaves a capture of the other good", () => {
    const { prompts } = setup({ [kbKey]: "- alpha" });
    const shown = prompts.shown("kb", "");
    expect(prompts.resetComposition()).toBe(true);
    expect(prompts.editKnowledgeBase(shown, ["alpha", "beta"])).toBe(true);
    expect(prompts.knowledgeBase).toBe("- alpha\n- beta");
  });

  /** R30: a list that holds a bullet shown before a reset is refused, wherever in the list it is, with
   * nothing written. */
  test("a list mixing bullets from before and after a reset is refused", () => {
    const { store, prompts } = setup({ [kbKey]: "- one's private note" });
    const before = prompts.shown("kb", "");
    expect(prompts.resetKnowledgeBase()).toBe(true);
    const after = prompts.shown("kb", "");
    const snapshot = store.snapshot();
    for (const mixed of [[...after, ...before], [...before, ...after]]) {
      expect(prompts.editKnowledgeBase(mixed, [...mixed.map((bullet) => bullet.text), "added"])).toBe(false);
    }
    expect(store.snapshot()).toEqual(snapshot);
    expect(prompts.knowledgeBase).toBe(defaultKB);
  });

  test("the history keeps the newest entries only", () => {
    const { prompts } = setup();
    for (let index = 0; index <= config.promptHistoryMax; index += 1) {
      prompts.editKnowledgeBase(prompts.shown("kb", ""), [`edit ${index}`]);
      prompts.flushHistory();
    }
    const history = prompts.history;
    expect(history).toHaveLength(config.promptHistoryMax);
    expect(history[0]?.kb).toBe("- edit 1");
    expect(history.at(-1)?.kb).toBe(`- edit ${config.promptHistoryMax}`);
  });

  /** On quit, an edit waiting for its quiet period is recorded at once. */
  test("flushing records the edits waiting, once", () => {
    const { prompts } = setup({ [kbKey]: "- alpha" });
    prompts.flushHistory();
    expect(prompts.history).toEqual([]);
    prompts.editKnowledgeBase(prompts.shown("kb", ""), ["beta"]);

    prompts.flushHistory();

    expect(prompts.history).toHaveLength(1);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod);
    expect(prompts.history).toHaveLength(1);
  });

  test("history entries that aren't well formed are left out", () => {
    const good = { id: "a", timestamp: new Date().toISOString(), source: "reset", fields: ["kb"], composition: "", kb: "- alpha" };
    const { prompts } = setup({ prompt_history: [good, { ...good, id: 1 }, { ...good, source: "sync_send" }, { ...good, fields: ["action"] }, null, "text"] });
    expect(prompts.history).toEqual([good]);
  });
});
