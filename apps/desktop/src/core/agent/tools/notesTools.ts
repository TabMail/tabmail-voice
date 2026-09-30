// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../config.js";
import { LocalDateTime } from "../../util/localDateTime.js";
import type { ScriptRunner } from "../connectors/appleScript.js";
import { Arguments, type LoopTool, LoopToolArgumentError } from "./loopTool.js";

/** A note in Apple Notes, as the notes tools read them. */
export interface NoteItem {
  title: string;
  folder: string;
  changed: Date | null;
  text: string;
}

/** The AppleScripts behind the notes tools (ADR-DESK-028), and how their results read back. Each takes
 * its values as arguments (`ScriptRunner`). */
export const NotesScripts = {
  /** Between two notes and between a note's fields in `search`'s result: characters no note's text
   * holds. */
  noteSeparator: "\u{1E}",
  fieldSeparator: "\u{1F}",

  /** Notes whose title or text contains `argv[1]` (ignoring case), locked ones left out: each note's
   * title, folder, last change (`2025-01-15T09:00:00`, local time) and plain text. */
  search: `on run argv
    set query to item 1 of argv
    set found to {}
    with timeout of ${config.appleScriptTimeoutSeconds} seconds
        tell application "Notes"
            repeat with theNote in (notes whose password protected is false and (name contains query or plaintext contains query))
                set end of found to (name of theNote) & (character id 31) & (name of container of theNote) & (character id 31) & ((modification date of theNote) as «class isot» as string) & (character id 31) & (plaintext of theNote)
            end repeat
        end tell
    end timeout
    set AppleScript's text item delimiters to character id 30
    return found as text
end run`,

  /** Makes a note in the default account's default folder with the HTML body `argv[1]`; returns its
   * title and folder. */
  create: `on run argv
    with timeout of ${config.appleScriptTimeoutSeconds} seconds
        tell application "Notes"
            set theNote to make new note at default folder of default account with properties {body:item 1 of argv}
            return (name of theNote) & (character id 31) & (name of container of theNote)
        end tell
    end timeout
end run`,

  /** `search`'s result as notes; a note missing a field is left out. */
  notes(result: string): NoteItem[] {
    if (result === "") return [];
    return result.split(NotesScripts.noteSeparator).flatMap((record) => {
      const [title, folder, changed, ...text] = record.split(NotesScripts.fieldSeparator);
      if (title === undefined || folder === undefined || changed === undefined || text.length === 0) return [];
      return [{ title, folder, changed: LocalDateTime.parse(changed)?.date ?? null, text: text.join(NotesScripts.fieldSeparator) }];
    });
  },

  /** A note's body as Notes stores it: the title as its heading, then each line of `text`, with every
   * `&`, `<`, `>` and `"` escaped so the text shows as written. */
  html(title: string, text: string): string {
    const lines = text.replace(/\r\n|\r/g, "\n").split("\n");
    return `<div><h1>${escaped(title)}</h1></div>${lines.map((line) => (line === "" ? "<div><br></div>" : `<div>${escaped(line)}</div>`)).join("")}`;
  },
};

function escaped(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The Notes connector's tools. */
export function notesTools(runner: ScriptRunner): LoopTool[] {
  return [new NotesSearchTool(runner), new NotesCreateTool(runner)];
}

/** Finds notes in Apple Notes (`notes_search`), for "what did I write down about the offsite". */
export class NotesSearchTool implements LoopTool {
  readonly name = "notes_search";
  readonly connector = "notes";
  readonly progressLabel = "Looking in your notes";

  constructor(private readonly runner: ScriptRunner) {}

  confirmation(): null {
    return null;
  }

  /** The newest `notesSearchMaxResults` matches, each in full; more say so. */
  async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const query = Arguments.text(args, "query");
    if (query === null) throw LoopToolArgumentError.missing("query");
    const found = NotesScripts.notes(await this.runner.run(NotesScripts.search, [query], signal)).sort((a, b) => (b.changed?.getTime() ?? -Infinity) - (a.changed?.getTime() ?? -Infinity));
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

/** Adds a note to Apple Notes' default folder (`notes_create`), once the user confirms what the chat
 * window shows: the question and the note come from the same draft. */
export class NotesCreateTool implements LoopTool {
  readonly name = "notes_create";
  readonly connector = "notes";
  readonly progressLabel = "Adding the note";

  constructor(private readonly runner: ScriptRunner) {}

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
    const [title = draft.title, folder] = (await this.runner.run(NotesScripts.create, [NotesScripts.html(draft.title, draft.text)], signal)).split(NotesScripts.fieldSeparator);
    return `Added the note "${title}"${folder === undefined ? "" : ` in the ${folder} folder`}.`;
  }

  /** The note the arguments describe: a title and a body. */
  static draft(args: Record<string, unknown>): { title: string; text: string } {
    const title = Arguments.text(args, "title");
    if (title === null) throw LoopToolArgumentError.missing("title");
    const text = Arguments.text(args, "body");
    if (text === null) throw LoopToolArgumentError.missing("body");
    return { title, text };
  }
}
