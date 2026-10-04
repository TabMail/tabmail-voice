// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { errorName, isDebugLogging, log } from "../log.js";
import type { ScreenExclusions } from "./excludedSites.js";

/** Shared-Rust projection of approved visible terminal text. Offsets are UTF-16
 * insertion boundaries, never terminal cell columns or marker searches. */
export interface TerminalViewport {
  renderedText: string;
  complete: boolean;
  caret: { status: "exact"; surface: number; run: number; offset: number; renderedOffset: number }
    | { status: "outsideViewport" | "unavailable" | "withheld" };
  selectedText: string;
  selectionComplete: boolean;
  surfaces: {
    id: number;
    frame: number[];
    runs: { id: number; text: string; connected: boolean; complete: boolean; renderedOffset: number }[];
    selection: { complete: boolean; ranges: { run: number; start: number; end: number; redacted: boolean; renderedStart: number; renderedEnd: number }[] };
  }[];
}

/** What was on screen in the app in front when a dictation started, as the platform helper read it
 * (macOS: `readScreen`). The helper renders the text for the prompts and the logs itself. */
export interface ScreenContext {
  terminalViewport?: TerminalViewport;
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

/** The helper's answer for a screen it does not read, for the user's privacy: an app or a website
 * excluded from screen reading, or a page whose address is unknown. It carries nothing of the screen. */
export interface ScreenHidden {
  hidden: true;
}

/** What a screen read gives: the screen, or that it is hidden. */
export type ScreenRead = ScreenContext | ScreenHidden;

/** Whether the read found the screen hidden for privacy, rather than a screen or nothing. */
export function isScreenHidden(read: ScreenRead | null): read is ScreenHidden {
  return read !== null && "hidden" in read;
}

/** The screen as read, for everything that uses it: none when it is hidden. */
export function screenShown(read: ScreenRead | null): ScreenContext | null {
  return isScreenHidden(read) ? null : read;
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
    /** Null when no app is in front; hidden when what is in front is among `exclusions` (an app, or
     * the website in a browser), which the helper doesn't read. */
    private readonly read: (exclusions: ScreenExclusions) => Promise<ScreenRead | null>,
    private readonly onCapture: () => void = () => {},
  ) {}

  /** Null without the Accessibility grant. (Whether to read at all is the dictation's
   * screen-reading setting, `DictationSettings.readsScreen`.) The promise yields the screen of the
   * app in front when this was called, even if a newer capture has started since; that it is hidden,
   * with an app or a website the dictation excludes from screen reading (`exclusions`); null without
   * an app in front, or when the read failed. */
  capture(exclusions: ScreenExclusions): Promise<ScreenRead | null> | null {
    if (!this.isTrusted()) return null;
    this.generation += 1;
    const current = this.generation;
    return this.read(exclusions).then(
      (context) => {
        if (!context) return null;
        if (isScreenHidden(context)) {
          log.debug("ScreenContext: hidden for privacy; not read");
          return context;
        }
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
