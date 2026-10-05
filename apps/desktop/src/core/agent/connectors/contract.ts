// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { LocalDateTime } from "../../util/localDateTime.js";
import { trimWhitespace } from "../../util/text.js";
import type { ScriptRunner } from "./macos/appleScript.js";
import type { EventStore } from "./calendar.js";
import type { ContactStore } from "./contacts.js";
import type { EmailOpener } from "./email.js";
import type { NoteStore } from "./notes.js";
import type { PDFReader } from "./pdf.js";
import type { FileStore } from "./files.js";
import type { ConnectorID } from "./registry.js";
import type { WebFetch, WebOpener } from "./web.js";

/**
 * A tool the Answer prompt's model can call that runs on this computer (a calendar read, a reminder
 * created, a file found), as the iOS app's `ToolRegistry` tools are. Its definition, the JSON the
 * model sees, lives in the backend's tool registry for this client under the same `name`; the app
 * lists the names it can run in each Answer request's `available_tools` (ADR-DESK-023).
 */
export interface ConnectorTool {
  /** The function name, as in the backend's registry. */
  readonly name: string;
  /** The app it reaches, whose switch in Settings and the welcome wizard turns it on and off. */
  readonly connector: ConnectorID;
  /** What the chat window says while it runs ("Checking your calendar"). */
  readonly progressLabel: string;
  /** What the chat window asks before the tool sends or creates anything ("Add “Launch review” to
   * your calendar on Friday at 10:00?"); null for ordinary reads. Explicit document reads also ask before sharing text. The tool runs only if the
   * user confirms (owner, 2026-09-26: send or create = confirm first, always). */
  confirmation(args: Record<string, unknown>, signal: AbortSignal): string | null | Promise<string | null>;
  /** Runs the tool; the result is what the model reads next. Throws when it can't: the model is told
   * why. `signal` aborts when the request is canceled or its chat window closed: a tool that can
   * stop what it started (a script) stops it. */
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

/** Why a tool could not run with the arguments the model gave; the model reads it and can call
 * again. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }

  static missing(name: string): ToolArgumentError {
    return new ToolArgumentError(`${name} is required.`);
  }

  static notADate(name: string): ToolArgumentError {
    return new ToolArgumentError(`${name} is not a date and time like 2025-01-15T14:00:00, or a day like 2025-01-15.`);
  }
}

/** The arguments of a tool call, read as the backend's tool definitions describe them. */
export const Arguments = {
  /** The string argument `name`, trimmed; null when absent or empty. */
  text(args: Record<string, unknown>, name: string): string | null {
    const value = args[name];
    if (typeof value !== "string") return null;
    const trimmed = trimWhitespace(value);
    return trimmed === "" ? null : trimmed;
  },

  /** The date argument `name` (`LocalDateTime`); null when absent, throws when it is not a date. */
  localDate(args: Record<string, unknown>, name: string): { date: Date; hasTime: boolean } | null {
    const text = Arguments.text(args, name);
    if (text === null) return null;
    const parsed = LocalDateTime.parse(text);
    if (parsed === null) throw ToolArgumentError.notADate(name);
    return parsed;
  },

  /** The date argument `name` as the end of a range: a day means through the end of it. */
  localEnd(args: Record<string, unknown>, name: string): Date | null {
    const parsed = Arguments.localDate(args, name);
    if (parsed === null) return null;
    return parsed.hasTime ? parsed.date : LocalDateTime.addingDays(parsed.date, 1);
  },
};

/** Whether `value`, parsed JSON, is an object (not an array or null). */
export function isJSONObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the main process gives the connectors' tools: the OS access each needs (on a Mac, through
 * `voice-macos` and osascript). A connector that needs something new adds it here. */
export interface ConnectorServices {
  eventStore: EventStore;
  contactStore: ContactStore;
  noteStore: NoteStore;
  fileStore: FileStore;
  pdfReader: PDFReader;
  /** The user's home folder, which the model reads as `~`. */
  home: string;
  emailOpener: EmailOpener;
  scriptRunner: ScriptRunner;
  webFetch: WebFetch;
  webOpener: WebOpener;
}

/**
 * An app on this computer the Answer prompt's tools reach (`ConnectorTool.connector`), a switch in
 * Settings and the welcome wizard, on by default (owner, 2026-09-26). The OS asks for access the
 * first time a request needs it. Each connector declares the platforms its services support.
 * Each is declared in its own file in this folder with `defineConnector`, and
 * `scripts/gen-registries.mts` lists them in `registry.ts` (ADR-DESK-044).
 */
export interface Connector {
  readonly id: ConnectorID;
  /** Platforms with a working implementation of this connector’s services. */
  readonly platforms: readonly ("darwin" | "win32" | "linux")[];
  /** Where its switch and bubble sit among the connectors', lowest first. */
  readonly order: number;
  readonly displayName: string;
  /** What it does, under its switch. */
  readonly settingsDescription: string;
  /** The backend's own tools it brings, listed in `available_tools` beside its tools while it is on
   * (ADR-DESK-030): the web's search runs on the server. */
  readonly serverTools?: readonly string[];
  /** Its tools, over the OS access they need. */
  tools(services: ConnectorServices): ConnectorTool[];
}

/** Declares a connector; `npm run gen:registries` finds it by this call. Its type is kept, so a test
 * gives `tools` only the services the connector uses. */
export function defineConnector<T extends Connector>(connector: T): T {
  return connector;
}
