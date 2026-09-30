// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Debug-gated logging. Diagnostic logs are written only in debug builds, and in a packaged build
 * while debug mode is on (`setDebugMode`), to the debug log file.
 *
 * `debug` and `error` never carry transcript text or audio: dictation is user content. User
 * content goes through `content`, to the debug log file only (ADR-DESK-015). Nothing logs audio or
 * an access token.
 */
import { charCount } from "./text.js";

export type LogLevel = "debug" | "CONTENT" | "ERROR";

export interface LogSinks {
  /** Writes the debug log file, while debug logging is on. */
  file?: (level: LogLevel, text: string) => void;
  /** Production observability: structured errors, in every build. */
  error: (text: string) => void;
}

let isDebugBuild = false;
let isDebugModeOn = false;
let sinks: LogSinks = { error: () => {} };
let contentObserver: ((label: string, text: string) => void) | undefined;

/** Called once at launch by the main process. Debug mode starts off. */
export function configureLog(options: { isDebugBuild: boolean; sinks: LogSinks }): void {
  isDebugBuild = options.isDebugBuild;
  isDebugModeOn = false;
  sinks = options.sinks;
}

/** Debug mode is on or off (`AppSettings.isDebugMode`): a packaged build logs while it is on. */
export function setDebugMode(on: boolean): void {
  isDebugModeOn = on;
}

/** Whether the debug log file is written: always in a debug build, and while debug mode is on. */
export function isDebugLogging(): boolean {
  return isDebugBuild || isDebugModeOn;
}

export const log = {
  debug(message: string | (() => string)): void {
    if (!isDebugLogging()) return;
    sinks.file?.("debug", typeof message === "string" ? message : message());
  },

  /** Debug logging only (`isDebugLogging`): user content in full (a transcript, the screen read, a request to the
   * backend and its raw reply, the text pasted), as a block in the log file and nowhere else, so a
   * session can be replayed after the fact (ADR-DESK-015). Never audio or an access token. */
  content(label: string, text: string | (() => string)): void {
    if (!isDebugLogging() && !contentObserver) return;
    const value = typeof text === "string" ? text : text();
    contentObserver?.(label, value);
    if (isDebugLogging()) sinks.file?.("CONTENT", block(label, value));
  },

  /** Structured errors production observability needs. Must never carry user content. */
  error(message: string): void {
    sinks.error(message);
    if (isDebugLogging()) sinks.file?.("ERROR", message);
  },
};

/** `text` whole, between lines naming it, so a multi-line text reads as it is. */
export function block(label: string, text: string): string {
  return `${label} (${charCount(text)} chars) >>>\n${text}\n<<< ${label}`;
}

/** Tests only: sees every `content` entry logged until the returned function is called. */
export function observeContent(observer: (label: string, text: string) => void): () => void {
  contentObserver = observer;
  return () => {
    if (contentObserver === observer) contentObserver = undefined;
  };
}

/** Milliseconds since `started`, for the log. */
export function elapsed(started: number): string {
  return `${Math.round(performance.now() - started)}ms`;
}

/** An error's type for the log: never its message, which may quote user content. */
export function errorName(error: unknown): string {
  if (error instanceof Error) return "description" in error && typeof error.description === "string" ? error.description : error.name;
  return typeof error;
}
