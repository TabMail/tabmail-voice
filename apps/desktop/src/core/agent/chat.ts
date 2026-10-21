// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AgentToolID, agentTools } from "./tools.js";

/** One request in the chat window and what came of it. */
export interface ChatTurn {
  id: number;
  /** What the user said. */
  request: string;
  /** The tool that carried it out. */
  tool: AgentToolID;
  /** The answer, or the text the tool pasted or sent. */
  reply: string;
  /** What its tools asked the user on the way, oldest first, each where it was asked. */
  questions: ChatQuestion[];
}

/** A question a tool asked before it sent or created anything, once answered: it stays in the chat
 * window where it was asked, the answer ticked on it, and the user's words under it when they
 * answered aloud (owner, 2026-10-20). */
export interface ChatQuestion {
  id: number;
  /** What it asked, and the calendar event drawn in place of the words (null for words alone). */
  text: string;
  event: EventQuestion | null;
  /** What the user said to it, when they answered aloud. */
  spoken: string | null;
  /** How it was settled: confirmed or declined (by a click, or by the model for an answer aloud),
   * or nothing done (its time ran out, or the model did nothing with the answer aloud); null while
   * the model reads an answer aloud. */
  answer: QuestionAnswer | null;
}

export type QuestionAnswer = "confirmed" | "declined" | "unanswered";

/**
 * The conversation in the chat window the pill grows into once the Answer tool replies: each request
 * and what came of it, oldest first. Kept in memory only, and gone when the window closes (root
 * ADR-004). A follow-up sends it to the backend as the prompts' `conversation`.
 */
export interface AgentChat {
  turns: ChatTurn[];
  /** The follow-up being carried out, shown until its turn is added. */
  pendingRequest: string | null;
  /** The questions it has asked and the user answered, shown under it until they join its turn. */
  questions: ChatQuestion[];
  /** When the window closes unless the user touches it (epoch milliseconds); null until an answer
   * joins it, and once they have touched it. */
  closesAt: number | null;
  /** Whether the user has touched the window (or followed up in it): it no longer times out, and
   * stays open until closed. */
  touched: boolean;
  /** What a tool the answer's model called is doing, while it runs ("Checking your calendar"). */
  activity: string | null;
  /** What the window asks before a tool sends or creates anything, until the user confirms or
   * declines it, or it goes unanswered until `confirmationExpiresAt`. */
  confirmation: string | null;
  /** The calendar event the question is about, drawn as a card in place of its words; null for a
   * question that is only words. */
  confirmationEvent: EventQuestion | null;
  /** When the question is declined unless answered (epoch milliseconds); null with no question, and
   * while an answer to it is spoken. */
  confirmationExpiresAt: number | null;
}

/** A calendar event in a question to confirm, as the chat window draws it: a small calendar page for
 * its day beside its title and time, then a line for everything else the question says (owner,
 * 2026-10-18, chosen from a page of candidates). The question's words still say all of it, for the
 * model when the user answers aloud. */
export interface EventQuestion {
  /** What confirming does: the button's word, and a delete's is red. */
  action: "add" | "change" | "delete";
  /** Above the page: "New event", "Change this occurrence", "Delete every occurrence". */
  caption: string;
  /** The page: the event's (or the occurrence's) day, as "Oct", 21 and "Wed". */
  month: string;
  day: number;
  weekday: string;
  title: string;
  /** A new title, which strikes out `title`. */
  newTitle: string | null;
  /** Its time on that day ("10:00 – 11:00 AM", "All day"), with the day when it ends on another. */
  time: string;
  /** A new time, which strikes out `time`. */
  newTime: string | null;
  lines: EventQuestionLine[];
}

/** One more thing a question about an event says, beside its icon. */
export interface EventQuestionLine {
  icon: "repeat" | "location" | "calendar" | "person" | "notes" | "availability" | "mail" | "deleted";
  text: string;
  /** After the text: a person's address (as strong as the name, since it is who is emailed), a
   * calendar's account (fainter). */
  detail: string | null;
  /** `added` for what the change brings (in the accent), `removed` for what it takes away (struck
   * out), `note` for what happens as a result (secondary), `plain` for the event as it is. */
  tone: "plain" | "added" | "removed" | "note";
}

/** The chat window as it opens: no turns yet, and untouched. */
export const emptyChat: AgentChat = { turns: [], pendingRequest: null, questions: [], closesAt: null, touched: false, activity: null, confirmation: null, confirmationEvent: null, confirmationExpiresAt: null };

/** Adds the request's turn, with the questions it asked on the way. */
export function appendTurn(chat: AgentChat, request: string, tool: AgentToolID, reply: string): AgentChat {
  return { ...chat, turns: [...chat.turns, { id: chat.turns.length, request, tool, reply, questions: chat.questions }], pendingRequest: null, questions: [] };
}

/** Ticks `answer` on question `id`, wherever it is (under the request still being carried out, or in
 * its turn by then), once: a question already settled keeps its answer. */
