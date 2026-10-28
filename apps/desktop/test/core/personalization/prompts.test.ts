// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";
import { compositionSections, extractBullets, extractSection, mergeFlatField } from "../../../src/core/personalization/bulletMerge.js";
import { personalizationState } from "../../../src/core/personalization/page.js";
import { defaultComposition, defaultKnowledgeBase } from "../../../src/core/personalization/defaults.js";
import { UserPrompts } from "../../../src/core/personalization/prompts.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";

/** A store whose file can't be written while `failing`: it holds the value and says so, as the
 * file-backed store does. */
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
    super.set(key, value);
    return this.written();
  }

  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    super.setAll(values);
    return this.written();
  }

  override remove(key: string): void {
    super.remove(key);
    this.written();
  }
}

const kbKey = "user_prompts:user_kb.md";
const compositionKey = "user_prompts:user_composition.md";

function setup(values: Record<string, unknown> = {}) {
  const store = new FailingStore(values);
  const prompts = new UserPrompts(store);
  let changes = 0;
  prompts.observe(() => {
    changes += 1;
  });
  return { store, prompts, changes: () => changes };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UserPrompts", () => {
  /** A text never written is its default, and reading it stores nothing: a later default stays the
   * user's until they edit it. */
  test("the defaults are read, never stored", () => {
    const { store, prompts } = setup();
    expect(prompts.composition).toBe(defaultComposition);
    expect(prompts.knowledgeBase).toBe(defaultKnowledgeBase);
    expect(prompts.personalization.knowledgeBase).toBe(defaultKnowledgeBase);
    expect(personalizationState(prompts).writingStyle.map(({ bullets }) => bullets.length)).toEqual([4, 1, 2]);
    expect(store.snapshot()).toEqual({});
  });

  /** A request is sent the writing style's sections, each under a plain heading, and none of
   * Thunderbird's wrapper around them: its "Strictly follow these
   * instructions in future responses" would govern chat replies too. A section holding nothing is left
   * out, and with none left the writing style is empty. */
  test("a request is sent the writing style's sections only", () => {
    const { prompts } = setup();
    const [general, language, links] = compositionSections as [string, string, string];
    expect(prompts.personalization.writingStyle).toBe(
      [
        `# General writing style\n${extractSection(defaultComposition, general)}`,
        `# Language\n${extractSection(defaultComposition, language)}`,
        `# Useful links to personal website and other resources\n${extractSection(defaultComposition, links)}`,
      ].join("\n\n"),
    );
    expect(prompts.personalization.writingStyle).not.toContain("DO NOT EDIT");
    expect(prompts.personalization.writingStyle).not.toContain("====");
    expect(prompts.personalization.writingStyle).not.toContain("Strictly follow");

    prompts.editCompositionSection(language, ["I write in English Only."], []);
    expect(prompts.personalization.writingStyle).not.toContain("# Language");
    prompts.editCompositionSection(general, extractBullets(extractSection(defaultComposition, general)), []);
    prompts.editCompositionSection(links, extractBullets(extractSection(defaultComposition, links)), []);
    expect(prompts.personalization.writingStyle).toBe("");
  });

  /** The bullets are kept in the order the user left them, each one line, an empty one left out. */
  test("an edit keeps the user's order and makes each bullet one line", () => {
    const { prompts } = setup({ [kbKey]: "- alpha\n- beta" });
    expect(prompts.editKnowledgeBase(["alpha", "beta"], ["beta", "  ", "gamma\nwith a second line", "alpha"])).toBe(true);
    expect(prompts.knowledgeBase).toBe("- beta\n- gamma with a second line\n- alpha");
  });

  /** A statement `kb_add` kept after Settings showed the knowledge base survives the
   * user's edit of what was shown: the edit merges into the text as it is now. */
  test("a statement added after the page showed survives an edit", () => {
    const { prompts } = setup({ [kbKey]: "- alpha\n- beta" });
    const shown = extractBullets(prompts.knowledgeBase);
    expect(prompts.updateKnowledgeBase((current) => `${current}\n- [Pinned] Added meanwhile.`)).toBe("saved");

    expect(prompts.editKnowledgeBase(shown, ["alpha"])).toBe(true);

    expect(extractBullets(prompts.knowledgeBase)).toEqual(["alpha", "[Pinned] Added meanwhile."]);
  });

  /** Saving one bullet changes no other: an untouched bullet stored with a leading space
   * stays byte for byte when another is edited. */
  test("an edit of one bullet keeps an untouched one as stored", () => {
    const { prompts } = setup({ [kbKey]: "- Alpha.\n-  Beta." });
    const shown = personalizationState(prompts).knowledgeBase;
    expect(prompts.editKnowledgeBase(shown, shown.map((bullet) => (bullet === "Alpha." ? "Alpha, edited." : bullet)))).toBe(true);
    expect(prompts.knowledgeBase).toBe("- Alpha, edited.\n-  Beta.");
  });

  test("an edit that changes nothing writes nothing", () => {
    const { store, prompts, changes } = setup({ [kbKey]: "- alpha" });
    expect(prompts.editKnowledgeBase(["alpha"], ["alpha"])).toBe(true);
    expect(prompts.updateKnowledgeBase(() => null)).toBe("unchanged");
    expect(changes()).toBe(0);
    expect(store.get("prompt_history")).toBeUndefined();
  });

  /** The user can clear the whole knowledge base: it is then empty, never its default again, and
   * Settings lists nothing. */
  test("a knowledge base cleared in Settings stays empty", () => {
    const { prompts } = setup();
    const shown = personalizationState(prompts).knowledgeBase;
    expect(shown.length).toBeGreaterThan(1);
    // An item emptied in Settings is sent empty and left out.
    expect(prompts.editKnowledgeBase(shown, ["", ...shown.slice(1)])).toBe(true);
    expect(personalizationState(prompts).knowledgeBase).toEqual(shown.slice(1));
    expect(prompts.editKnowledgeBase(shown.slice(1), [])).toBe(true);
    expect(prompts.knowledgeBase).toBe("");
    expect(prompts.personalization.knowledgeBase).toBe("");
    expect(personalizationState(prompts).knowledgeBase).toEqual([]);
    // What is added next is all there is.
    expect(prompts.editKnowledgeBase([], ["Likes short replies."])).toBe(true);
    expect(personalizationState(prompts).knowledgeBase).toEqual(["Likes short replies."]);
  });

  /** A bullet that starts with another section's name ("Language: …") is a bullet, never that
   * section's header: it is shown in its own section, and editing the section it names keeps it
   * and every other bullet where they are. */
  test("a bullet naming another section isn't taken for its header", () => {
    const [general, language] = compositionSections as [string, string, string];
    const composition = defaultComposition.replace("- ALWAYS start with a greeting.", "- ALWAYS start with a greeting.\n- Language: keep it formal with clients.");
    expect(composition).not.toBe(defaultComposition);
    const { prompts } = setup({ [compositionKey]: composition });
    const section = (name: string) => personalizationState(prompts).writingStyle.find((shown) => shown.section === name)?.bullets;
    const generalBefore = section(general);
    expect(generalBefore).toContain("Language: keep it formal with clients.");
    expect(section(language)).toEqual(["I write in English Only."]);

    expect(prompts.editCompositionSection(language, ["I write in English Only."], ["I write in French."])).toBe(true);
    expect(section(general)).toEqual(generalBefore);
    expect(section(language)).toEqual(["I write in French."]);
  });

  /** An edit of one writing-style section leaves the rest of the text as it was. */
  test("a writing-style edit replaces only its section", () => {
    const { prompts } = setup();
    const [general, language, links] = compositionSections as [string, string, string];
    expect(prompts.editCompositionSection(language, ["I write in English Only."], ["I write in English and French."])).toBe(true);

    const composition = prompts.composition;
    expect(extractBullets(extractSection(composition, language))).toEqual(["I write in English and French."]);
    expect(extractSection(composition, general)).toBe(extractSection(defaultComposition, general));
    expect(extractSection(composition, links)).toBe(extractSection(defaultComposition, links));
    expect(composition.startsWith("# User provided composition instructions\n")).toBe(true);
    expect(composition.endsWith("Now, acknowledge these user instructions and do not deviate from them.")).toBe(true);
  });

  /** A writing-style edit that keeps the section's bullets writes nothing, tells no one and records
   * nothing. */
  test("a writing-style edit that changes nothing writes nothing", () => {
    const { store, prompts, changes } = setup();
    expect(prompts.editCompositionSection(compositionSections[1] as string, ["I write in English Only."], ["I write in English Only."])).toBe(true);
    expect(store.snapshot()).toEqual({});
    expect(changes()).toBe(0);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod);
    expect(prompts.history).toEqual([]);
  });

  /** The stored text keeps Thunderbird's layout, which the other apps read: a section's bullets
   * right under its header, then a blank line before what follows (the next header, or the end of
   * the instructions). */
  test("a writing-style edit keeps Thunderbird's layout", () => {
    const { store, prompts } = setup();
    const [, language, links] = compositionSections as [string, string, string];
    prompts.editCompositionSection(language, ["I write in English Only."], ["I write in English and French."]);
    prompts.editCompositionSection(links, ["[TabMail Website](https://tabmail.ai)", "[TabMail Support](https://tabmail.ai/support)"], ["[Example](https://example.com)"]);
    const expected = defaultComposition
      .replace("- I write in English Only.", "- I write in English and French.")
      .replace("- [TabMail Website](https://tabmail.ai)\n- [TabMail Support](https://tabmail.ai/support)", "- [Example](https://example.com)");
    expect(store.get(compositionKey)).toBe(expected);
  });

  /** A bullet stored with a space after its "- " is shown with that space; Settings can
   * still remove each bullet it shows, and an edit of one replaces it in place. */
  test("every bullet shown can be removed and edited, one stored with a leading space too", () => {
    const produced = () => {
      const { prompts } = setup({ [kbKey]: "- a." });
      const before = prompts.knowledgeBase;
      prompts.updateKnowledgeBase((now) => mergeFlatField(before, now, "- a.\n-  Alice."));
      return prompts;
    };
    const shown = personalizationState(produced()).knowledgeBase;
    expect(shown.some((bullet) => bullet.startsWith(" "))).toBe(true);
    for (const at of shown.keys()) {
      const removing = produced();
      const remaining = shown.filter((_, index) => index !== at);
      expect(removing.editKnowledgeBase(shown, remaining)).toBe(true);
      expect(personalizationState(removing).knowledgeBase.map((bullet) => bullet.trim())).toEqual(remaining.map((bullet) => bullet.trim()));
      const editing = produced();
      const edited = shown.map((bullet, index) => (index === at ? "Edited." : bullet));
      expect(editing.editKnowledgeBase(shown, edited)).toBe(true);
      expect(personalizationState(editing).knowledgeBase.map((bullet) => bullet.trim())).toEqual(edited.map((bullet) => bullet.trim()));
    }
  });

  test("an edit of a section that isn't one is refused", () => {
    const { store, prompts } = setup();
    expect(prompts.editCompositionSection("# Not a section", [], ["anything"])).toBe(false);
    expect(store.snapshot()).toEqual({});
  });

  /** A write the file refused leaves every text as it was, tells no one, and records nothing: what
   * applies is what is saved. */
  test("an edit that couldn't be saved changes nothing", () => {
    const { store, prompts, changes } = setup({ [kbKey]: "- alpha" });
    store.failing = true;

    expect(prompts.editKnowledgeBase(["alpha"], ["beta"])).toBe(false);
    expect(prompts.updateKnowledgeBase(() => "- gamma")).toBe("unsaved");
    expect(prompts.editCompositionSection(compositionSections[1] as string, ["I write in English Only."], ["French"])).toBe(false);

    expect(prompts.knowledgeBase).toBe("- alpha");
    expect(prompts.composition).toBe(defaultComposition);
    expect(store.get(compositionKey)).toBeUndefined();
    expect(changes()).toBe(0);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod);
    expect(prompts.history).toEqual([]);
  });

  /** Edits are recorded once they stop, as one entry holding the texts after them, as on iOS. */
  test("edits are recorded once they stop for the quiet period", () => {
    const { prompts, changes } = setup({ [kbKey]: "- alpha" });
    prompts.editKnowledgeBase(["alpha"], ["alpha", "beta"]);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod - 1);
    prompts.editCompositionSection(compositionSections[1] as string, ["I write in English Only."], ["I write in French."]);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod - 1);
    expect(prompts.history).toEqual([]);
    expect(changes()).toBe(2);

    vi.advanceTimersByTime(1);

    const history = prompts.history;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ source: "local_edit", fields: ["kb", "composition"], kb: "- alpha\n- beta", composition: prompts.composition });
    // Settings hears of the entry to list it.
    expect(changes()).toBe(3);
  });

  /** A reset records the texts as they were, then writes the default. */
  test("a reset records the text it replaces", () => {
    const { prompts, changes } = setup({ [kbKey]: "- alpha" });
    expect(prompts.resetKnowledgeBase()).toBe(true);

    expect(prompts.knowledgeBase).toBe(defaultKnowledgeBase);
    expect(prompts.history).toHaveLength(1);
    expect(prompts.history[0]).toMatchObject({ source: "reset", fields: ["kb"], kb: "- alpha" });
    expect(changes()).toBe(1);

    expect(prompts.resetComposition()).toBe(true);
    expect(prompts.history[1]).toMatchObject({ source: "reset", fields: ["composition"], composition: defaultComposition });
  });

  /** An edit still waiting for its quiet period is recorded before a reset, so the history holds it. */
  test("a reset records an edit waiting for its quiet period first", () => {
    const { prompts } = setup({ [kbKey]: "- alpha" });
    prompts.editKnowledgeBase(["alpha"], ["beta"]);
    prompts.resetKnowledgeBase();

    expect(prompts.history.map((entry) => [entry.source, entry.kb])).toEqual([
      ["local_edit", "- beta"],
      ["reset", "- beta"],
    ]);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod);
    expect(prompts.history).toHaveLength(2);
  });

  /** A restore puts back both texts as the entry holds them, and records them as they were first, so
   * a restore can be undone. */
  test("a restore puts back both texts and records what it replaced", () => {
    const { prompts } = setup({ [kbKey]: "- alpha" });
    prompts.editKnowledgeBase(["alpha"], ["beta"]);
    prompts.flushHistory();
    const entry = prompts.history[0];
    prompts.editKnowledgeBase(["beta"], ["gamma"]);
    prompts.editCompositionSection(compositionSections[1] as string, ["I write in English Only."], ["I write in French."]);
    const composition = prompts.composition;

    expect(prompts.restore(entry?.id ?? "")).toBe(true);

    expect(prompts.knowledgeBase).toBe("- beta");
    expect(prompts.composition).toBe(defaultComposition);
    const history = prompts.history;
    expect(history.map((item) => item.source)).toEqual(["local_edit", "local_edit", "reset"]);
    expect(history[2]).toMatchObject({ fields: ["composition", "kb"], kb: "- gamma", composition });
    expect(prompts.restore("no-such-entry")).toBe(false);
  });

  test("a restore that couldn't be saved changes neither text", () => {
    const { store, prompts } = setup({ [kbKey]: "- alpha" });
    prompts.editKnowledgeBase(["alpha"], ["beta"]);
    prompts.flushHistory();
    const id = prompts.history[0]?.id ?? "";
    prompts.editKnowledgeBase(["beta"], ["gamma"]);
    store.failing = true;

    expect(prompts.restore(id)).toBe(false);

    expect(prompts.knowledgeBase).toBe("- gamma");
    expect(prompts.composition).toBe(defaultComposition);
    expect(store.get(compositionKey)).toBeUndefined();
  });

  /** Whatever writes fail partway through a restore, what a relaunch reads is what the restore
   * reported: both texts put back, or both as they were. A user's saved edit never comes back
   * changed after a restore reported as not done. */
  test.each([0, 1, 2, 3])("a restore whose writes fail after %i of them leaves the file as it reported", (writesLeft) => {
    const store = new DiskStore();
    const prompts = new UserPrompts(store);
    prompts.editCompositionSection("Language", ["I write in English Only."], ["I write in French."]);
    prompts.editKnowledgeBase(extractBullets(defaultKnowledgeBase), ["Works with Sam."]);
    prompts.flushHistory();
    const entry = prompts.history.at(-1);
    const id = entry?.id ?? "";
    const [historyComposition, historyKB] = [entry?.composition, entry?.kb];
    expect(historyComposition).toContain("- I write in French.");
    prompts.editCompositionSection("Language", ["I write in French."], ["I write in German."]);
    prompts.editKnowledgeBase(["Works with Sam."], ["Works with Sam and Ana."]);
    prompts.flushHistory();
    const [currentComposition, currentKB] = [prompts.composition, prompts.knowledgeBase];
    store.writesLeft = writesLeft;

    const restored = prompts.restore(id);

    const relaunched = new UserPrompts(new MemoryStore(store.disk));
    const expected = restored ? [historyComposition, historyKB] : [currentComposition, currentKB];
    expect([prompts.composition, prompts.knowledgeBase]).toEqual(expected);
    expect([relaunched.composition, relaunched.knowledgeBase]).toEqual(expected);
  });

  test("the history keeps the newest entries only", () => {
    const { prompts } = setup();
    for (let index = 0; index <= config.promptHistoryMax; index += 1) {
      prompts.updateKnowledgeBase(() => `- edit ${index}`);
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
    prompts.editKnowledgeBase(["alpha"], ["beta"]);

    prompts.flushHistory();

    expect(prompts.history).toHaveLength(1);
    vi.advanceTimersByTime(config.promptHistoryQuietPeriod);
    expect(prompts.history).toHaveLength(1);
  });

  test("history entries that aren't well formed are left out", () => {
    const good = { id: "a", timestamp: new Date().toISOString(), source: "reset", fields: ["kb"], composition: "", kb: "- alpha" };
    const { prompts } = setup({ prompt_history: [good, { ...good, id: 1 }, { ...good, source: "sync_receive" }, { ...good, fields: ["action"] }, null, "text"] });
    expect(prompts.history).toEqual([good]);
  });
});
