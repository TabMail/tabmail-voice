// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { generatedRedactors, redactorDefinitions, swiftRedactors, windowsRedactors } from "../../scripts/gen-redactors.mjs";

const shared = join(__dirname, "../../native/shared/privacy");

interface Case {
  name: string;
  text: string[];
  expected: string[];
}

const { placeholder, redactors } = redactorDefinitions();
/** Several texts redacted together: each line's texts, in fragments as a case's text is. */
interface LineCase {
  name: string;
  lines: string[][][];
  expected: string[][][];
}

const { cases, lineCases } = JSON.parse(readFileSync(join(shared, "redaction-cases.json"), "utf8")) as { cases: Case[]; lineCases: LineCase[] };
const joined = (fragments: string[]) => fragments.map((fragment) => (fragment === "{redacted}" ? placeholder : fragment)).join("");

/** The length of the hostile texts, and how long redacting one may take: a pattern scanned again from
 * every position needs minutes at this length, a linear one milliseconds. */
const hostileLength = 200_000;
const hostileMilliseconds = 2_000;

/** redactors.json as this platform's regex engine applies it: every redactor, in order. */
function redact(text: string, applied = redactors): string {
  return applied.reduce((current, redactor) => current.replace(new RegExp(redactor.pattern, redactor.ignoreCase ? "gi" : "g"), redactor.replacement), text);
}

/** The helpers' redaction of several texts together, each keeping its share, as redaction-cases.json's
 * comment has it and `Redactor.redact` in the macOS helper does it: here to hold `lineCases` to
 * ECMAScript's engine too. */
function redactLines(lines: string[][]): string[][] {
  let text = lines.map((line) => line.join("")).join("\n");
  let position = 0;
  let ranges = lines.map((line) => {
    const places = line.map((item) => [position, (position += item.length)] as const);
    position += 1;
    return places;
  });
  for (const redactor of redactors) {
    const edits: { start: number; end: number; newStart: number; newEnd: number; keptStart: number; keptEnd: number }[] = [];
    let result = "";
    let copied = 0;
    for (const match of text.matchAll(new RegExp(redactor.pattern, redactor.ignoreCase ? "gi" : "g"))) {
      const replacement = match[0].replace(new RegExp(redactor.pattern, redactor.ignoreCase ? "i" : ""), redactor.replacement);
      const shorter = Math.min(match[0].length, replacement.length);
      let keptStart = 0;
      while (keptStart < shorter && match[0][keptStart] === replacement[keptStart]) keptStart += 1;
      let keptEnd = 0;
      while (keptEnd < shorter - keptStart && match[0].at(-1 - keptEnd) === replacement.at(-1 - keptEnd)) keptEnd += 1;
      result += text.slice(copied, match.index);
      edits.push({ start: match.index, end: match.index + match[0].length, newStart: result.length, newEnd: result.length + replacement.length, keptStart, keptEnd });
      result += replacement;
      copied = match.index + match[0].length;
    }
    result += text.slice(copied);
    const moved = (place: number): number => {
      let shift = 0;
      for (const edit of edits) {
        if (place <= edit.start) break;
        if (place < edit.end) {
          if (place - edit.start <= edit.keptStart) return edit.newStart + place - edit.start;
          return edit.newEnd - edit.keptEnd;
        }
        shift = edit.newEnd - edit.end;
      }
      return place + shift;
    };
    ranges = ranges.map((line) => line.map(([start, end]) => [moved(start), moved(end)] as const));
    text = result;
  }
  return ranges.map((line) => line.map(([start, end]) => text.slice(start, end)));
}

/** The helpers take secret-looking text out of what they read off the screen (ADR-DESK-046). What
 * looks like a secret is defined once, in redactors.json, and every helper's list is generated from
 * it; redaction-cases.json is what each must do with it. Here the definition is run against its own
 * cases on ECMAScript's engine, on every platform's test run, beside each helper's own suite. */
