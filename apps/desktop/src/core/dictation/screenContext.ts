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
 * the user speaks; the dictation's cleanup uses it if it is done in time. That read takes what the
 * window shows; once it has answered, the whole window is read (`window`, ADR-DESK-016, 2026-10-25),
 * for the dictation's terms if it is done in time and for agent mode's `screen_read`: the window that
 * read read, and nothing if another window has come to the front since. While debug logging is on
 * (`isDebugLogging`) the latest capture is kept in memory for the debug window. Logs sizes and timings; the text goes to the debug
 * log file only (ADR-DESK-015). */
export class ScreenContextProbe {
  /** While debug logging is on: the latest capture, for the debug window (debug builds). */
  lastContext: ScreenContext | null = null;
  private generation = 0;
  /** Each capture's read, by the promise `capture` gave for it, and each whole window's, by the
   * promise `window` gives, once it has started. */
  private readonly reads = new WeakMap<Promise<ScreenRead | null>, Promise<ScreenRead | null>>();
  /** Each capture's whole window, by the promise `capture` gave. */
  private readonly windows = new WeakMap<Promise<ScreenRead | null>, Promise<ScreenRead | null>>();
  /** A whole window not started yet, by the promise `window` gives: the capture it follows, and
   * whether it was stopped before it started. */
  private readonly waiting = new WeakMap<Promise<ScreenRead | null>, { capture: Promise<ScreenRead | null>; stopped: boolean }>();

  constructor(
    private readonly isTrusted: () => boolean,
    /** Null when no app is in front; hidden when what is in front is among `exclusions` (an app, or
     * the website in a browser), which the helper doesn't read. What the window shows, or with
     * `wholeWindowOf` the whole window of the window that read (one this gave) read: null when
     * that window is no longer the one in front. */
    private readonly read: (exclusions: ScreenExclusions, wholeWindowOf?: Promise<ScreenRead | null>, target?: Promise<number | null>) => Promise<ScreenRead | null>,
    private readonly onCapture: () => void = () => {},
    /** Asks a read `read` gave to stop and answer with what it has read so far. */
    private readonly stopRead: (read: Promise<ScreenRead | null>) => void = () => {},
  ) {}

  /** Asks a capture's read, or a whole window's (`window`), still going, to answer with what it has
   * read so far (ADR-DESK-053): it then yields that, a valid read of part of the window. A whole
   * window not started yet is not read: the capture's read is asked instead, and its answer is the
   * whole window's. */
  stop(read: Promise<ScreenRead | null>): void {
    const reading = this.reads.get(read);
    if (reading) return this.stopRead(reading);
    const waiting = this.waiting.get(read);
    if (!waiting) return;
    waiting.stopped = true;
    this.stop(waiting.capture);
  }

  /** The whole window of the app a capture read, read once the capture has answered with a screen:
   * the capture's answer when it was null or hidden, and null when a newer capture started first or
   * the read failed. Null for a promise `capture` did not give. */
  window(capture: Promise<ScreenRead | null>): Promise<ScreenRead | null> | null {
    return this.windows.get(capture) ?? null;
  }

  /** Null without the Accessibility grant. (Whether to read at all is the dictation's
   * screen-reading setting, `DictationSettings.readsScreen`.) The promise yields the screen of the
   * app in front when this was called; a newer capture ends this read, which then yields null. It
   * yields that the screen is hidden with an app or a website the dictation excludes from screen
   * reading (`exclusions`); null without an app in front, or when the read failed. */
  capture(exclusions: ScreenExclusions, target?: Promise<number | null>): Promise<ScreenRead | null> | null {
    if (!this.isTrusted()) return null;
    this.generation += 1;
    const current = this.generation;
    const read = this.read(exclusions, undefined, target);
    const capture = read.then(
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
    this.reads.set(capture, read);
    this.windows.set(capture, this.readWindow(capture, read, current, exclusions));
    return capture;
  }

  /** Reads the whole window of the window `shown` read, after `capture` has answered (`window`). */
  private readWindow(capture: Promise<ScreenRead | null>, shown: Promise<ScreenRead | null>, current: number, exclusions: ScreenExclusions): Promise<ScreenRead | null> {
    const waiting = { capture, stopped: false };
    const window: Promise<ScreenRead | null> = capture.then((screen) => {
      this.waiting.delete(window);
      if (screen === null || isScreenHidden(screen) || waiting.stopped) return screen;
      if (this.generation !== current) return null;
      const read = this.read(exclusions, shown);
      this.reads.set(window, read);
      return read.then(
        (context) => {
          if (context === null || isScreenHidden(context)) {
            log.debug(`ScreenContext: whole window ${context === null ? "not read" : "hidden for privacy; not read"}`);
            return context;
          }
          log.debug(`ScreenContext: whole window: ${context.summary}`);
          log.content("ScreenContext (whole window)", context.logDescription);
          return context;
        },
        (error: unknown) => {
          log.error(`ScreenContext: whole window read failed: ${errorName(error)}`);
          return null;
        },
      );
    });
    this.waiting.set(window, waiting);
    return window;
  }
}
