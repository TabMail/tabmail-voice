// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AccountModel, withFreshToken } from "./account.js";
import type { CompletionsClient, CompletionsMessage } from "./backend.js";
import * as config from "./config.js";
import { elapsed, errorName, log } from "./log.js";
import type { ScreenContext } from "./screenContext.js";
import { charCount, trimWhitespace } from "./text.js";
import { withTimeout } from "./timeout.js";

/**
 * The backend pass over a transcript: with what was on screen when the dictation started, it fixes
 * speech-recognition errors (names and terms shown on screen, capitalisation that doesn't fit where
 * the text lands), removes filler words and accidentally repeated words, and corrects grammar,
 * changing nothing else. The instructions live in the backend prompt `config.cleanupPrompt`.
 */
export const DictationCleanup = {
  /** The transcript cleaned up, requested under the account `userId` that transcribed it. When the
   * cleanup fails for any reason, including that account no longer being signed in or no reply
   * within `timeout` ms, the transcript as heard (also when cancelled): a failed cleanup never costs the user their
   * dictation (ADR-DESK-008). */
  async cleanUp(
    transcript: string,
    context: ScreenContext | null,
    client: CompletionsClient,
    account: AccountModel,
    userId: string | null,
    timeout: number = config.cleanupTimeout,
    /** The dictation's: aborts the request as soon as the dictation is cancelled. */
    signal?: AbortSignal,
  ): Promise<string> {
    const message = DictationCleanup.message(transcript, context);
    const started = performance.now();
    try {
      const text = trimWhitespace(
        await withTimeout(timeout, (deadline) => {
          const either = signal ? AbortSignal.any([deadline, signal]) : deadline;
          return withFreshToken(account, userId, (token) => client.complete(message, token, either));
        }),
      );
      log.debug(() => `DictationCleanup: cleaned up in ${elapsed(started)} (${charCount(transcript)} → ${charCount(text)} chars, screen text ${charCount(message.vars.screen_text ?? "")} chars)`);
      // The prompt removes only fillers and repetitions, and returns a dictation of nothing but
      // fillers as given, so an empty reply is a malfunction.
      if (text === "") {
        log.error("DictationCleanup: empty reply; pasting the transcript as heard");
        return transcript;
      }
      log.content("DictationCleanup: cleaned text", text);
      return text;
    } catch (error) {
      log.error(`DictationCleanup: failed after ${elapsed(started)}: ${errorName(error)}; pasting the transcript as heard`);
      return transcript;
    }
  },

  /** The prompt and its variables. Anything not known is sent empty; the prompt reads an empty
   * field as unknown. */
  message(dictation: string, context: ScreenContext | null): CompletionsMessage {
    return {
      role: "system",
      content: config.cleanupPrompt,
      vars: {
        dictation,
        app_name: context?.appName ?? "",
        web_host: context?.host ?? "",
        terminal_program: context?.terminalProgram ?? "",
        window_title: context?.windowTitle ?? "",
        screen_text: context?.renderedText ?? "",
      },
    };
  },
};
