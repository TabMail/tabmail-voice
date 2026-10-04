// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../config.js";
import { LocalDateTime } from "../../util/localDateTime.js";
import { Arguments, type ConnectorServices, type ConnectorTool, defineConnector, ToolArgumentError } from "./contract.js";

/** A note in a native notes store, as the notes tools read them. */
export interface NoteItem {
  title: string;
  folder: string;
  changed: Date | null;
  text: string;
}

/** Native providers own access and storage; shared tools own validation and confirmation. */
export interface NoteStore {
  search(query: string, signal: AbortSignal): Promise<NoteItem[]>;
  add(title: string, text: string, signal: AbortSignal): Promise<{ title: string; folder?: string }>;
}

export const notesConnector = defineConnector({
  id: "notes",
  order: 60,
  platforms: ["darwin", "linux"],
  displayName: "Notes",
  settingsDescription: "Answers from your notes, and adds ones you ask for once you confirm.",
  tools: ({ noteStore }: Pick<ConnectorServices, "noteStore">): ConnectorTool[] => [new NotesSearchTool(noteStore), new NotesCreateTool(noteStore)],
});

/** Finds notes in the native store (`notes_search`), for "what did I write down about the offsite". */
export class NotesSearchTool implements ConnectorTool {
  readonly name = "notes_search";
  readonly connector = "notes";
  readonly progressLabel = "Looking in your notes";

  constructor(private readonly store: NoteStore) {}

  confirmation(): null {
    return null;
  }

  /** The newest `notesSearchMaxResults` matches, each in full; more say so. */
  async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const query = Arguments.text(args, "query");
    if (query === null) throw ToolArgumentError.missing("query");
    const found = (await this.store.search(query, signal)).sort((a, b) => (b.changed?.getTime() ?? -Infinity) - (a.changed?.getTime() ?? -Infinity));
    if (found.length === 0) return `No notes match "${query}".`;
    const limit = config.notesSearchMaxResults;
    const sections = [`Notes matching "${query}", newest first:`, ...found.slice(0, limit).map(describe)];
    if (found.length > limit) sections.push(`(${found.length - limit} more notes match; search with more of the words.)`);
    return sections.join("\n\n");
  }
}

function describe(note: NoteItem): string {
  const changed = note.changed === null ? "" : `, changed ${LocalDateTime.describe(note.changed)}`;
  return `"${note.title}" (${note.folder}${changed}):\n${note.text}`;
}

/** Adds a note to the native default folder (`notes_create`), once the user confirms what the chat
 * window shows: the question and the note come from the same draft. */
export class NotesCreateTool implements ConnectorTool {
  readonly name = "notes_create";
  readonly connector = "notes";
  readonly progressLabel = "Adding the note";

  constructor(private readonly store: NoteStore) {}

  /** Null only for arguments `run` rejects before adding anything. */
  confirmation(args: Record<string, unknown>): string | null {
    let draft: { title: string; text: string };
    try {
      draft = NotesCreateTool.draft(args);
    } catch {
      return null;
    }
    return `Add this note?\n${draft.title}\n${draft.text}`;
  }

  async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const draft = NotesCreateTool.draft(args);
    const { title, folder } = await this.store.add(draft.title, draft.text, signal);
    return `Added the note "${title}"${folder === undefined ? "" : ` in the ${folder} folder`}.`;
  }

  /** The note the arguments describe: a title and a body. */
  static draft(args: Record<string, unknown>): { title: string; text: string } {
    const title = Arguments.text(args, "title");
    if (title === null) throw ToolArgumentError.missing("title");
    const text = Arguments.text(args, "body");
    if (text === null) throw ToolArgumentError.missing("body");
    return { title, text };
  }
}