describe("the shared redactors", () => {
  test("each helper's generated list is what the generator writes (run `npm run gen:redactors`)", () => {
    const generated = generatedRedactors();
    expect(generated.length).toBeGreaterThan(0);
    for (const { path, contents } of generated) expect(readFileSync(path, "utf8")).toBe(contents);
  });

  test.each(cases.map((item) => [item.name, item] as const))("%s", (_name, item) => {
    expect(redact(joined(item.text))).toBe(joined(item.expected));
  });

  test("redacting twice is redacting once", () => {
    for (const item of cases) expect(redact(redact(joined(item.text)))).toBe(redact(joined(item.text)));
  });

  test.each(lineCases.map((item) => [item.name, item] as const))("several texts together: %s", (_name, item) => {
    expect(redactLines(item.lines.map((line) => line.map(joined)))).toEqual(item.expected.map((line) => line.map(joined)));
  });

  test("the cases of several texts are there, their names unlike", () => {
    expect(lineCases.length).toBeGreaterThanOrEqual(19);
    expect(new Set(lineCases.map((item) => item.name)).size).toBe(lineCases.length);
  });

  /** A redactor no case needs is one no helper is checked on. */
  test.each(redactors.map((redactor) => redactor.name))("without %s, a case fails", (name) => {
    const others = redactors.filter((redactor) => redactor.name !== name);
    expect(cases.some((item) => redact(joined(item.text), others) !== joined(item.expected))).toBe(true);
  });

  /** A case flag no case needs is one a helper could get wrong unseen. (The address's pattern has no
   * letters, so its flag changes nothing.) */
  test.each(redactors.filter((redactor) => /[A-Za-z]/.test(redactor.pattern.replaceAll(/\\s|\[[^\]]*\]/g, ""))).map((redactor) => redactor.name))("with %s's case flag flipped, a case fails", (name) => {
    const flipped = redactors.map((redactor) => (redactor.name === name ? { ...redactor, ignoreCase: !redactor.ignoreCase } : redactor));
    expect(cases.some((item) => redact(joined(item.text), flipped) !== joined(item.expected))).toBe(true);
  });

  /** Text read off the screen has no length limit and may be anyone's (a web page, a message), and
   * the helper redacts it with no deadline: each pattern must take time in proportion to the text.
   * A pattern scanned again from every position took minutes on these. */
  test.each([
    ["a dotted run", "a."],
    ["a run of secret names", "token:"],
    ["a run of token starts", "-eyJ"],
    ["a run of key headers", "-----BEGIN A "],
    ["a run of address starts", "://a:b"],
    ["a run of addresses with their at sign", "://a:b@"],
    ["a run of at signs before address starts", "@://a:b"],
    ["a run of the word Bearer", "Bearer "],
    ["a run of key prefixes", "-sk-a"],
    ["a run of spaces after a name", "password" + " ".repeat(64)],
    ["one long word", "a"],
    ["a key header naming its kind over and over", "PRIVATE KEY ", "-----BEGIN "],
    ["a key footer naming its kind over and over", "PRIVATE KEY ", "-----BEGIN PRIVATE KEY-----\n-----END "],
  ])("%s is redacted in time proportional to its length", (_what, unit, start = "") => {
    const text = start + unit.repeat(Math.ceil(hostileLength / unit.length));
    const started = performance.now();
    redact(text);
    expect(performance.now() - started).toBeLessThan(hostileMilliseconds);
  });

  /** A run far longer than any real text never stops a redactor short: what follows is still redacted
   * (the Mac helper's engine gave up on a repeat it runs a stack frame for per character). */
  test.each([
    ["a key's characters", "sk-"],
    ["a named value", "data token=7"],
    ["a bearer token", "Bearer "],
    ["a web token's first part", "eyJ"],
    ["a web token's second part", "eyJa.eyJ"],
    ["a web token's third part", "eyJa.eyJa."],
    ["an address's password", "://u:"],
    ["a key block's body", "-----BEGIN PRIVATE KEY-----\n"],
    ["a payment key", "sk_live_"],
    ["a GitLab token", "glpat-"],
    ["a Slack token", "xoxb-"],
  ])("a very long run of %s does not stop the redaction of what follows", (_what, start) => {
    // (A key block cut off takes the letters after it, the name with them.)
    expect(redact(`${start}${"a".repeat(400_000)}\npassword: hunter${"2x"}\n`).endsWith(`: ${placeholder}\n`)).toBe(true);
  });

  test("the cases include text that changes and text that stays", () => {
    expect(cases.some((item) => joined(item.text) !== joined(item.expected))).toBe(true);
    expect(cases.some((item) => joined(item.text) === joined(item.expected) && joined(item.text) !== "")).toBe(true);
    expect(new Set(cases.map((item) => item.name)).size).toBe(cases.length);
  });

  /** No line of the cases file is shaped like a key a scanner would flag. */
  test("no case holds a whole secret on one line of the file", () => {
    const raw = readFileSync(join(shared, "redaction-cases.json"), "utf8");
    for (const line of raw.split("\n")) expect(redact(line)).toBe(line);
  });
});

