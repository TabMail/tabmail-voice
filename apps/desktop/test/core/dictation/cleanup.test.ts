// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { screenVariables } from "../../../src/core/agent/tools.js";
import { DictationCleanup, textAroundCaret } from "../../../src/core/dictation/cleanup.js";
import * as config from "../../../src/core/config.js";
import type { ScreenContext } from "../../../src/core/dictation/screenContext.js";
import { CancellationError, sleep, TimeoutError, withTimeout } from "../../../src/core/util/timeout.js";
import { screen } from "../../support/screens.js";

describe("DictationCleanup.variables", () => {
  test("sends where the dictation goes, what is on screen and the dictionary", () => {
    const context = screen({
      appName: "Example Notes",
      host: "notes.example.com",
      terminalProgram: "example-shell",
      windowTitle: "Weekly sync",
      renderedText: "## Agenda\n» Ask Jordan about the ‸",
    });

    // The backend's cleanup prompt variables, all but the transcript (the backend's).
    expect(DictationCleanup.variables(context, ["Xyvora", "Kaelthorne Draszek"])).toEqual({
      app_name: "Example Notes",
      web_host: "notes.example.com",
      terminal_program: "example-shell",
      window_title: "Weekly sync",
      screen_text: "## Agenda\n» Ask Jordan about the ‸",
      dictionary: "Xyvora\nKaelthorne Draszek",
    });
  });

  /** The backend refuses the whole dictation when a cleanup field is over its limit (its ADR-027),
   * counted in UTF-16 code units, and a window title is whatever the app or web page sets: every
   * field is cut to the limit, its start kept, between characters. */
  test("every field stays within the backend's limit", () => {
    const limit = config.cleanupFieldMaxLength;
    // An emoji is two code units: one straddling the limit is left out whole.
    const long = `${"t".repeat(limit - 1)}😀tail`;
    const variables = DictationCleanup.variables(
      screen({ appName: long, host: long, terminalProgram: long, windowTitle: long, renderedText: "» ‸" }),
      Array.from({ length: limit }, () => "w"),
    );

    expect(variables.window_title).toBe("t".repeat(limit - 1));
    for (const [key, value] of Object.entries(variables)) expect(value.length, key).toBeLessThanOrEqual(limit);
    expect(variables.dictionary).toHaveLength(limit);
  });

  test("a field at the limit is sent whole", () => {
    const title = "t".repeat(config.cleanupFieldMaxLength);
    expect(DictationCleanup.variables(screen({ windowTitle: title }), []).window_title).toBe(title);
  });

  /** The screen text is cut around the caret between characters, so a character of many code units
   * (a letter with combining marks) can carry it past the limit. */
  test("a screen of long characters stays within the limit", () => {
    const heavy = `a${"\u0301".repeat(config.cleanupFieldMaxLength)}`;
    const variables = DictationCleanup.variables(screen({ renderedText: `» ${heavy}‸` }), []);

    expect(textAroundCaret(screen({ renderedText: `» ${heavy}‸` })).length).toBeGreaterThan(config.cleanupFieldMaxLength);
    expect(variables.screen_text.length).toBeLessThanOrEqual(config.cleanupFieldMaxLength);
  });

  /** Without Accessibility access there is no context: the prompt still gets every field, empty. */
  test("without context every field is empty", () => {
    expect(DictationCleanup.variables(null, [])).toEqual({
      app_name: "", web_host: "", terminal_program: "", window_title: "", screen_text: "", dictionary: "",
    });
  });
});

/** The cleanup gets only the text around the caret (owner, 2026-09-28: the whole screen made it
 * slow); agent mode still gets the whole screen. */
