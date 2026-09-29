// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { vscodeHidesCaret, withClassicInput } from "../src/core/vscodeSettings.js";

/** A settings file as people keep them: comments, a trailing comma, other settings. */
const accessibilityOff = `// My settings
{
    "editor.fontSize": 13,
    /* Screen reader mode stays off. */
    "editor.accessibilitySupport": "off",
    "vim.useSystemClipboard": true, // keep
}
`;

describe("VS Code's settings", () => {
  /** Only accessibility support off, with the EditContext input VS Code uses by default, hides the
   * caret; VS Code's defaults, "auto" and "on", or the classic input don't. */
  test("hide the caret only with accessibility support off and the EditContext input", () => {
    expect(vscodeHidesCaret(accessibilityOff)).toBe(true);
    expect(vscodeHidesCaret('{ "editor.accessibilitySupport": "off", "editor.editContext": true }')).toBe(true);

    expect(vscodeHidesCaret('{ "editor.accessibilitySupport": "off", "editor.editContext": false }')).toBe(false);
    expect(vscodeHidesCaret('{ "editor.accessibilitySupport": "auto" }')).toBe(false);
    expect(vscodeHidesCaret('{ "editor.accessibilitySupport": "on" }')).toBe(false);
    expect(vscodeHidesCaret('{ "editor.fontSize": 13 }')).toBe(false);
    expect(vscodeHidesCaret("{}")).toBe(false);
    expect(vscodeHidesCaret("")).toBe(false);
    expect(vscodeHidesCaret(null)).toBe(false);
  });

  /** A file that doesn't parse, or isn't an object, is left alone rather than guessed at. */
  test("that don't parse are left alone", () => {
    expect(vscodeHidesCaret('{ "editor.accessibilitySupport": "off" "editor.fontSize": 13 }')).toBe(false);
    expect(vscodeHidesCaret('{ "editor.accessibilitySupport": "off"')).toBe(false);
    expect(vscodeHidesCaret('["editor.accessibilitySupport", "off"]')).toBe(false);
  });

  /** The fix adds `editor.editContext` false and keeps every comment and other setting as it was,
   * a comment ending the last line included. */
  test("switch to the classic input, keeping the rest of the file", () => {
    const fixed = withClassicInput(accessibilityOff);

    expect(vscodeHidesCaret(fixed)).toBe(false);
    expect(fixed).toBe(`// My settings
{
    "editor.editContext": false,
    "editor.fontSize": 13,
    /* Screen reader mode stays off. */
    "editor.accessibilitySupport": "off",
    "vim.useSystemClipboard": true, // keep
}
`);
  });

  /** An existing `editor.editContext` true is changed in place; a new line copies the file's indent
   * (tabs or two spaces, else VS Code's four) and line endings. */
  test("change the setting in place and match the file's layout", () => {
    expect(withClassicInput('{\n  "editor.accessibilitySupport": "off",\n  "editor.editContext": true\n}')).toBe('{\n  "editor.accessibilitySupport": "off",\n  "editor.editContext": false\n}');
    expect(withClassicInput('{\r\n\t"editor.accessibilitySupport": "off"\r\n}')).toBe('{\r\n\t"editor.editContext": false,\r\n\t"editor.accessibilitySupport": "off"\r\n}');
    expect(withClassicInput("{}")).toBe('{\n    "editor.editContext": false\n}');
  });
});
