// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AppSettings } from "../settings.js";

/** A change the users who set the app up before it are told about once, at launch (owner,
 * 2026-10-03: "a one time notice, sort of a what's new page"). */
export interface WhatsNewEntry {
  /** Stored once shown (`AppSettings.whatsNewSeen`): never renamed. */
  id: string;
  title: string;
  detail: string;
}

export const whatsNewEntries: readonly WhatsNewEntry[] = [
  {
    // ADR-DESK-048. The welcome wizard's consent page says the same to new users.
    id: "longDictations",
    title: "Dictate for up to ten minutes",
    detail:
      "A long dictation is now sent in parts while you speak, so its text is ready as soon as you finish. The parts are handled like any dictation and aren’t kept: they’re only sent sooner.",
  },
];

/**
 * The entries to show at this launch, marked shown as they are taken, so each shows once. A user who
 * has not finished the welcome wizard is shown none, and they are marked shown: its consent page
 * already says what they say.
 */
export function takeWhatsNew(settings: AppSettings, entries: readonly WhatsNewEntry[] = whatsNewEntries): WhatsNewEntry[] {
  const seen = settings.whatsNewSeen;
  const unseen = entries.filter((entry) => !seen.includes(entry.id));
  if (unseen.length === 0) return [];
  settings.whatsNewSeen = [...seen, ...unseen.map((entry) => entry.id)];
  return settings.hasFinishedWelcome ? unseen : [];
}
