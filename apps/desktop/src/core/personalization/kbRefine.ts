// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ChatTurn } from "../agent/chat.js";
import { type AccountModel, withFreshToken } from "../backend/account.js";
import type { CompletionsClient } from "../backend/completions.js";
import * as config from "../config.js";
import { elapsed, errorName, log } from "../log.js";
import { mergeFlatField } from "./bulletMerge.js";
import type { UserPrompts } from "./prompts.js";

/** A chat as the refine reads it: each request and its reply, `[USER]:` and `[AGENT]:`, as Thunderbird
 * and iOS write theirs. Only what was said: never the screen. */
export function refineChatHistory(turns: readonly ChatTurn[]): string {
  return turns.flatMap((turn) => [...(turn.request === "" ? [] : [`[USER]: ${turn.request}`]), ...(turn.reply === "" ? [] : [`[AGENT]: ${turn.reply}`])]).join("\n\n");
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The time `date` as the refine reads it, in this computer's zone: Thunderbird's date and time
 * followed by the zone's name, "Monday 2026/10/19 14:03:22 (America/Los_Angeles)". The backend reads
 * the date and time as UTC, which moves only its reminder-expiry cutoff, by hours against a retention
 * of days; the model reads the text with its zone. */
export function refineTime(date: Date, timeZone: string): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${weekdays[date.getDay()]} ${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} (${timeZone})`;
}

/**
 * Learns what a closed chat taught into the knowledge base (ADR-DESK-063), a port of iOS's
 * `KBRefinementService`: a chat of at least `kbRefineMinUserTurns` requests goes to the backend's
 * refine with the knowledge base as it was then, and what comes back is merged three ways into the
 * knowledge base as it is now (`mergeFlatField`), so an edit made meanwhile (in Settings or by
 * `kb_add`) stays; one answered after a Reset or Restore of the knowledge base is dropped. One at a time: a chat closed while one runs is not refined, as on iOS. Nothing
 * waits for it and nothing keeps it past a quit; a failure is only logged.
 */
export class KBRefiner {
  private running = false;

  constructor(private readonly prompts: UserPrompts) {}

  /** Refines with the chat's `turns`, for the account `userID` signed in when it closed; the merge is
   * dropped if another account is signed in by the time the backend answers. */
  async refine(turns: readonly ChatTurn[], client: CompletionsClient, account: AccountModel, userID: string | null): Promise<void> {
    if (turns.length < config.kbRefineMinUserTurns) {
      log.debug(`KBRefiner: ${turns.length} requests, fewer than ${config.kbRefineMinUserTurns}; not refined`);
      return;
    }
    if (this.running) {
      log.debug("KBRefiner: a refine is running; not refined");
      return;
    }
    this.running = true;
    const started = performance.now();
    try {
      const before = this.prompts.knowledgeBase;
      const replacements = this.prompts.knowledgeBaseReplacements;
      const refined = await withFreshToken(account, userID, (token) =>
        client.refineKB(
          {
            role: "system",
            content: config.kbRefinePrompt,
            vars: {
              current_user_kb_md: before,
              chat_history: refineChatHistory(turns),
              current_time: refineTime(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone),
              reminder_retention_days: config.kbRefineReminderRetentionDays,
              max_bullets: config.kbRefineMaxBullets,
            },
          },
          token,
        ),
      );
      if ((account.session?.userID ?? null) !== userID) {
        log.debug("KBRefiner: the account changed meanwhile; refine dropped");
        return;
      }
      if (this.prompts.knowledgeBaseReplacements !== replacements) {
        log.debug("KBRefiner: the knowledge base was reset or restored meanwhile; refine dropped");
        return;
      }
      const outcome = this.prompts.updateKnowledgeBase((now) => mergeFlatField(before, now, refined));
      log.debug(() => `KBRefiner: ${outcome} in ${elapsed(started)} (${before.length} -> ${this.prompts.knowledgeBase.length} chars)`);
    } catch (error) {
      log.error(`KBRefiner: refine failed: ${errorName(error)}`);
    } finally {
      this.running = false;
    }
  }
}
