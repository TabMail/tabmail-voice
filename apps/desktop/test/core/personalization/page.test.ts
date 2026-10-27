// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { compositionSections } from "../../../src/core/personalization/bulletMerge.js";
import { personalizationState } from "../../../src/core/personalization/page.js";
import { UserPrompts } from "../../../src/core/personalization/prompts.js";
import { MemoryStore } from "../../../src/core/util/keyValueStore.js";

describe("personalizationState", () => {
  test("Settings shows each writing-style section's bullets and the knowledge base's", () => {
    const prompts = new UserPrompts(new MemoryStore({ "user_prompts:user_kb.md": "- alpha.\n- beta." }));
    const state = personalizationState(prompts);
    expect(state.writingStyle.map((group) => group.section)).toEqual(compositionSections);
    expect(state.writingStyle[1]?.bullets).toEqual(["I write in English Only."]);
    expect(state.knowledgeBase).toEqual(["alpha.", "beta."]);
    expect(state.history).toEqual([]);
  });

  /** Each entry, newest first, says what restoring it would bring back and take away from the texts
   * as they are now. */
  test("the history says what restoring each entry would change", () => {
    const prompts = new UserPrompts(new MemoryStore({ "user_prompts:user_kb.md": "- alpha." }));
    prompts.editKnowledgeBase(["alpha."], ["alpha.", "beta."]);
    prompts.flushHistory();
    prompts.resetKnowledgeBase();
    prompts.editCompositionSection(compositionSections[1] as string, ["I write in English Only."], ["I write in French."]);
    prompts.flushHistory();

    const history = personalizationState(prompts).history;

    expect(history.map((item) => [item.source, item.fields])).toEqual([
      ["local_edit", ["composition"]],
      ["reset", ["kb"]],
      ["local_edit", ["kb"]],
    ]);
    // The newest is the texts as they are: restoring it changes nothing.
    expect(history[0]).toMatchObject({ restores: [], removes: [] });
    expect(history[1]?.restores).toEqual(["I write in English Only.", "alpha.", "beta."]);
    expect(history[1]?.removes).toEqual(expect.arrayContaining(["I write in French.", "User is using TabMail as their AI assistant for emails."]));
    expect(history[1]?.removes).not.toContain("alpha.");
  });
});
