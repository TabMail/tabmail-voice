// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { generatedRedactors, redactorDefinitions, swiftRedactors } from "../../scripts/gen-redactors.mjs";

const shared = join(__dirname, "../../native/shared/privacy");

interface Case {
  name: string;
  text: string[];
  expected: string[];
}

const { placeholder, redactors } = redactorDefinitions();
const cases = (JSON.parse(readFileSync(join(shared, "redaction-cases.json"), "utf8")) as { cases: Case[] }).cases;
const joined = (fragments: string[]) => fragments.map((fragment) => (fragment === "{redacted}" ? placeholder : fragment)).join("");

/** The length of the hostile texts, and how long redacting one may take: a pattern scanned again from
 * every position needs minutes at this length, a linear one milliseconds. */
const hostileLength = 200_000;
const hostileMilliseconds = 2_000;

/** redactors.json as this platform's regex engine applies it: every redactor, in order. */
function redact(text: string, applied = redactors): string {
  return applied.reduce((current, redactor) => current.replace(new RegExp(redactor.pattern, redactor.ignoreCase ? "gi" : "g"), redactor.replacement), text);
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
    ["a run of the word Bearer", "Bearer "],
    ["a run of key prefixes", "-sk-a"],
    ["a run of spaces after a name", "password" + " ".repeat(64)],
    ["one long word", "a"],
  ])("%s is redacted in time proportional to its length", (_what, unit) => {
    const text = unit.repeat(Math.ceil(hostileLength / unit.length));
    const started = performance.now();
    redact(text);
    expect(performance.now() - started).toBeLessThan(hostileMilliseconds);
  });

  test("the cases include text that changes and text that stays", () => {
    expect(cases.some((item) => joined(item.text) !== joined(item.expected))).toBe(true);
    expect(cases.some((item) => joined(item.text) === joined(item.expected) && joined(item.text) !== "")).toBe(true);
    expect(new Set(cases.map((item) => item.name)).size).toBe(cases.length);
  });

  /** No line of the shared files, or of a generated one, is shaped like a key a scanner would flag. */
  test("no case holds a whole secret on one line of the file", () => {
    const raw = readFileSync(join(shared, "redaction-cases.json"), "utf8");
    for (const line of raw.split("\n")) expect(redact(line)).toBe(line);
  });
});

describe("the redactor generator", () => {
  const one = (overrides: Record<string, unknown>) =>
    JSON.stringify({ placeholder: "[redacted]", redactors: [{ name: "example", description: "An example.", pattern: "abc[0-9]{4,}", ignoreCase: false, replacement: "{placeholder}", ...overrides }] });

  test("writes each redactor as a Swift raw string, the placeholder filled in", () => {
    const swift = swiftRedactors(one({ pattern: '(a"b)\\s', replacement: "$1{placeholder}" }));
    expect(swift).toContain('Redactor(name: #"example"#, pattern: #"(a"b)\\s"#, ignoreCase: false, replacement: #"$1[redacted]"#),');
    expect(swift).toContain('static let placeholder = #"[redacted]"#');
  });

  test("a pattern holding a quote and a hash gets a longer delimiter", () => {
    expect(swiftRedactors(one({ pattern: 'a"#b' }))).toContain('pattern: ##"a"#b"##');
  });

  test.each([
    ["a lookbehind", { pattern: "(?<=a)b" }],
    ["a named group", { pattern: "(?<name>a)" }],
    ["a Unicode class", { pattern: "\\p{L}+" }],
    ["an inline flag", { pattern: "(?i)abc" }],
    ["a possessive repeat", { pattern: "a++" }],
    ["an atomic group", { pattern: "(?>a)" }],
    ["a backreference", { pattern: "(a)\\1" }],
    ["a word boundary", { pattern: "\\babc" }],
    ["a not-a-word-boundary", { pattern: "\\Babc" }],
    ["the word class", { pattern: "\\w+" }],
    ["the digit class", { pattern: "abc\\d+" }],
    ["a replacement naming a group the pattern lacks", { replacement: "$1{placeholder}" }],
    ["a replacement naming a group past the pattern's last", { pattern: "(a)bc", replacement: "$1{placeholder}$2" }],
    ["a replacement naming group zero", { pattern: "(a)bc", replacement: "$0{placeholder}" }],
    ["a pattern that doesn't compile", { pattern: "a(" }],
    ["a replacement without the placeholder", { replacement: "$1" }],
    ["a name with capitals", { name: "Example" }],
    ["no description", { description: "" }],
    ["a flag that is no boolean", { ignoreCase: "yes" }],
  ])("refuses %s", (_what, overrides) => {
    expect(() => redactorDefinitions(one(overrides))).toThrow();
  });

  test("refuses a name used twice, no redactors, and a placeholder a replacement template would misread", () => {
    const redactor = { name: "example", description: "An example.", pattern: "abc", ignoreCase: false, replacement: "{placeholder}" };
    expect(() => redactorDefinitions(JSON.stringify({ placeholder: "[redacted]", redactors: [redactor, redactor] }))).toThrow(/twice/);
    expect(() => redactorDefinitions(JSON.stringify({ placeholder: "[redacted]", redactors: [] }))).toThrow();
    expect(() => redactorDefinitions(JSON.stringify({ placeholder: "$1", redactors: [redactor] }))).toThrow();
    expect(redactorDefinitions(JSON.stringify({ placeholder: "[redacted]", redactors: [redactor] })).redactors).toEqual([{ ...redactor, replacement: "[redacted]" }]);
  });
});
