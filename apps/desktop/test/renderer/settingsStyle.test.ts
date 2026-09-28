// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as config from "../../src/core/config.js";

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

/** The value `rule` (a rule in `text` with exactly that one selector) gives `property`. */
function value(text: string, selector: string, property: string): string | undefined {
  const rule = rules(text).find((candidate) => candidate.selectors.length === 1 && candidate.selectors[0] === selector);
  return rule?.body.match(new RegExp(`${property}:\\s*([^;]+);`))?.[1]?.trim();
}

/** WCAG's contrast ratio of `colour` (`#rrggbb` or `rgba(…)`) laid over the opaque `background`. */
function contrast(colour: string, background: string): number {
  const channels = (text: string): number[] => (text.startsWith("#") ? [1, 3, 5].map((start) => parseInt(text.slice(start, start + 2), 16)).concat(1) : (text.match(/[\d.]+/g) ?? []).map(Number));
  const [br = 0, bg = 0, bb = 0] = channels(background);
  const [r = 0, g = 0, b = 0, alpha = 1] = channels(colour);
  const over = [r * alpha + br * (1 - alpha), g * alpha + bg * (1 - alpha), b * alpha + bb * (1 - alpha)];
  const luminance = (rgb: number[]): number => {
    const [lr = 0, lg = 0, lb = 0] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  };
  const [lighter, darker] = [luminance(over), luminance([br, bg, bb])].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
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
   * under the switch's thumb, no text. The sidebar's account line is in the text colour. */
  test("text on the brand colours keeps its contrast", () => {
    expect(declaring(css, /var\(--brand-gradient\)/)).toEqual(["input.switch:checked"]);
    expect(declaring(css, /var\(--brand-text-gradient\)/).sort()).toEqual([".settings button.default", ".sidebar button.nav.selected"]);
    expect(declaring(css, /color:\s*var\(--text\)/)).toContain(".identity .identity-account");
    expect(specificity(".identity .identity-account")).toBeGreaterThan(specificity(".caption"));
  });

  /** In light mode the notes (`form.css`'s `.caption`, in `--secondary`) and "Allowed" hold small
   * text's 4.5:1 on the window's colour and on the white cards, set on `.settings` (inside `:root`,
   * so they hold whichever stylesheet loads last). */
  test("notes and Allowed keep small-text contrast in light mode", () => {
    const light = mediaBlock("(prefers-color-scheme: light)");
    const secondary = value(light, ".settings", "--secondary");
    const allowed = value(light, ".settings", "--allowed");
    expect(secondary).toBeDefined();
    expect(allowed).toBeDefined();
    for (const background of [config.settingsWindowColour.light, "#ffffff"]) {
      expect(contrast(secondary ?? "", background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(allowed ?? "", background)).toBeGreaterThanOrEqual(4.5);
    }
    // form.css's own values, which these replace, fall short.
    expect(contrast("rgba(0, 0, 0, 0.5)", config.settingsWindowColour.light)).toBeLessThan(4.5);
    expect(contrast("#28a745", "#ffffff")).toBeLessThan(4.5);
  });

  /** Focus is Chromium's own ring (the browser's default indicator, in the system accent), except in
   * a contrast theme, where the chosen section needs its own ring in a system colour, set off from
   * its fill. */
  test("focus shows on every background", () => {
    const forced = mediaBlock("(forced-colors: active)");
    expect(css.replace(forced, "")).not.toMatch(/:focus-visible/);
    expect(value(forced, ".sidebar button.nav:focus-visible", "outline")).toBe("2px solid CanvasText");
    expect(parseFloat(value(forced, ".sidebar button.nav:focus-visible", "outline-offset") ?? "0")).toBeGreaterThan(0);
  });

  /** On macOS the sidebar is the title bar (a drag region, which swallows clicks): its section
   * buttons are taken out of it, or none could be clicked. */
  test("the section buttons are clickable in the drag region", () => {
    expect(declaring(css, /-webkit-app-region:\s*drag/)).toEqual([".settings.mac .sidebar"]);
    expect(value(css, ".sidebar button.nav", "-webkit-app-region")).toBe("no-drag");
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

  /** The chosen section's label is white on its gradient, and hovering it keeps that gradient: the
   * hover's grey goes only on the other sections, whatever the rules' order. */
  test("the chosen section stays white on its gradient, hovered or not", () => {
    expect(value(css, ".sidebar button.nav.selected", "color")).toBe("white");
    expect(declaring(css, /background:\s*var\(--hover\)/)).toEqual([".sidebar button.nav:not(.selected):hover"]);
  });

  /** An off switch's white thumb stands out 3:1 from its track (a control's state, WCAG 1.4.11), on
   * the lightest card, in light mode. */
  test("an off switch's thumb stands out from its track", () => {
    expect(value(css, "input.switch::before", "background")).toBe("white");
    expect(value(css, "input.switch", "background")).toBe("var(--switch-off)");
    expect(contrast(value(css, ":root", "--switch-off") ?? "", "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  /** An on switch differs from an off one by its thumb's place, not colour alone: the thumb crosses
   * the track to the far inset. */
  test("an on switch's thumb moves to the far side", () => {
    const px = (selector: string, property: string) => parseFloat(value(css, selector, property) ?? "NaN");
    const travel = px("input.switch", "width") - px("input.switch::before", "width") - 2 * px("input.switch::before", "left");
    expect(travel).toBeGreaterThan(0);
    expect(value(css, "input.switch:checked::before", "transform")).toBe(`translateX(${travel}px)`);
  });
});
