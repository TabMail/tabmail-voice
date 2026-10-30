// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { displayedSections, parse, sectionHeaders } from "../sync/bullets.js";
import type { PromptField, PromptHistorySource, Shown, UserPrompts } from "./prompts.js";

/** One history entry as Settings lists it: when and how it came about, the texts it changed, and what
 * restoring it would do to the texts as they are now. */
export interface PromptHistoryItem {
  id: string;
  timestamp: string;
  source: PromptHistorySource;
  fields: PromptField[];
  /** The bullets restoring it brings back, and those it takes away. */
  restores: string[];
  removes: string[];
}

/** What Settings › Personalization shows (ADR-DESK-063). */
export interface PersonalizationState {
  /** The writing style's sections, in order: each one's key, its header and its bullets with the
   * labels an edit hands back (DS-CAPTURE). */
  writingStyle: { section: string; title: string; shown: Shown }[];
  knowledgeBase: Shown;
  /** The newest first. */
  history: PromptHistoryItem[];
}

/** Every bullet the user edits in the writing style and the knowledge base, as `composition` and
 * `knowledgeBase` hold them. */
function editableBullets(composition: string, knowledgeBase: string): string[] {
  const sections = displayedSections("composition");
  return [...parse("composition", composition).bullets.filter((bullet) => sections.includes(bullet.section)), ...parse("kb", knowledgeBase).bullets].map((bullet) => bullet.text);
}

export function personalizationState(prompts: UserPrompts): PersonalizationState {
  const now = new Set(editableBullets(prompts.composition, prompts.knowledgeBase));
  return {
    writingStyle: sectionHeaders.composition.map(([section, title]) => ({ section, title, shown: prompts.shown("composition", section) })),
    knowledgeBase: prompts.shown("kb", ""),
    history: prompts.history
      .map((entry) => {
        const then = new Set(editableBullets(entry.composition, entry.kb));
        return {
          id: entry.id,
          timestamp: entry.timestamp,
          source: entry.source,
          fields: entry.fields,
          restores: [...then].filter((bullet) => !now.has(bullet)),
          removes: [...now].filter((bullet) => !then.has(bullet)),
        };
      })
      .reverse(),
  };
}
