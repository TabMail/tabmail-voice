// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ScreenContext } from "../../src/core/dictation/screenContext.js";

/** A screen read as the macOS helper returns it; unset fields are empty. The helper renders the
 * text itself (its own tests pin how), so a test gives `renderedText` as it wants it. */
export function screen(fields: Partial<ScreenContext> = {}): ScreenContext {
  return {
    appName: "",
    bundleID: null,
    windowTitle: null,
    host: null,
    terminalProgram: null,
    focusedRole: null,
    textBeforeCaret: "",
    selectedText: "",
    textAfterCaret: "",
    renderedText: "",
    summary: "",
    logDescription: "",
    ...fields,
  };
}