describe("the cleanup's screen text", () => {
  const before = "b".repeat(config.cleanupContextBefore);
  const after = "a".repeat(config.cleanupContextAfter);
  const page = `## Inbox\n${"An earlier message on screen.\n".repeat(200)}`;
  const rendered = `${page}» Dear Alex,\n» ${before}‸${after}\n» ${"More of the draft. ".repeat(100)}\n[Send]`;
  /** The screen text for `renderedText`, as the helper read it. */
  const around = (renderedText: string, fields: Partial<ScreenContext> = {}) => textAroundCaret(screen({ renderedText, ...fields }));

  test("is the text within its reach of the caret, markers kept", () => {
    const text = around(rendered);
    expect(text).toBe(`${before}‸${after}`);
    expect(DictationCleanup.variables(screen({ renderedText: rendered }), []).screen_text).toBe(text);
  });

  /** Near the start or end of the screen it takes what there is: the text before the field too. */
  test("reaches past the field's start and stops at the screen's ends", () => {
    expect(around("## Agenda\n» Ask Jordan about the ‸")).toBe("## Agenda\n» Ask Jordan about the ‸");
    const short = `Lunch with Sam?\n» Sure, ‸ works\n[Send]`;
    expect(around(short)).toBe(short);
  });

  /** The dictation replaces a selection, so the cleanup gets the caret alone (owner, 2026-09-28), and
   * its reach counts no selected text. */
  test("leaves a selection out", () => {
    expect(around("» Note: ‸Ship it Friday.‸ Thanks", { selectedText: "Ship it Friday." })).toBe("» Note: ‸ Thanks");
    expect(around("» Hi Sam,\n» ‸the first line\n» and the second‸ of it", { selectedText: "the first line\nand the second" })).toBe("» Hi Sam,\n» ‸ of it");
    expect(around("» Hi ‸a\r\nb‸ c", { selectedText: "a\r\nb" })).toBe("» Hi ‸ c");
    const selected = "s".repeat(config.cleanupContextAfter * 2);
    expect(around(`» ${"x".repeat(1_000)}${before}‸${selected}‸${after} Thanks`, { selectedText: selected })).toBe(`${before}‸${after}`);
  });

  /** A field's CRLF is one character to the helper, which prefixes only the line it starts. */
  test("finds the caret after a CRLF in the field", () => {
    const crlf = "## Inbox\n» Hi Sam,\r\nThanks for the ‸ notes\n[Send]";
    expect(around(crlf)).toBe(crlf);
  });

  /** A cut never splits a character: an emoji or accented letter at the edge is kept whole or left
   * out whole. */
  test("cuts between characters", () => {
    const family = "👩‍👩‍👧";
    const edgeBefore = `${family}${"b".repeat(config.cleanupContextBefore - 1)}`;
    const edgeAfter = `${"a".repeat(config.cleanupContextAfter - 1)}${family}`;
    const text = around(`» x${edgeBefore}‸${edgeAfter}y`);
    expect(text.startsWith("b") || text.startsWith(family)).toBe(true);
    expect(text.endsWith("a") || text.endsWith(family)).toBe(true);
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((segment) => segment.segment)).not.toContain("\u200d");
    expect(text).toContain("‸");
  });

  /** Only the focused field's lines hold the helper's marker; the marker on a page line is the
   * page's own text. */
  test("takes the marker on the focused field only", () => {
    expect(around("A page about the ‸ character\n» Hello ‸")).toBe("A page about the ‸ character\n» Hello ‸");
    const tail = " ‸ in the page\n» Hello ";
    expect(around(`${"x".repeat(1_000)}${tail}‸`)).toBe(`${"x".repeat(config.cleanupContextBefore - tail.length)}${tail}‸`);
  });

  /** Without the helper's marker (a terminal without tmux keeps its lines as a plain field), the
   * caret goes on its line as the helper read it around the caret, the last one on screen with that
   * text (owner, 2026-09-28: never no screen for want of the marker). */
  test("finds the caret's line on screen when the helper marked none", () => {
    const terminal = "Last login: today\n> $ ls\n> notes.txt\n> $ ls\n> notes.txt\n> $ git sta";
    expect(around(terminal, { textBeforeCaret: "$ ls\nnotes.txt\n$ git sta" })).toBe(`${terminal}‸`);
    expect(around(terminal, { textBeforeCaret: "notes.txt\n$ ls", textAfterCaret: "\r\n" })).toBe("Last login: today\n> $ ls\n> notes.txt\n> $ ls‸\n> notes.txt\n> $ git sta");
    // The screen drops a line's trailing blanks; the caret stays within the line.
    expect(around("> $ git status\n> On branch main", { textBeforeCaret: "$ git ", textAfterCaret: "status   \nOn branch main" })).toBe("> $ git ‸status\n> On branch main");
    expect(around("> $ ls\n> notes.txt", { textBeforeCaret: "$ ls   " })).toBe("> $ ls‸\n> notes.txt");
    expect(around("> $ git status\n> On branch main", { textBeforeCaret: "$ git ", textAfterCaret: "status\r\nOn branch main" })).toBe("> $ git ‸status\n> On branch main");
    // Only a whole field line: the caret's text inside a word, a longer line or a page line is not its line.
    expect(around("## Chat\nYesterday we shipped it", { textBeforeCaret: "Yes" })).toBe("## Chat\nYesterday we shipped it\n» Yes‸");
    expect(around("> $ git status --short", { textBeforeCaret: "$ git status" })).toBe("> $ git status --short\n» $ git status‸");
    expect(around("$ ls\n> notes.txt", { textBeforeCaret: "$ ls" })).toBe("$ ls\n> notes.txt\n» $ ls‸");
    const long = `${"x".repeat(1_000)}\n> $ git sta`;
    expect(around(long, { textBeforeCaret: "$ git sta" })).toBe(`${long.slice(-config.cleanupContextBefore)}‸`);
  });

  /** The screen still shows a selection the dictation replaces: the caret's line is found with it,
   * then it is cut from the screen, as the helper's marked selection is (owner, 2026-09-28). */
  test("finds the caret's line with its selection, and leaves the selection out", () => {
    expect(around("> Hello world\n> Next", { textBeforeCaret: "Hello ", selectedText: "world", textAfterCaret: "\nNext" })).toBe("> Hello ‸\n> Next");
    expect(around("> $ echo one\n> two three\n> done", { textBeforeCaret: "$ echo ", selectedText: "one\ntwo", textAfterCaret: " three\ndone" })).toBe("> $ echo ‸ three\n> done");
    expect(around("> $ echo one\n> two three", { textBeforeCaret: "$ echo ", selectedText: "one\r\ntwo", textAfterCaret: " three" })).toBe("> $ echo ‸ three");
    expect(around("> Hi there\n> Next", { textBeforeCaret: "Hi ", selectedText: "there\n", textAfterCaret: "Next" })).toBe("> Hi ‸Next");
    // The screen drops the selection's trailing blanks; the cut stays within the line.
    expect(around("> $ ls\n> notes.txt", { textBeforeCaret: "$ ls", selectedText: "   " })).toBe("> $ ls‸\n> notes.txt");
    // The last run of lines; a line elsewhere without the selection is not its line.
    expect(around("> Hello world\n> Hello world\n> Next", { textBeforeCaret: "Hello ", selectedText: "world" })).toBe("> Hello world\n> Hello ‸\n> Next");
    expect(around("> Hello \n> Next", { textBeforeCaret: "Hello ", selectedText: "world" })).toBe("> Hello \n> Next\n» Hello ‸");
    // Every line of the run: a lower run that differs only in a middle or last line is not the caret's.
    expect(around("> $ echo one\n> two\n> done\n> $ echo one\n> XXX\n> done", { textBeforeCaret: "$ echo ", selectedText: "one\ntwo\ndone" })).toBe("> $ echo ‸\n> $ echo one\n> XXX\n> done");
    expect(around("> Hello world\n> Next\n> Hello world\n> other", { textBeforeCaret: "Hello ", selectedText: "world\nNext" })).toBe("> Hello ‸\n> Hello world\n> other");
  });

  /** A caret line with no text is not found on some blank line of the screen: its field is added. */
  test("does not search the screen for a blank caret line", () => {
    const terminal = "> $ make\n> \n> built\n> $ ls";
    expect(around(terminal, { textBeforeCaret: "$ make\n\nbuilt\n$ ls\n" })).toBe(`${terminal}\n» $ make\n» \n» built\n» $ ls\n» ‸`);
    expect(around(terminal, { textBeforeCaret: "$ ls\n  ", textAfterCaret: " " })).toBe(`${terminal}\n» $ ls\n»   ‸ `);
  });

  /** When the caret's line is not on screen either (a walk that stopped before the field), the
   * field as the helper read it follows the screen, as the focused field. */
  test("adds the field after the screen when its line is not there", () => {
    expect(around("## Chat\nAn earlier reply", { textAfterCaret: "Ask anything" })).toBe("## Chat\nAn earlier reply\n» ‸Ask anything");
    expect(around("## Chat", { textBeforeCaret: "Dear Sam,\nThanks for the", textAfterCaret: " notes" })).toBe("## Chat\n» Dear Sam,\n» Thanks for the‸ notes");
    expect(around("## Chat", { textBeforeCaret: "the ", selectedText: "old words", textAfterCaret: " here" })).toBe("## Chat\n» the ‸ here");
    expect(around("## Chat", { textBeforeCaret: "Dear Sam,\r\nThanks for the", textAfterCaret: " notes" })).toBe("## Chat\n» Dear Sam,\r\nThanks for the‸ notes");
    expect(around("## Inbox\nA page with no field")).toBe("## Inbox\nA page with no field\n» ‸");
    expect(around("")).toBe("» ‸");
    const long = "x".repeat(1_000);
    expect(around(long, { textAfterCaret: "y".repeat(1_000) })).toBe(`${"x".repeat(config.cleanupContextBefore - 3)}\n» ‸${"y".repeat(config.cleanupContextAfter)}`);
  });

  test("is empty without a screen read", () => {
    expect(textAroundCaret(null)).toBe("");
  });

  test("leaves agent mode the whole screen", () => {
    expect(screenVariables("summarise this", screen({ renderedText: rendered })).screen_text).toBe(rendered);
  });
});

