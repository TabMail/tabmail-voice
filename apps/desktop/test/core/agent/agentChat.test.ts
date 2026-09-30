// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test, vi } from "vitest";
import { type AgentChat, appendTurn, chatTranscript, emptyChat, formattedReply, opensLink, type ReplyRun, remainingFraction, replyBlocks, revealSteps } from "../../../src/core/agent/agentChat.js";

const empty: AgentChat = emptyChat;

/** A run of `text` in the plain style, with `style` on top. */
function run(text: string, style: Partial<Omit<ReplyRun, "text">> = {}): ReplyRun {
  return { text, strong: false, emphasis: false, code: false, strikethrough: false, link: null, ...style };
}

describe("AgentChat", () => {
  /** The conversation as the prompts read it: each request and its reply, oldest first, with what a
   * tool other than Answer did with its text. */
  test("the transcript lists each turn with what its tool did", () => {
    let chat = appendTurn(empty, "what does this error mean", "answer", "The function is not defined yet.");
    chat = appendTurn(chat, "fix it", "edit", "defineIt()");
    chat = appendTurn(chat, "write that I fixed it", "compose", "Fixed.");
    chat = appendTurn(chat, "tell sam", "thunderbird", "Tell Sam it is fixed.");

    expect(chatTranscript(chat)).toBe(
      [
        "User: what does this error mean",
        "TabMail: The function is not defined yet.",
        "User: fix it",
        "TabMail [Replaced the selection]: defineIt()",
        "User: write that I fixed it",
        "TabMail [Pasted at the cursor]: Fixed.",
        "User: tell sam",
        "TabMail [Sent to TabMail in Thunderbird]: Tell Sam it is fixed.",
      ].join("\n"),
    );
    expect(chat.turns.map((turn) => turn.id)).toEqual([0, 1, 2, 3]);
  });

  test("an empty chat has an empty transcript", () => {
    expect(chatTranscript(empty)).toBe("");
  });

  /** The follow-up under way is shown until its turn is added; the window's timeout stays as it was. */
  test("adding a turn ends the pending request", () => {
    const chat = appendTurn({ ...empty, pendingRequest: "and tomorrow?", closesAt: 42 }, "and tomorrow?", "answer", "Tomorrow too.");

    expect(chat.pendingRequest).toBeNull();
    expect(chat.closesAt).toBe(42);
    expect(chat.turns).toEqual([{ id: 0, request: "and tomorrow?", tool: "answer", reply: "Tomorrow too." }]);
  });

  /** The timeout bar: full as the window opens, empty as it closes, and never outside that. */
  test.each([
    [30_000, 1],
    [15_000, 0.5],
    [0, 0],
    [-5_000, 0],
    [45_000, 1],
  ])("with %d ms left the bar is %d of its width", (left, fraction) => {
    const now = 1_000_000;
    expect(remainingFraction(now + left, now, 30_000)).toBe(fraction);
  });
});