describe("the redactor generator", () => {
  const one = (overrides: Record<string, unknown>) =>
    JSON.stringify({ placeholder: "[redacted]", redactors: [{ name: "example", description: "An example.", pattern: "abc[0-9]{4}", ignoreCase: false, replacement: "{placeholder}", ...overrides }] });

  test("writes Windows UTF-16 rules from the same definitions, escaping raw-string delimiters", () => {
    const cpp = windowsRedactors(one({ pattern: '(a)tm"b', replacement: "{placeholder}" }));
    expect(cpp).toContain('uR"tmx((a)tm"b)tmx"');
    expect(cpp).toContain('uR"tm([redacted])tm"');
    expect(cpp).toContain('"example"');
  });

  test("writes each redactor as a Swift raw string, the placeholder filled in", () => {
    const swift = swiftRedactors(one({ pattern: '(a"b)\\s', replacement: "$1{placeholder}" }));
    expect(swift).toContain('Redactor(name: #"example"#, pattern: #"(a"b)\\s"#, ignoreCase: false, replacement: #"$1[redacted]"#),');
    expect(swift).toContain('static let placeholder = #"[redacted]"#');
  });

  test("a pattern holding a quote and a hash gets a longer delimiter", () => {
    expect(swiftRedactors(one({ pattern: 'a"#b' }))).toContain('pattern: ##"a"#b"##');
  });

  const unshared = /uses regex syntax the helpers don't share/;
  const group = /replacement names group/;

  test("a pattern or a name holding a backslash and a hash gets a longer delimiter", () => {
    expect(swiftRedactors(one({ pattern: "a\\#b" }))).toContain('pattern: ##"a\\#b"##');
  });

  test.each([
    ["a lookbehind", { pattern: "(?<=a)b" }, unshared],
    ["a negative lookbehind", { pattern: "(?<!a)b" }, unshared],
    ["a named group", { pattern: "(?<name>a)" }, unshared],
    ["a named group as Python writes it", { pattern: "(?P<name>a)" }, unshared],
    ["a Unicode class", { pattern: "\\p{L}" }, unshared],
    ["a Unicode class negated", { pattern: "\\P{L}" }, unshared],
    ["a named backreference", { pattern: "(a)\\k<a>" }, unshared],
    ["a match reset", { pattern: "a\\Kb" }, unshared],
    ["the end of the last match", { pattern: "\\Gabc" }, unshared],
    ["the start of the text", { pattern: "\\Aabc" }, unshared],
    ["the end of the text", { pattern: "abc\\z" }, unshared],
    ["the end of the text before a line break", { pattern: "abc\\Z" }, unshared],
    ["an inline flag", { pattern: "(?i)abc" }, unshared],
    ["a possessive repeat", { pattern: "a++" }, unshared],
    ["a possessive star", { pattern: "a*+" }, unshared],
    ["a possessive optional", { pattern: "a?+" }, unshared],
    ["a possessive counted repeat", { pattern: "a{2}+" }, unshared],
    ["an atomic group", { pattern: "(?>a)" }, unshared],
    ["a backreference", { pattern: "(a)\\1" }, unshared],
    ["a word boundary", { pattern: "\\babc" }, unshared],
    ["a not-a-word-boundary", { pattern: "\\Babc" }, unshared],
    ["the word class", { pattern: "\\w" }, unshared],
    ["the not-a-word class", { pattern: "\\W" }, unshared],
    ["the digit class", { pattern: "abc\\d" }, unshared],
    ["the not-a-digit class", { pattern: "abc\\D" }, unshared],
    ["an open-ended count", { pattern: "[a-z]{16,}" }, /gives up on/],
    ["a repeated space class outside a class", { pattern: "a\\s*b" }, /gives up on/],
    ["a space class repeated at least once outside a class", { pattern: "a\\s+b" }, /gives up on/],
    ["a replacement naming a group the pattern lacks", { replacement: "$1{placeholder}" }, group],
    ["a replacement naming a group past the pattern's last", { pattern: "(a)bc", replacement: "$1{placeholder}$2" }, group],
    ["a replacement naming group zero", { pattern: "(a)bc", replacement: "$0{placeholder}" }, group],
    ["a pattern that doesn't compile", { pattern: "a(" }, /Invalid regular expression/],
    ["a replacement without the placeholder", { pattern: "(a)bc", replacement: "$1" }, /must hold \{placeholder\}/],
    ["an empty replacement", { replacement: "" }, /must hold \{placeholder\}/],
    ["a name with capitals", { name: "Example" }, /lowercase words/],
    ["no description", { description: "" }, /needs a description/],
    ["a flag that is no boolean", { ignoreCase: "yes" }, /needs pattern, ignoreCase and replacement/],
    ["a pattern that is no text", { pattern: 7 }, /needs pattern, ignoreCase and replacement/],
    ["a replacement that is no text", { replacement: 7 }, /needs pattern, ignoreCase and replacement/],
  ])("refuses %s", (_what, overrides, message) => {
    expect(() => redactorDefinitions(one(overrides))).toThrow(message);
  });

  test("reads the syntax the helpers share", () => {
    const pattern = "(^|[^A-Za-z0-9_])(?:ab|cd)[a-z]{2}[a-z]*[\\s]+\\sx*y?(?=z)(?!q)";
    expect(redactorDefinitions(one({ pattern, replacement: "$1{placeholder}" })).redactors[0]).toMatchObject({ pattern, replacement: "$1[redacted]" });
  });

  test("refuses a name used twice, no redactors, and a placeholder that is empty or a replacement template would misread", () => {
    const redactor = { name: "example", description: "An example.", pattern: "abc", ignoreCase: false, replacement: "{placeholder}" };
    const placeholder = /`placeholder` must be text/;
    expect(() => redactorDefinitions(JSON.stringify({ placeholder: "[redacted]", redactors: [redactor, redactor] }))).toThrow(/twice/);
    expect(() => redactorDefinitions(JSON.stringify({ placeholder: "[redacted]", redactors: [] }))).toThrow(/at least one/);
    expect(() => redactorDefinitions(JSON.stringify({ placeholder: "[redacted]" }))).toThrow(/at least one/);
    expect(() => redactorDefinitions(JSON.stringify({ placeholder: "$1", redactors: [redactor] }))).toThrow(placeholder);
    expect(() => redactorDefinitions(JSON.stringify({ placeholder: "a\\b", redactors: [redactor] }))).toThrow(placeholder);
    expect(() => redactorDefinitions(JSON.stringify({ placeholder: "", redactors: [redactor] }))).toThrow(placeholder);
    expect(() => redactorDefinitions(JSON.stringify({ redactors: [redactor] }))).toThrow(placeholder);
    expect(redactorDefinitions(JSON.stringify({ placeholder: "[redacted]", redactors: [redactor] })).redactors).toEqual([{ ...redactor, replacement: "[redacted]" }]);
  });
});
