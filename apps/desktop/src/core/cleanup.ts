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
 * The backend pass over a transcript: with the text around the caret when the dictation started, it fixes
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
        screen_text: textAroundCaret(context),
      },
    };
  },
};

/** How the helper marks the caret in the rendered screen (`ScreenContext.caretMarker`), and the
 * prefix of the focused field's lines, where the caret is. */
const caretMarker = "‸";
const focusedLinePrefix = "» ";
/** The prefix of another field's lines: where a terminal without tmux keeps its lines. */
const fieldLinePrefix = "> ";

const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Lines split as the helper's Swift does: a CRLF is one character there, not a line break. */
const lineBreak = /(?<!\r)\n/;

/** The screen within `config.cleanupContextBefore` before the caret and `config.cleanupContextAfter`
 * after it, cut between characters: the paragraph the dictation lands in and what is around it, with
 * one caret marker where the dictation goes (`placeCaret`). Empty only without a screen read. */
export function textAroundCaret(context: ScreenContext | null): string {
  if (context === null) return "";
  const { text, caret } = placeCaret(context);
  const segments = characters.segment(text);
  const start = caret <= config.cleanupContextBefore ? 0 : (segments.containing(caret - config.cleanupContextBefore)?.index ?? 0);
  const afterCaret = caret + caretMarker.length + config.cleanupContextAfter;
  const end = afterCaret >= text.length ? text.length : (segments.containing(afterCaret)?.index ?? text.length);
  return text.slice(start, end);
}

/**
 * The screen with one caret marker where the dictation goes, and where it is. A selection is left
 * out: the dictation replaces it (owner, 2026-09-28). The caret is, in order:
 * - the helper's marker on the focused field's lines;
 * - else, when the helper placed none (a terminal without tmux, or a walk that stopped before the
 *   field), on the caret's line as the helper read it around the caret, selection included as the
 *   screen still shows it, found on screen as whole field lines (`> `), the last such; the selection
 *   is then cut from the screen;
 * - else, after the screen, the field as the helper read it around the caret, as a focused field.
 */
function placeCaret(context: ScreenContext): { text: string; caret: number } {
  const rendered = context.renderedText;
  const marked = markerIndex(rendered);
  if (marked !== -1) {
    // The helper brackets a selection with a marker on each side; keep the first.
    const selection = context.selectedText === "" ? 0 : focusedLines(context.selectedText).length - focusedLinePrefix.length + caretMarker.length;
    log.debug("DictationCleanup: caret marked on screen");
    return { text: rendered.slice(0, marked + caretMarker.length) + rendered.slice(marked + caretMarker.length + selection), caret: marked };
  }
  // The caret's lines as the screen shows them, the selection still there, whatever ends them.
  const before = context.textBeforeCaret.split(/\r?\n/).at(-1) ?? "";
  const after = context.textAfterCaret.split(/\r?\n/)[0] ?? "";
  const shown = `${before}${context.selectedText}${after}`;
  const found = shown.trim() === "" ? null : fieldLinesSpan(rendered, shown.split(/\r?\n/), before.length, context.selectedText);
  if (found !== null) {
    log.debug("DictationCleanup: caret's line found on screen");
    return { text: rendered.slice(0, found.caret) + caretMarker + rendered.slice(found.end), caret: found.caret };
  }
  const head = rendered === "" ? "" : `${rendered}\n`;
  log.debug("DictationCleanup: caret's field added after the screen");
  return { text: head + focusedLines(`${context.textBeforeCaret}${caretMarker}${context.textAfterCaret}`), caret: head.length + focusedLines(context.textBeforeCaret).length };
}

/** Where the caret goes, and where the selection after it ends, on the last run of field lines (`> `)
 * of `rendered` that are `lines` (trailing blanks aside), the caret `beforeCaret` code units into the
 * first; null without one. Whole lines only: the caret's text inside another word or line is not its
 * line. */
function fieldLinesSpan(rendered: string, lines: string[], beforeCaret: number, selection: string): { caret: number; end: number } | null {
  const screen = rendered.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of screen) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const field = (index: number): string | null => {
    const text = screen[index];
    return text?.startsWith(fieldLinePrefix) === true ? text.slice(fieldLinePrefix.length) : null;
  };
  for (let first = screen.length - lines.length; first >= 0; first -= 1) {
    if (!lines.every((line, index) => field(first + index)?.trimEnd() === line.trimEnd())) continue;
    const last = first + lines.length - 1;
    const caret = (starts[first] ?? 0) + fieldLinePrefix.length + Math.min(beforeCaret, (lines[0] ?? "").trimEnd().length);
    const endColumn = lines.length === 1 ? beforeCaret + selection.length : (selection.split(/\r?\n/).at(-1) ?? "").length;
    const end = (starts[last] ?? 0) + fieldLinePrefix.length + Math.min(endColumn, (field(last) ?? "").length);
    return { caret, end };
  }
  return null;
}

/** `text` as the helper renders the focused field: each line prefixed. */
function focusedLines(text: string): string {
  return text.split(lineBreak).map((line) => `${focusedLinePrefix}${line}`).join("\n");
}

/** Where the caret marker is on the focused field's lines, or -1: a marker elsewhere is the page's
 * own text. */
function markerIndex(rendered: string): number {
  let lineStart = 0;
  for (const line of rendered.split(lineBreak)) {
    const at = line.startsWith(focusedLinePrefix) ? line.indexOf(caretMarker) : -1;
    if (at !== -1) return lineStart + at;
    lineStart += line.length + 1;
  }
  return -1;
}
