// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { CleanupVariables } from "../backend/transcription.js";
import * as config from "../config.js";
import { log } from "../log.js";
import { unspacedScript } from "./chunkJoin.js";
import type { ScreenContext, TerminalViewport } from "./screenContext.js";
import { charCount, trimWhitespace } from "../util/text.js";

/**
 * The backend pass over a transcript: with the text around the caret when the dictation started, it fixes
 * speech-recognition errors (names and terms shown on screen, capitalization that doesn't fit where
 * the text lands), removes filler words and accidentally repeated words, and corrects grammar,
 * changing nothing else. The instructions live in the backend prompt `system_prompt_dictate_cleanup`,
 * which the backend runs in the transcription request, under its own deadline (backend ADR-027).
 */
export const DictationCleanup = {
  /** The backend prompt, run by the backend in the transcription request, and by the app itself over
   * a long dictation's joined text (`POST /completions/chat`, its `dictation` variable). */
  prompt: "system_prompt_dictate_cleanup",
  /** The cleanup's variables, sent with the recording. Anything not known is sent empty; the prompt
   * reads an empty field as unknown. */
  variables(context: ScreenContext | null, dictionary: readonly string[]): CleanupVariables {
    return {
      app_name: withinLimit(context?.appName ?? ""),
      web_host: withinLimit(context?.host ?? ""),
      terminal_program: withinLimit(context?.terminalProgram ?? ""),
      window_title: withinLimit(context?.windowTitle ?? ""),
      screen_text: withinLimit(textAroundCaret(context)),
      // One word per line: a dictionary word holds no line break (`dictionaryWord`).
      dictionary: withinLimit(dictionary.join("\n")),
    };
  },

  /** What to paste for `transcript`: the backend's cleanup of it, or the transcript as heard when the
   * cleanup failed, ran out of time or was not returned (`cleanedText` empty or null). A failed
   * cleanup never costs the user their dictation (ADR-DESK-008). */
  pasted(transcript: string, cleanedText: string | null): string {
    const text = cleanedText === null ? "" : trimWhitespace(cleanedText);
    // The prompt removes only fillers and repetitions, and returns a dictation of nothing but
    // fillers as given, so an empty cleanup is a failure.
    if (text === "") {
      log.error(`DictationCleanup: ${cleanedText === null ? "no cleanup returned" : "cleanup failed or timed out"}; pasting the transcript as heard`);
      return transcript;
    }
    log.debug(() => `DictationCleanup: cleaned up (${charCount(transcript)} → ${charCount(text)} chars)`);
    log.content("DictationCleanup: cleaned text", text);
    return text;
  },
};

/** What a dictation is spaced from when the caret is right after it (owner, 2026-10-05): a delimiter, or
 * a closing bracket. Not an opening one: what is dictated there goes inside it. */
const spacedDelimiter = /[,;:.…!?\p{Pe}]$/u;
/** Quotes that close a quotation: a run of them after a word or a mark ('hi'│, “Done.”│, students'│,
 * "he said 'no'"│), not after a space, a line's start or an opening bracket (said "│, (“│, said "'│),
 * where they open one. Which way a quote is drawn doesn't count (owner, 2026-10-05): „Hallo“│ closes,
 * and so does a quote typed the wrong way round. */
