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
    const swift = swiftRedactors(one({ pattern: 'a"b\\s', replacement: "$1{placeholder}" }));
    expect(swift).toContain('Redactor(name: #"example"#, pattern: #"a"b\\s"#, ignoreCase: false, replacement: #"$1[redacted]"#),');
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
