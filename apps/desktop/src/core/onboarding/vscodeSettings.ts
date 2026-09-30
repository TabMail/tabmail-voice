// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import * as config from "../config.js";

/** VS Code's user settings, inside the app-data directory (`~/Library/Application Support` on a Mac). */
export const vscodeSettingsPath = ["Code", "User", "settings.json"] as const;

/**
 * Whether VS Code's user settings hide the caret from TabMail Voice. With
 * `editor.accessibilitySupport` off, VS Code's EditContext input (on by default) answers
 * Accessibility with no text and the whole line's box, so the overlay shows at the line's start
 * (measured on VS Code 1.139). Its classic input, `editor.editContext` false, sits at the caret, as
 * does the EditContext input with accessibility support on or automatic. Missing settings are VS
 * Code's defaults; settings that don't parse are left alone.
 */
export function vscodeHidesCaret(text: string | null): boolean {
  const settings = parsedSettings(text);
  return settings !== null && settings["editor.accessibilitySupport"] === "off" && settings["editor.editContext"] !== false;
}

/** `text` with `editor.editContext` set false: comments and every other setting kept. A new setting
 * goes first, indented like the file's others; after the last, VS Code's own parser would move a
 * comment ending that line onto the new one (a comment after the opening brace moves instead, which
 * is rarer). */
export function withClassicInput(text: string): string {
  const indent = /^([ \t]+)"/m.exec(text)?.[1];
  const insertSpaces = indent === undefined || !indent.startsWith("\t");
  const tabSize = indent === undefined ? config.vscodeSettingsIndent : insertSpaces ? indent.length : 1;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return applyEdits(text, modify(text, ["editor.editContext"], false, { formattingOptions: { insertSpaces, tabSize, eol }, getInsertionIndex: () => 0 }));
}

/** The settings object, or null when the text is missing, doesn't parse, or isn't one. VS Code
 * allows comments and trailing commas. */
function parsedSettings(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
