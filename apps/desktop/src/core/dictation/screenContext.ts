// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { errorName, isDebugLogging, log } from "../log.js";

/** What was on screen in the app in front when a dictation started, as the platform helper read it
 * (macOS: `readScreen`). The helper renders the text for the prompts and the logs itself. */
export interface ScreenContext {
  appName: string;
  bundleID: string | null;
  windowTitle: string | null;
  /** A browser's page host. */
  host: string | null;
  /** The program running in a terminal. */
  terminalProgram: string | null;
  focusedRole: string | null;
  textBeforeCaret: string;
  selectedText: string;
  /** Whether the helper took secret-looking text out of the selection (ADR-DESK-046): `selectedText`
   * is then not what the user selected, and a rewrite of it must not replace the selection. */
  selectionRedacted: boolean;
  textAfterCaret: string;
  /** The screen as the prompts get it: headings, blocks, the focused field with the caret marked. */
  renderedText: string;
  /** Sizes and timings, for the debug log. No user content. */
  summary: string;
  /** Everything read, for the debug log file only (ADR-DESK-015). */
  logDescription: string;
}

/** Reads the screen context of the frontmost app when a dictation starts, in the background while
 * the user speaks; the dictation's cleanup uses it if it is done in time. While debug logging is on
 * (`isDebugLogging`) the latest capture is kept in memory for the debug window. Logs sizes and timings; the text goes to the debug
 * log file only (ADR-DESK-015). */
export class ScreenContextProbe {
  /** While debug logging is on: the latest capture, for the debug window (debug builds). */
  lastContext: ScreenContext | null = null;
  private generation = 0;

  constructor(
    private readonly isTrusted: () => boolean,
    /** Null when no app is in front, or the one in front is among `excludedApps` (bundle
     * identifiers), which is never read. */
    private readonly read: (excludedApps: readonly string[]) => Promise<ScreenContext | null>,
    private readonly onCapture: () => void = () => {},
  ) {}

  /** Null without the Accessibility grant. (Whether to read at all is the dictation's
   * screen-reading setting, `DictationSettings.readsScreen`.) The promise yields the screen of the
   * app in front when this was called, even if a newer capture has started since; null without an
   * app in front, with one the dictation excludes from screen reading (`excludedApps`), or when the
   * read failed. */
  capture(excludedApps: readonly string[]): Promise<ScreenContext | null> | null {
    if (!this.isTrusted()) return null;
    this.generation += 1;
    const current = this.generation;
    return this.read(excludedApps).then(
      (context) => {
        if (!context) return null;
        log.debug(`ScreenContext: ${context.summary}`);
        log.content("ScreenContext", context.logDescription);
        if (isDebugLogging() && this.generation === current) {
          this.lastContext = context;
          this.onCapture();
        }
        return context;
      },
      (error: unknown) => {
        log.error(`ScreenContext: read failed: ${errorName(error)}`);
        return null;
      },
    );
  }
}