/** The timeout returns the operation's error or its own deadline error, even if the operation
 * cannot respond to cancellation. */
describe("withTimeout", () => {
  /** Cleanup's fallback hides error types; callers of the timeout must still get the original error. */
  test("passes through the operation's error", async () => {
    const failure = new Error("example");
    await expect(withTimeout(30_000, () => Promise.reject(failure))).rejects.toBe(failure);
  });

  /** The deadline releases the caller without waiting for an operation that ignores its signal. */
  test("times out without waiting for an operation that ignores cancellation", async () => {
    let signalled: AbortSignal | undefined;
    const started = performance.now();
    const result = withTimeout(200, (signal) => {
      signalled = signal;
      return new Promise<string>(() => {});
    });

    const error = await result.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).duration).toBe(200);
    expect((error as TimeoutError).message).toBe("Operation timed out after 200ms");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(signalled?.aborted).toBe(true);
  });

  test("sleep ends early when its signal aborts", async () => {
    const controller = new AbortController();
    const sleeping = sleep(30_000, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toBeInstanceOf(CancellationError);
    await expect(sleep(10, controller.signal)).rejects.toBeInstanceOf(CancellationError);
  });
});

/** What gets pasted: the backend's cleanup, or the transcript as heard whenever the cleanup failed. */
describe("DictationCleanup.pasted", () => {
  const transcript = "ask jordan about the road map";

  test("pastes the cleaned-up text, trimmed", () => {
    expect(DictationCleanup.pasted(transcript, " Ask Jordan about the roadmap.\n")).toBe("Ask Jordan about the roadmap.");
  });

  /** Only an empty cleanup is a failure; even one character can be the whole dictation. */
  test("a single-character cleanup is still used", () => {
    expect(DictationCleanup.pasted(transcript, "é")).toBe("é");
  });

  /** The backend answers an empty `cleaned_text` when the cleanup failed or ran past its deadline. */
  test("an empty or blank cleanup pastes the transcript as heard", () => {
    expect(DictationCleanup.pasted(transcript, "")).toBe(transcript);
    expect(DictationCleanup.pasted(transcript, " \n ")).toBe(transcript);
  });

  /** A backend that returned no cleanup at all (one from before the cleanup moved into the
   * transcription request). */
  test("no cleanup returned pastes the transcript as heard", () => {
    expect(DictationCleanup.pasted(transcript, null)).toBe(transcript);
  });
});