const closingQuote = /[^\s\p{Ps}"'\p{Pi}\p{Pf}]["'\p{Pi}\p{Pf}]+$/u;
/** What a dictation starts with to be spaced from one: a letter, a digit, a currency sign, an opening
 * bracket, Spanish ¿ ¡, or quotes that open a quotation, told as at the caret by what is next to them
 * rather than how they are drawn: followed by one of those (”Hej”, »Hallo«, "hi"), not by a space or
 * punctuation (" and left). */
const spacedStart = /^["'\p{Pi}\p{Pf}]*[\p{L}\p{N}\p{Sc}\p{Ps}¿¡]/u;
/** The last letter or digit of a text, and the first: the script on each side of the caret (a bracket,
 * a quote or a digit belongs to none). */
const lastLetter = /[\p{L}\p{N}](?=[^\p{L}\p{N}]*$)/u;
const firstLetter = /[\p{L}\p{N}]/u;

/** `text` as pasted at a caret right after `textBeforeCaret` (the focused field's, read at key-down):
 * with a space ahead of it when that ends with a delimiter, a closing bracket or a closing quote, so
 * "Note:" and "buy milk" give "Note: buy milk". Unchanged otherwise: after a space, a word, an opening
 * bracket or an opening quote, with no field read, before punctuation, or in a script written without
 * spaces. */
export function spacedFromCaret(textBeforeCaret: string, text: string): string {
  const closes = spacedDelimiter.test(textBeforeCaret) || closingQuote.test(textBeforeCaret);
  // No space where either side is written without spaces, as where a long dictation's chunks meet.
  const sides = [lastLetter.exec(textBeforeCaret)?.[0] ?? "", firstLetter.exec(text)?.[0] ?? ""];
  if (!closes || !spacedStart.test(text) || sides.some((letter) => unspacedScript.test(letter))) return text;
  log.debug("DictationCleanup: a space added after the delimiter or closing mark before the caret");
  return ` ${text}`;
}

/** `value` within the backend's limit on a cleanup field (`config.cleanupFieldMaxLength`), its start
 * kept, cut between characters. Bounds the cleanup model's input only. */
function withinLimit(value: string): string {
  if (value.length <= config.cleanupFieldMaxLength) return value;
  return value.slice(0, characters.segment(value).containing(config.cleanupFieldMaxLength)?.index);
}

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
 * one inserted caret marker where the dictation goes. Empty without a screen read or an exact terminal caret. */
export function textAroundCaret(context: ScreenContext | null): string {
  if (context === null) return "";
  const placed = context.terminalViewport === undefined ? placeCaret(context) : placeTerminalCaret(context.terminalViewport);
  if (placed === null) return "";
  const { text, caret } = placed;
  const segments = characters.segment(text);
  const start = caret <= config.cleanupContextBefore ? 0 : (segments.containing(caret - config.cleanupContextBefore)?.index ?? 0);
  const afterCaret = caret + caretMarker.length + config.cleanupContextAfter;
  const end = afterCaret >= text.length ? text.length : (segments.containing(afterCaret)?.index ?? text.length);
  return text.slice(start, end);
}

/** A typed terminal anchor is authoritative. Unavailable means no around-caret
 * context; the complete safe viewport remains available for Answer and debug. */
function placeTerminalCaret(viewport: TerminalViewport): { text: string; caret: number } | null {
  if (viewport.caret.status !== "exact") return null;
  const rendered = viewport.renderedText;
  const at = viewport.caret.renderedOffset;
  const boundary = (offset: number): boolean => Number.isSafeInteger(offset) && offset >= 0 && offset <= rendered.length
    && !(offset > 0 && offset < rendered.length && /[\uD800-\uDBFF]/.test(rendered[offset - 1] ?? "") && /[\uDC00-\uDFFF]/.test(rendered[offset] ?? ""));
  if (!boundary(at)) return null;
  const surfaceID = viewport.caret.surface;
  const surface = viewport.surfaces.find((item) => item.id === surfaceID);
  const runID = viewport.caret.run;
  const run = surface?.runs.find((item) => item.id === runID);
  if (run === undefined || viewport.caret.offset < 0 || viewport.caret.offset > run.text.length
      || run.renderedOffset + viewport.caret.offset !== at
      || !boundary(run.renderedOffset) || !boundary(run.renderedOffset + run.text.length)
      || rendered.slice(run.renderedOffset, run.renderedOffset + run.text.length) !== run.text) return null;
  const ranges = viewport.selectionComplete && surface?.selection.complete === true ? surface.selection.ranges : [];
  let sourceOffset = 0;
  let caret = at;
  let text = "";
  for (const range of ranges) {
    const start = range.renderedStart;
    const end = range.renderedEnd;
    if (range.redacted || !boundary(start) || !boundary(end) || start < sourceOffset || end < start) return null;
    text += rendered.slice(sourceOffset, start);
    caret -= Math.max(0, Math.min(at, end) - Math.min(at, start));
    sourceOffset = end;
  }
  text += rendered.slice(sourceOffset);
  return { text: text.slice(0, caret) + caretMarker + text.slice(caret), caret };
}

/**
 * The screen with one caret marker where the dictation goes, and where it is. A selection is left
 * out: the dictation replaces it (owner, 2026-09-28). The caret is, in order:
 * - the helper's marker on the focused field's lines;
 * - else, when the helper placed none (a terminal without tmux, a focused element that is
 *   no field, or a walk that stopped before the field), on the caret's line as the helper read it around the caret, selection included as the
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
