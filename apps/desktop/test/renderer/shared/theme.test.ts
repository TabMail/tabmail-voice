// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { palette } from "../../../src/core/palette.js";
import { applyPalette, paletteStylesheet, themeVariables } from "../../../src/renderer/shared/theme.js";

const renderer = join(import.meta.dirname, "../../../src/renderer");

/** Every file under the renderer whose name ends with one of `extensions`, by its path there. */
function sources(extensions: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.set(relative(renderer, path), readFileSync(path, "utf8"));
    }
  };
  walk(renderer);
  return found;
}

/** `text` without comments, and in a stylesheet without its contrast-theme blocks, which name the
 * system's colors (`CanvasText`, `SelectedItem`) as a Windows contrast theme asks. */
function code(text: string): string {
  let stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (let start = stripped.indexOf("@media (forced-colors: active)"); start !== -1; start = stripped.indexOf("@media (forced-colors: active)")) {
    let depth = 0;
    let end = stripped.indexOf("{", start);
    for (; end < stripped.length; end += 1) {
      if (stripped[end] === "{") depth += 1;
      else if (stripped[end] === "}" && --depth === 0) break;
    }
    stripped = stripped.slice(0, start) + stripped.slice(end + 1);
  }
  return stripped;
}

/** A color written out: `#rgb`…`#rrggbbaa`, `rgb(0, …`/`hsl(…` with numbers (not `brand.ts`'s
 * `rgba(palette.…)`), or a named color. */
const literalColor = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[\d.]|(?<![\w-])(?:white|black|gray|grey|red|blue|green)(?![\w-])/;

afterEach(() => {
  document.adoptedStyleSheets = [];
});

/** The palette's colors the page was given: its constructed stylesheets' text. */
function adoptedColors(): string {
  return document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n");
}


describe("the palette", () => {
  /** A color is changed in `core/palette.ts` alone (owner, 2026-10-03: "a single sort of palette
   * theme"): no stylesheet, and no component but the brand's helpers and this module, writes one. */
  test("no stylesheet or component writes a color of its own", () => {
    const stylesheets = sources([".css"]);
    expect(stylesheets.size).toBeGreaterThanOrEqual(5);
    for (const [path, text] of stylesheets) expect(code(text).match(literalColor)?.[0], path).toBeUndefined();

    const components = sources([".ts", ".tsx"]);
    for (const [path, text] of components) {
      // brand.ts turns the palette's colors into CSS; a ring's mask is opaque, not a color shown.
      if (path === join("shared", "brand.ts")) continue;
      const shown = code(text).replace("transparent calc(100% - ${width}px), #000 calc(100% - ${width}px)", "");
      expect(shown.match(literalColor)?.[0], path).toBeUndefined();
    }
  });

  /** Every variable a stylesheet reads is declared there, in the palette's stylesheet, or set by its
   * component (a size, never a color), so no rule falls back to the browser's default. */
  test("every color a stylesheet reads is given", () => {
    const components = [...sources([".ts", ".tsx"]).values()].join("\n");
    const setByComponent = new Set([...components.matchAll(/\["(--[\w-]+)" as string\]/g)].map(([, name = ""]) => name));
    const given = new Set([...paletteStylesheet(true).matchAll(/(--[\w-]+):/g)].map(([, name = ""]) => name));
    expect(setByComponent).toEqual(new Set(["--reveal-rise"]));
    for (const [path, text] of sources([".css"])) {
      const declared = new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map(([, name = ""]) => name));
      for (const [, name = ""] of text.matchAll(/var\((--[\w-]+)/g)) expect(declared.has(name) || given.has(name) || setByComponent.has(name), `${path} reads ${name}`).toBe(true);
    }
  });

  /** The windows follow the system's light and dark, each theme in full; the overlay, light in light
   * and dark mode alike, has the light theme alone. */
  test("the windows follow light and dark, the overlay stays light", () => {
    expect(Object.keys(palette.dark).sort()).toEqual(Object.keys(palette.light).sort());
    const light = themeVariables(palette.light);
    expect(light["--control-border"]).toBe(palette.light.controlBorder);
    expect(light["--on-accent"]).toBe(palette.light.onAccent);

    applyPalette(document);
    applyPalette(document);
    expect(document.adoptedStyleSheets).toHaveLength(1);
    const text = adoptedColors();
    const dark = text.indexOf("@media (prefers-color-scheme: dark)");
    expect(dark).toBeGreaterThan(0);
    for (const [name, color] of Object.entries(light)) expect(text.slice(0, dark)).toContain(`${name}: ${color};`);
    for (const [name, color] of Object.entries(themeVariables(palette.dark))) expect(text.slice(dark)).toContain(`${name}: ${color};`);

    applyPalette(document, false);
    expect(document.adoptedStyleSheets).toHaveLength(1);
    const overlay = adoptedColors();
    expect(overlay).not.toContain("prefers-color-scheme");
    expect(overlay).toContain(`--text: ${palette.light.text};`);
  });
});