export function settleQuestion(chat: AgentChat, id: number, answer: QuestionAnswer): AgentChat {
  const settle = (questions: ChatQuestion[]) => questions.map((question) => (question.id === id && question.answer === null ? { ...question, answer } : question));
  return { ...chat, questions: settle(chat.questions), turns: chat.turns.map((turn) => ({ ...turn, questions: settle(turn.questions) })) };
}

/** The conversation as the backend prompts' `conversation` variable: each request and its reply,
 * oldest first, with what a tool other than Answer did with its text. */
export function chatTranscript(chat: AgentChat): string {
  return chat.turns
    .map((turn) => {
      const caption = agentTools[turn.tool].chatCaption;
      return `User: ${turn.request}\nTabMail${caption === null ? "" : ` [${caption}]`}: ${turn.reply}`;
    })
    .join("\n");
}

/** The share of an untouched chat window's time left at `now`: 1 as it opens, 0 as it closes. */
export function remainingFraction(closesAt: number, now: number, timeout: number): number {
  return Math.min(1, Math.max(0, (closesAt - now) / timeout));
}

/** Whether a reply's link stays a link: only a web page's. A reply carries the words on screen, so a
 * `file:` or app link in it could come from whatever the user was looking at. */
export function opensLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** A stretch of a reply in one style. */
export interface ReplyRun {
  text: string;
  strong: boolean;
  emphasis: boolean;
  code: boolean;
  strikethrough: boolean;
  /** A web page's address (`opensLink`); null for text that is no link. */
  link: string | null;
}

type RunStyle = Omit<ReplyRun, "text">;

const plain: RunStyle = { strong: false, emphasis: false, code: false, strikethrough: false, link: null };

/** A line's inline Markdown (bold, italics, code, strikethrough, links; its blocks are
 * `replyBlocks`'), as the answer prompt allows. A link that is not a web page's
 * shows as its text alone (`opensLink`). Text that doesn't parse shows as written. */
export function formattedReply(reply: string): ReplyRun[] {
  const runs: ReplyRun[] = [];
  for (const run of inlineRuns(reply, plain)) {
    const last = runs.at(-1);
    if (last && sameStyle(last, run)) last.text += run.text;
    else if (run.text !== "") runs.push({ ...run });
  }
  return runs;
}

/** A block of a reply, as TabMail's chat in Thunderbird lays one out (its `renderMarkdown`): a
 * paragraph's lines, a list's items, or a heading. Each line and item is inline Markdown
 * (`formattedReply`), and one step of the reply's reveal. */
export type ReplyBlock = { kind: "paragraph"; lines: string[] } | { kind: "list"; ordered: boolean; start: number; items: string[] } | { kind: "heading"; text: string };

