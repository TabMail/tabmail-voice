// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { palette, type Theme } from "../../core/palette.js";
import { brandBlue, brandGradient, brandTextGradient } from "./brand.js";

/** A theme's colors as the CSS variables the stylesheets read: `controlBorder` is `--control-border`. */
export function themeVariables(theme: Theme): Record<string, string> {
  return Object.fromEntries(Object.entries(theme).map(([name, color]) => [`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, color]));
}

/** The brand's colors, the same in light and dark: under white text, the darker
 * `--brand-text-gradient` (`brand.ts`). */
export const brandVariables: Record<string, string> = {
  "--brand-blue": brandBlue,
  "--brand-gradient": brandGradient,
  "--brand-text-gradient": brandTextGradient,
};

function block(selector: string, variables: Record<string, string>): string {
  return `${selector} {\n${Object.entries(variables)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n")}\n}`;
}

/** The palette as a stylesheet: the brand and the light theme, and the dark theme while the system
 * is dark. Every page follows it, the overlay too (owner, 2026-10-09; it was light in both). */
export function paletteStylesheet(): string {
  const base = block(":root", { ...brandVariables, ...themeVariables(palette.light) });
  return `${base}\n@media (prefers-color-scheme: dark) {\n${block(":root", themeVariables(palette.dark))}\n}`;
}

/** Where a page keeps its palette sheet, so giving it the colors again replaces it. */
const paletteSheet = Symbol.for("ai.tabmail.voice.paletteSheet");

/** Gives the page the palette's colors, before it renders: one constructed stylesheet, however often
 * it is given them. Constructed, not a `<style>` element, which the pages' Content Security Policy
 * (`style-src 'self'`) refuses. */
export function applyPalette(page: Document): void {
  const holder = page as Document & { [paletteSheet]?: CSSStyleSheet };
  const sheet = holder[paletteSheet] ?? new (page.defaultView ?? window).CSSStyleSheet();
  sheet.replaceSync(paletteStylesheet());
  if (!page.adoptedStyleSheets.includes(sheet)) page.adoptedStyleSheets = [...page.adoptedStyleSheets, sheet];
  holder[paletteSheet] = sheet;
}
