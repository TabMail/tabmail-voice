// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { log } from "../log.js";

/**
 * Edits to the knowledge base as Thunderbird's add-on applies them (its `patchApplier.js`
 * `applyKBPatch`, which iOS's `KBPatchApplier` matches), ported rule for rule: a patch is one or
 * more `ADD` or `DEL` lines, each followed by the statement it adds or removes.
 */

/** `text` with the characters models and keyboards vary in made plain, as Thunderbird's
 * `normalizeUnicode`: NFKC; a dash that starts a line (after its indentation) a hyphen, so it
 * reads as a bullet (a dash within a line is left as written); curly quotes and primes straight;
 * fullwidth square brackets plain; other spaces a space; an ellipsis three dots. */
export function normalizeUnicode(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/(^|\n)([ \t]*)[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "$1$2-")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2032\u2035]/g, "'")
    .replace(/\u3010/g, "[")
    .replace(/\u3011/g, "]")
    .replace(/[\u00A0\u202F\u2007\u2008\u2009\u200A\u200B\u2028\u2029\u205F\u3000]/g, " ")
    .replace(/\u2026/g, "...");
}

interface Operation {
  operation: "ADD" | "DEL";
  content: string;
}

function isOperation(line: string): boolean {
  const word = line.trim().toUpperCase();
  return word === "ADD" || word === "DEL";
}

/** The patch's operations, each with the lines up to the next one; one with no lines is skipped. */
function operations(patch: string): Operation[] {
  const found: Operation[] = [];
  const lines = patch.trim().split("\n");
  let index = 0;
  while (index < lines.length) {
    const word = (lines[index] ?? "").trim().toUpperCase();
    if (word !== "ADD" && word !== "DEL") {
      index += 1;
      continue;
    }
    if (index + 1 >= lines.length) {
      log.debug("PatchApplier: an operation with nothing after it");
      break;
    }
    const content: string[] = [];
    let next = index + 1;
    while (next < lines.length && !isOperation(lines[next] ?? "")) {
      content.push(lines[next] ?? "");
      next += 1;
    }
    if (content.length > 0) found.push({ operation: word, content: content.join("\n").trim() });
    index = next;
  }
  return found;
}

/** A statement as a bullet: "- " before it, and a period after it if it has none. */
function normalizedContent(text: string): string {
  let normalized = text.startsWith("- ") ? text.substring(2).trim() : text.trim();
  if (!normalized.endsWith(".")) normalized += ".";
  return `- ${normalized}`;
}

/** `content` with one operation applied; null when it can't be (an empty statement, or one to
 * remove that isn't there). Adding a line already there, whatever its case, changes nothing. */
function applied(content: string, operation: Operation["operation"], text: string): string | null {
  if (!text) return null;
  const bullet = normalizedContent(text);
  const lines = content.split("\n");
  if (operation === "ADD") {
    const wanted = bullet.toLowerCase().trim();
    if (lines.some((line) => normalizeUnicode(line).toLowerCase().trim() === wanted)) return content;
    lines.push(bullet);
    return lines.join("\n");
  }
  // A line's final period, and the statement's, don't count: an entry may have one or not.
  const wanted = bullet.trim().toLowerCase().replace(/\.$/, "");
  const at = lines.findIndex((line) => line.trim().startsWith("- ") && normalizeUnicode(line).trim().toLowerCase().replace(/\.$/, "") === wanted);
  if (at === -1) return null;
  lines.splice(at, 1);
  return lines.join("\n");
}

/** The knowledge base `content` with `patch` applied; null when it has no operation, or one fails. */
export function applyKBPatch(content: string, patch: string): string | null {
  const found = operations(patch);
  if (found.length === 0) return null;
  let current: string | null = content;
  for (const { operation, content: text } of found) {
    current = applied(current, operation, text);
    if (current === null) {
      log.debug(`PatchApplier: ${operation} could not be applied`);
      return null;
    }
  }
  return current;
}