const listItem = /^\s*(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const heading = /^\s*#{1,6}\s+(.*)$/;

/** A reply's blocks: paragraphs apart at blank lines, a line break kept as a new line of its
 * paragraph; a list of `-`, `*` or `+` items, or of numbered ones, a line under an item without a
 * marker continuing it; and a `#` heading. Anything else is a paragraph's text as written. */
export function replyBlocks(reply: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  let paragraph: string[] | null = null;
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  const close = () => {
    if (paragraph) blocks.push({ kind: "paragraph", lines: paragraph });
    if (list) blocks.push({ kind: "list", ...list });
    paragraph = null;
    list = null;
  };
  for (const line of reply.split(/\r\n|\r|\n/)) {
    if (line.trim() === "") {
      close();
      continue;
    }
    const item = listItem.exec(line);
    if (item) {
      const ordered = item[1] === undefined;
      if (!list || list.ordered !== ordered) {
        close();
        list = { ordered, start: ordered ? Number(item[2]) : 1, items: [] };
      }
      list.items.push(item[3] ?? "");
      continue;
    }
    const title = heading.exec(line);
    if (title) {
      close();
      blocks.push({ kind: "heading", text: title[1] ?? "" });
      continue;
    }
    if (list) {
      const last = list.items.length - 1;
      list.items[last] = `${list.items[last] ?? ""}\n${line.trim()}`;
      continue;
    }
    paragraph ??= [];
    paragraph.push(line);
  }
  close();
  return blocks;
}

/** How many steps a reply's reveal takes: one per paragraph line, list item and heading. */
export function revealSteps(blocks: readonly ReplyBlock[]): number {
  return blocks.reduce((sum, block) => sum + (block.kind === "paragraph" ? block.lines.length : block.kind === "list" ? block.items.length : 1), 0);
}

function sameStyle(a: RunStyle, b: RunStyle): boolean {
  return a.strong === b.strong && a.emphasis === b.emphasis && a.code === b.code && a.strikethrough === b.strikethrough && a.link === b.link;
}

const escapable = /[!-/:-@[-`{-~]/;
const autolink = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
const wordCharacter = /[\p{L}\p{N}]/u;

function inlineRuns(text: string, style: RunStyle): ReplyRun[] {
  const runs: ReplyRun[] = [];
  const closes = new Map<string, Found>();
  const blankLine = notSearched();
  // Where a link can't start before: a failed one's text ends at the first `]` or line break after
  // its `[`, and one opening before that ends there too, so fails the same way.
  let noLinkBefore = 0;
  let literal = "";
  const flush = () => {
    if (literal !== "") runs.push({ ...style, text: literal });
    literal = "";
  };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const character = text[index] ?? "";
    // A backslash keeps the punctuation after it as written.
    if (character === "\\" && escapable.test(text[index + 1] ?? "")) {
      literal += text[index + 1];
      index += 2;
      continue;
    }
    // Code: between runs of backticks of the same length, taken as written.
    if (character === "`") {
      const fence = /^`+/.exec(rest)?.[0] ?? "`";
      const close = text.indexOf(fence, index + fence.length);
      if (close > index + fence.length) {
        flush();
        runs.push({ ...style, code: true, text: text.slice(index + fence.length, close) });
        index = close + fence.length;
        continue;
      }
      literal += fence;
      index += fence.length;
      continue;
    }
    // A link: [text](address).
    if (character === "[" && index >= noLinkBefore) {
      const link = /^\[([^\]\n]+)\]\(\s*<?([^\s()<>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (!link) noLinkBefore = index + 1 + (/[\]\n]/.exec(rest.slice(1))?.index ?? rest.length);
      if (link) {
        flush();
        const address = link[2] ?? "";
        runs.push(...inlineRuns(link[1] ?? "", { ...style, link: opensLink(address) ? address : style.link }));
        index += link[0].length;
        continue;
      }
    }
    // An autolink: <scheme:address>.
    if (character === "<") {
      const link = autolink.exec(rest);
      if (link) {
        flush();
        const address = link[1] ?? "";
        runs.push({ ...style, text: address, link: opensLink(address) ? address : style.link });
        index += link[0].length;
        continue;
      }
    }
    // Bold, strikethrough, then italics, each closed by the same delimiter.
    const delimiter = ["**", "__", "~~", "*", "_"].find((candidate) => rest.startsWith(candidate));
    if (delimiter) {
      const span = delimitedSpan(text, index, delimiter, closes, blankLine);
      if (span !== null) {
        flush();
        const inner: RunStyle =
          delimiter === "~~" ? { ...style, strikethrough: true } : delimiter.length === 2 ? { ...style, strong: true } : { ...style, emphasis: true };
        runs.push(...inlineRuns(text.slice(index + delimiter.length, span), inner));
        index = span + delimiter.length;
        continue;
      }
      literal += delimiter;
      index += delimiter.length;
      continue;
    }
    literal += character;
    index += 1;
  }
  flush();
  return runs;
}

/** A search's answer, kept for the next: the first place at or after `from` it found, or null for
 * none. Openings are tried left to right, so the next search starts no earlier, and each stretch of
 * a reply is searched once however many openings share it: a malformed reply can't take quadratic
 * time. */
interface Found {
  from: number;
  at: number | null;
}

/** A search not made yet: every `from` comes before it. */
function notSearched(): Found {
  return { from: Number.POSITIVE_INFINITY, at: null };
}

/** The first place at or after `from` that `search` finds (`search` returns null for none),
 * answered from `found` when its search already covered it. */
function firstFrom(from: number, found: Found, search: (from: number) => number | null): number | null {
  if (from < found.from || (found.at !== null && from > found.at)) {
    found.from = from;
    found.at = search(from);
  }
  return found.at;
}

/** Where the span opened by `delimiter` at `start` closes, or null when it doesn't: it holds some
 * text, doesn't start or end with a space, and doesn't cross a blank line; an underscore within a
 * word (`snake_case`) opens and closes nothing. Where a delimiter can close doesn't depend on where
 * its span opened, so `closes` keeps each delimiter's last answer, and `blankLine` the blank line's. */
function delimitedSpan(text: string, start: number, delimiter: string, closes: Map<string, Found>, blankLine: Found): number | null {
  const open = start + delimiter.length;
  if (/\s/.test(text[open] ?? " ")) return null;
  if (delimiter.startsWith("_") && wordCharacter.test(text[start - 1] ?? "")) return null;
  const found = closes.get(delimiter) ?? notSearched();
  closes.set(delimiter, found);
  const close = firstFrom(open + 1, found, (from) => closing(text, from, delimiter));
  if (close === null) return null;
  const blank = firstFrom(open, blankLine, (from) => {
    const at = text.indexOf("\n\n", from);
    return at < 0 ? null : at;
  });
  return blank !== null && blank + 2 <= close ? null : close;
}

/** The first place at or after `from` where `delimiter` can close a span: not after a space, not
 * part of a double delimiter (`*a **b** c*`), and an underscore not within a word. */
function closing(text: string, from: number, delimiter: string): number | null {
  let search = from;
  for (;;) {
    const close = text.indexOf(delimiter, search);
    if (close < 0) return null;
    const afterClose = text[close + delimiter.length] ?? "";
    const doubled = delimiter.length === 1 && (afterClose === delimiter || text[close - 1] === delimiter);
    const intraword = delimiter.startsWith("_") && wordCharacter.test(afterClose);
    if (!/\s/.test(text[close - 1] ?? " ") && !doubled && !intraword) return close;
    search = close + 1;
  }
}