describe("a reply's formatting", () => {
  /** Replies keep their inline Markdown as formatting, and a reply that is not Markdown stays as is. */
  test("replies render their inline Markdown", () => {
    expect(formattedReply("Use **`defineIt()`** first")).toEqual([run("Use "), run("defineIt()", { strong: true, code: true }), run(" first")]);
    expect(formattedReply("- one\n- two")).toEqual([run("- one\n- two")]);
  });

  test.each<[string, ReplyRun[]]>([
    ["*gently* now", [run("gently", { emphasis: true }), run(" now")]],
    ["_gently_ now", [run("gently", { emphasis: true }), run(" now")]],
    ["__firmly__", [run("firmly", { strong: true })]],
    ["~~old~~ new", [run("old", { strikethrough: true }), run(" new")]],
    ["*a **b** c*", [run("a ", { emphasis: true }), run("b", { emphasis: true, strong: true }), run(" c", { emphasis: true })]],
    ["``a ` b``", [run("a ` b", { code: true })]],
    ["`**not bold**`", [run("**not bold**", { code: true })]],
    ["\\*literal\\*", [run("*literal*")]],
  ])("%j is formatted", (reply, runs) => {
    expect(formattedReply(reply)).toEqual(runs);
  });

  /** Two spans of one kind, and a span after a blank line that follows another, are each formatted:
   * the search for a closing (and for a blank line) remembers what it found, and a remembered one
   * behind the next opening must be searched for again. Reusing it walked the reply without end, so
   * the walk is bounded: each step checks which delimiter starts there, and too many stop the test. */
  const mostSteps = 1_000;
  test.each<[string, ReplyRun[]]>([
    ["**a** and **b**", [run("a", { strong: true }), run(" and "), run("b", { strong: true })]],
    ["*a* and *b*", [run("a", { emphasis: true }), run(" and "), run("b", { emphasis: true })]],
    ["__a__ b __c__", [run("a", { strong: true }), run(" b "), run("c", { strong: true })]],
    ["~~a~~ b ~~c~~", [run("a", { strikethrough: true }), run(" b "), run("c", { strikethrough: true })]],
    ["*a* x\n\ny *b*", [run("a", { emphasis: true }), run(" x\n\ny "), run("b", { emphasis: true })]],
  ])("%j formats each span", (reply, runs) => {
    const startsWith = String.prototype.startsWith;
    let steps = 0;
    const walk = vi.spyOn(String.prototype, "startsWith").mockImplementation(function (this: string, ...args: Parameters<string["startsWith"]>) {
      steps += 1;
      if (steps > mostSteps) throw new Error("the reply was walked without end");
      return startsWith.apply(this, args);
    });
    let formatted: ReplyRun[];
    try {
      formatted = formattedReply(reply);
    } finally {
      walk.mockRestore();
    }
    expect(formatted).toEqual(runs);
  });

  /** What only looks like Markdown shows as written: an unclosed delimiter, a spaced one, a word's
   * underscores, a span across a blank line, and an empty span. */
  test.each(["2 * 3 * 4", "a ** b", "snake_case_name", "foo_bar_", "*a\n\nb*", "**", "`", "open *italic", "cost is $5 * 2", "[not a link]"])("%j stays as written", (reply) => {
    expect(formattedReply(reply)).toEqual([run(reply)]);
  });

  /** A reply's link opens only a web page: a reply carries the words on screen, so a file or app link
   * in it could come from whatever the user was looking at. */
  test.each([
    ["https://example.com/docs", true],
    ["http://example.com", true],
    ["HTTPS://example.com", true],
    ["file:///Applications/Calculator.app", false],
    ["example-app://open?item=1", false],
    ["javascript:alert(1)", false],
    ["mailto:someone@example.com", false],
    ["not a url", false],
  ])("%s opens: %s", (link, opens) => {
    expect(opensLink(link)).toBe(opens);
  });

  /** A reply's other links show as plain text, so nothing but a web page opens from the chat window. */
  test("a reply keeps only its web links", () => {
    const runs = formattedReply("See [the docs](https://example.com/docs), [the app](file:///Applications/Calculator.app) and <example-app://open>");

    expect(runs.map((part) => part.text).join("")).toBe("See the docs, the app and example-app://open");
    expect(runs.filter((part) => part.link !== null)).toEqual([run("the docs", { link: "https://example.com/docs" })]);
  });

  /** A malformed reply (delimiters or brackets that never close, many times over) shows as written,
   * each stretch of it searched a bounded number of times: every opening searching the rest of the
   * reply again took seconds for a long one. The searches are counted, not timed: a delimiter's
   * closing is searched for with `indexOf`, a link with its regular expression. */
  const openings = 2_000;
  test.each([
    ["*x ", "indexOf", 4 * openings],
    ["__x ", "indexOf", 4 * openings],
    ["~~x\n", "indexOf", 4 * openings],
    ["*x\n\n", "indexOf", 4 * openings],
    ["[", "link", 2],
    ["[x ", "link", 2],
  ] as const)("%j many times over is shown as written, searched in linear time", (piece, searched, most) => {
    const reply = `**a** ${piece.repeat(openings)}`;
    const searches = searched === "indexOf" ? vi.spyOn(String.prototype, "indexOf") : vi.spyOn(RegExp.prototype, "exec");
    try {
      const runs = formattedReply(reply);
      const calls = searched === "indexOf" ? searches.mock.calls.length : searches.mock.contexts.filter((regex) => (regex as RegExp).source.startsWith("^\\[")).length;
      expect(runs.map((run) => run.text).join("")).toBe(`a ${piece.repeat(openings)}`);
      expect(runs.slice(1).every((run) => !run.strong && !run.emphasis && !run.code && !run.strikethrough && run.link === null)).toBe(true);
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThanOrEqual(most);
    } finally {
      searches.mockRestore();
    }
  });

  /** A bracket that opens no link is skipped past its text only, not past the link after it. */
  test.each(["[x]", "[]", "[x\n"])("%j before a link leaves the link", (bracket) => {
    expect(formattedReply(`${bracket}[docs](https://example.com/docs)`)).toEqual([run(bracket), run("docs", { link: "https://example.com/docs" })]);
  });

  test("a web autolink and a link with a title are links, formatted inside", () => {
    expect(formattedReply('<https://example.com> or [**docs**](https://example.com/docs "Docs")')).toEqual([
      run("https://example.com", { link: "https://example.com" }),
      run(" or "),
      run("docs", { strong: true, link: "https://example.com/docs" }),
    ]);
  });
});

/** A reply laid out as Thunderbird's chat lays one out, to reveal a line or list item at a time. */
describe("a reply's blocks", () => {
  test("blank lines part paragraphs, and a line break is a new line of one", () => {
    const blocks = replyBlocks("First line\nsecond line\n\n\nNext paragraph\r\nits end\r\n");
    expect(blocks).toEqual([
      { kind: "paragraph", lines: ["First line", "second line"] },
      { kind: "paragraph", lines: ["Next paragraph", "its end"] },
    ]);
    expect(revealSteps(blocks)).toBe(4);
  });

  /** Bulleted and numbered items make lists, numbered from where the list starts; a line under an item
   * without a marker continues it; a change of kind starts a new list. */
  test("lists, their start and an item's continuation", () => {
    const blocks = replyBlocks("Options:\n- one\n* two\n  more of two\n+ three\n4. four\n5) five");
    expect(blocks).toEqual([
      { kind: "paragraph", lines: ["Options:"] },
      { kind: "list", ordered: false, start: 1, items: ["one", "two\nmore of two", "three"] },
      { kind: "list", ordered: true, start: 4, items: ["four", "five"] },
    ]);
    expect(revealSteps(blocks)).toBe(6);
  });

  test("a heading is its own block, a hash without a space is text", () => {
    expect(replyBlocks("## Plan\n#launch is Friday")).toEqual([
      { kind: "heading", text: "Plan" },
      { kind: "paragraph", lines: ["#launch is Friday"] },
    ]);
  });

  /** Text that only looks like a marker stays as written, and nothing is lost: every word of the
   * reply is in its blocks. */
  test.each(["2 * 3 = 6", "-dash first", "1.5 times", "", "   "])("%j stays as written", (reply) => {
    const blocks = replyBlocks(reply);
    expect(blocks).toEqual(reply.trim() === "" ? [] : [{ kind: "paragraph", lines: [reply] }]);
  });
});
