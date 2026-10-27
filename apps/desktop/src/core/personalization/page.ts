// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { compositionSections, extractBullets, extractSection } from "./bulletMerge.js";
import type { PromptField, PromptHistorySource, UserPrompts } from "./prompts.js";

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
  /** The writing style's sections, in order, each with its bullets. */
  writingStyle: { section: string; bullets: string[] }[];
  knowledgeBase: string[];
  /** The newest first. */
  history: PromptHistoryItem[];
}

/** Every bullet of the writing style's sections and of the knowledge base: what the user edits. */
function editableBullets(composition: string, knowledgeBase: string): string[] {
  return [...compositionSections.flatMap((section) => extractBullets(extractSection(composition, section))), ...extractBullets(knowledgeBase)];
}

export function personalizationState(prompts: UserPrompts): PersonalizationState {
  const composition = prompts.composition;
  const knowledgeBase = prompts.knowledgeBase;
  const now = new Set(editableBullets(composition, knowledgeBase));
  return {
    writingStyle: compositionSections.map((section) => ({ section, bullets: extractBullets(extractSection(composition, section)) })),
    knowledgeBase: extractBullets(knowledgeBase),
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
