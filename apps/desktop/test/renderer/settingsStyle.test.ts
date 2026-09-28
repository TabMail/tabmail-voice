// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/** `settings.css` without comments. */
const css = readFileSync(join(import.meta.dirname, "../../src/renderer/settings.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The block `@media <query>` opens, or "" when there is none. */
function mediaBlock(query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}" && --depth === 0) return css.slice(open + 1, index);
  }
  return "";
}

/** Each rule in `text`: its selectors and its declarations. */
function rules(text: string): { selectors: string[]; body: string }[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors = "", body = ""]) => ({ selectors: selectors.split(",").map((selector) => selector.trim()), body }));
}

/** The selectors whose rules in `text` declare `declaration`. */
function declaring(text: string, declaration: RegExp): string[] {
  return rules(text)
    .filter((rule) => declaration.test(rule.body))
    .flatMap((rule) => rule.selectors);
}

/** A selector's specificity as one comparable number: ids, then classes and pseudo-classes, then
 * elements (enough for this stylesheet's selectors). */
function specificity(selector: string): number {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes = selector.match(/\.[\w-]+|:(?!:)[\w-]+|\[[^\]]+\]/g)?.length ?? 0;
  const elements = selector.replace(/#[\w-]+|\.[\w-]+|:+[\w-]+(\([^)]*\))?|\[[^\]]+\]/g, " ").match(/[a-z][\w-]*/gi)?.length ?? 0;
  return ids * 10_000 + classes * 100 + elements;
}

describe("Settings stylesheet", () => {
  /** White text sits only on the darkened gradient (4.5:1, `brand.test.ts`): the plain gradient only
   * under the switch's thumb, no text. Small text isn't the faint secondary grey. */
  test("text on the brand colours keeps its contrast", () => {
    expect(declaring(css, /var\(--brand-gradient\)/)).toEqual(["input.switch:checked"]);
    expect(declaring(css, /var\(--brand-text-gradient\)/).sort()).toEqual([".settings button.default", ".sidebar button.nav.selected"]);
    expect(css).not.toContain("--secondary");
    expect(declaring(css, /color:\s*var\(--text\)/)).toContain(".identity .identity-account");
    expect(specificity(".identity .identity-account")).toBeGreaterThan(specificity(".caption"));
    // Chromium's own focus ring, which keeps its contrast on every background here.
    expect(css).not.toMatch(/:focus-visible/);
  });

  /** The page is clear for the frosted sidebar whichever of it and `form.css` (`html, body` in the
   * page's colour) loads last: each selector outranks theirs. */
  test("the page stays clear above form.css", () => {
    const clear = rules(css).find((rule) => /background:\s*transparent/.test(rule.body) && /height:\s*100%/.test(rule.body));
    expect(clear?.selectors).toHaveLength(3);
    for (const selector of clear?.selectors ?? []) expect(specificity(selector)).toBeGreaterThan(specificity("html"));
  });

  /** A Windows contrast theme drops the gradients and forces colours: the switch is the system's
   * checkbox, the chosen section is in the system's selection colours, and the attention mark in
   * the text colour, so none of them vanishes. */
  test("switches, the chosen section and attention marks show in contrast themes", () => {
    const forced = mediaBlock("(forced-colors: active)");
    expect(declaring(forced, /appearance:\s*auto/)).toContain("input.switch");
    expect(declaring(forced, /background:\s*SelectedItem;/)).toContain(".sidebar button.nav.selected");
    expect(declaring(forced, /background:\s*CanvasText/)).toContain(".attention");
    expect(declaring(forced, /background:\s*SelectedItemText/)).toContain(".nav.selected .attention");
  });
});
