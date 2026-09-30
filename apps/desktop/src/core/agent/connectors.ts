// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The apps on this computer the Answer prompt's tools reach (`LoopTool.connector`), each a switch in
 * Settings and the welcome wizard, on by default (owner, 2026-09-26). The OS asks for access the
 * first time a request needs it. All are macOS apps for now: elsewhere none is offered or shown.
 */
import * as config from "../config.js";

export type Connector = "calendar" | "reminders" | "contacts" | "files" | "email" | "notes" | "messages" | "web";

export const connectors: readonly Connector[] = ["calendar", "reminders", "contacts", "files", "email", "notes", "messages", "web"];

export function isConnector(name: unknown): name is Connector {
  return typeof name === "string" && (connectors as readonly string[]).includes(name);
}

export interface ConnectorInfo {
  displayName: string;
  /** What it does, under its switch. */
  settingsDescription: string;
}

export const connectorInfo: Record<Connector, ConnectorInfo> = {
  calendar: {
    displayName: "Calendar",
    settingsDescription: "Answers from your calendars, and adds events you ask for once you confirm.",
  },
  reminders: {
    displayName: "Reminders",
    settingsDescription: "Answers from your reminders, and adds ones you ask for once you confirm.",
  },
  contacts: {
    displayName: "Contacts",
    settingsDescription: "Finds people’s details in your contacts, and adds ones you ask for once you confirm.",
  },
  files: {
    displayName: "Files",
    settingsDescription: "Finds files, and Apple Mail messages, with Spotlight, and opens the ones you ask for.",
  },
  email: {
    displayName: "Email",
    settingsDescription: "Opens a new email in your email app, written for you to review and send.",
  },
  notes: {
    displayName: "Notes",
    settingsDescription: "Answers from your notes, and adds ones you ask for once you confirm.",
  },
  messages: {
    displayName: "Messages",
    settingsDescription: "Sends iMessages you ask for once you confirm.",
  },
  web: {
    displayName: "Web",
    settingsDescription: "Searches the web, reads pages, and opens the ones you ask for in your browser.",
  },
};

/** The backend's own tools an app brings, listed in `available_tools` beside its tools while it is on
 * (ADR-DESK-030): the web's search runs on the server. */
export const connectorServerTools: Partial<Record<Connector, readonly string[]>> = {
  web: [config.webSearchTool],
};
