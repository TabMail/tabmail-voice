// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The knowledge base's and the writing style's bullets, read and merged as Thunderbird's add-on does
 * (its `bulletMerge.js`, which the iOS app's `PromptParser` matches): ported rule for rule, so the
 * three apps read, edit and merge the same texts alike.
 */

/** The writing style's sections, each under its header "# <section> (DO NOT EDIT/DELETE THIS SECTION
 * HEADER)", as Thunderbird and iOS name them. */
export const compositionSections: readonly string[] = ["General writing style", "Language", "Useful links to personal website and other resources"];

const headerMark = "DO NOT EDIT/DELETE THIS SECTION HEADER";
const instructionsEnd = "====END USER INSTRUCTIONS====";

/** The bullets of `text`: each line, trimmed, that starts with "- ", without it. */
export function extractBullets(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

function endsSection(line: string): boolean {
  return (line.startsWith("# ") && line.includes(headerMark)) || line.includes(instructionsEnd);
}

/** The text of the section `header` heads in `markdown`, up to the next header or the end of the
 * instructions, without the blank lines at either end; empty when there is no such section. */
export function extractSection(markdown: string, header: string): string {
  const content: string[] = [];
  let capturing = false;
  for (const line of markdown.split("\n")) {
    if (line.includes(header) && line.includes(headerMark)) {
      capturing = true;
      continue;
    }
    if (capturing) {
      if (endsSection(line)) break;
      content.push(line);
    }
  }
  while (content.length > 0 && (content[0] ?? "").trim() === "") content.shift();
  while (content.length > 0 && (content.at(-1) ?? "").trim() === "") content.pop();
  return content.join("\n");
}

/** `markdown` with the section `header` heads holding `newContent`, a blank line before the next
 * header; unchanged when there is no such section. */
export function replaceSection(markdown: string, header: string, newContent: string): string {
  const result: string[] = [];
  let skipping = false;
  for (const line of markdown.split("\n")) {
    if (line.includes(header) && line.includes(headerMark)) {
      result.push(line, newContent);
      skipping = true;
      continue;
    }
    if (skipping) {
      if (endsSection(line)) {
        result.push("", line);
        skipping = false;
      }
      continue;
    }
    result.push(line);
  }
  return result.join("\n");
}

/** A three-way merge of bullet lists: `local`'s, in its order, without those `remote` removed from
 * `base`, then those `remote` added to it, each once. */
export function mergeBullets(base: readonly string[], local: readonly string[], remote: readonly string[]): string[] {
  const baseSet = new Set(base);
  const remoteSet = new Set(remote);
  const remoteRemoved = new Set([...baseSet].filter((bullet) => !remoteSet.has(bullet)));
  const remoteAdded = new Set([...remoteSet].filter((bullet) => !baseSet.has(bullet)));
  const result = local.filter((bullet) => !remoteRemoved.has(bullet));
  const resultSet = new Set(result);
  for (const bullet of remote) {
    if (remoteAdded.has(bullet) && !resultSet.has(bullet)) {
      result.push(bullet);
      resultSet.add(bullet);
    }
  }
  return result;
}

/** A three-way merge of a flat bullet text (the knowledge base): `local` itself when the merge
 * changes none of its bullets, else the merged bullets, one per line. Lines that are no bullet are
 * not kept then. */
export function mergeFlatField(base: string, local: string, remote: string): string {
  const localBullets = extractBullets(local);
  const merged = mergeBullets(extractBullets(base), localBullets, extractBullets(remote));
  if (sameBullets(merged, localBullets)) return local;
  return merged.map((bullet) => `- ${bullet}`).join("\n");
}

function sameBullets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((bullet, index) => bullet === b[index]);
}
