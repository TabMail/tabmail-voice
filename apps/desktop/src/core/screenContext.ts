// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isDebugLogging, log } from "./log.js";

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
  textAfterCaret: string;
  /** The screen as the prompts get it: headings, blocks, the focused field with the caret marked. */
  renderedText: string;
  /** Sizes and timings, for the debug log. No user content. */
  summary: string;
  /** Everything read, for the debug log file only (ADR-DESK-015). */
  logDescription: string;
}

/** Reads the screen context of the frontmost app when a dictation starts, in the background while
 * the user speaks; the dictation's cleanup uses it if it is done in time. Debug builds keep the
 * latest capture in memory for the debug window. Logs sizes and timings; the text goes to the debug
 * log file only (ADR-DESK-015). */
export class ScreenContextProbe {
  /** Debug builds only: the latest capture, for the debug window. */
  lastContext: ScreenContext | null = null;
  private generation = 0;

  constructor(
    private readonly isTrusted: () => boolean,
    /** Null when no app is in front. */
    private readonly read: () => Promise<ScreenContext | null>,
    private readonly onCapture: () => void = () => {},
  ) {}

  /** Null without the Accessibility grant. (Whether to read at all is the dictation's
   * screen-reading setting, `DictationSettings.readsScreen`.) The promise yields the screen of the
   * app in front when this was called, even if a newer capture has started since; null without an
   * app in front, or when the read failed. */
  capture(): Promise<ScreenContext | null> | null {
    if (!this.isTrusted()) return null;
    this.generation += 1;
    const current = this.generation;
    return this.read().then(
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
        log.error(`ScreenContext: read failed: ${error instanceof Error ? error.name : typeof error}`);
        return null;
      },
    );
  }
}
