// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../../config.js";
import { LocalDateTime } from "../../../util/localDateTime.js";
import type { ScriptRunner } from "./appleScript.js";
import type { NoteItem, NoteStore } from "../notes.js";

/** The AppleScripts behind the notes tools (ADR-DESK-028), and how their results read back. Each takes
 * its values as arguments (`ScriptRunner`). */
export const NotesScripts = {
  /** Between two notes and between a note's fields in `search`'s result: characters no note's text
   * holds. */
  noteSeparator: "\u{1E}",
  fieldSeparator: "\u{1F}",

  /** Notes whose title or text contains `argv[1]` (ignoring case), locked ones left out: each note's
   * title, folder, last change (`2025-01-15T09:00:00`, local time) and plain text. Each note is read
   * from its folder, every account's folders in turn (subfolders among them, each note in one): Notes
   * cannot name a note's own folder (`container` fails with -1700, on every note in macOS 27). */
  search: `on run argv
    set query to item 1 of argv
    set found to {}
    with timeout of ${config.appleScriptTimeoutSeconds} seconds
        tell application "Notes"
            repeat with theAccount in accounts
                repeat with theFolder in folders of theAccount
                    set folderName to name of theFolder
                    repeat with theNote in (notes of theFolder whose password protected is false and (name contains query or plaintext contains query))
                        set end of found to (name of theNote) & (character id 31) & folderName & (character id 31) & ((modification date of theNote) as «class isot» as string) & (character id 31) & (plaintext of theNote)
                    end repeat
                end repeat
            end repeat
        end tell
    end timeout
    set AppleScript's text item delimiters to character id 30
    return found as text
end run`,

  /** Makes a note in the default account's default folder with the HTML body `argv[1]`; returns its
   * title and that folder's name (the note's own `container` can't be named, as for `search`), read
   * before the note is made so nothing read after can fail a note already added. */
  create: `on run argv
    with timeout of ${config.appleScriptTimeoutSeconds} seconds
        tell application "Notes"
            set theFolder to default folder of default account
            set folderName to name of theFolder
            set theNote to make new note at theFolder with properties {body:item 1 of argv}
            return (name of theNote) & (character id 31) & folderName
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

/** AppleScript is confined to the macOS provider; tool behavior is shared. */
export class MacNoteStore implements NoteStore {
  constructor(private readonly runner: ScriptRunner) {}
  async search(query: string, signal: AbortSignal): Promise<NoteItem[]> {
    return NotesScripts.notes(await this.runner.run(NotesScripts.search, [query], signal));
  }
  async add(title: string, text: string, signal: AbortSignal): Promise<{ title: string; folder?: string }> {
    const [savedTitle = title, folder] = (await this.runner.run(NotesScripts.create, [NotesScripts.html(title, text)], signal)).split(NotesScripts.fieldSeparator);
    return { title: savedTitle, folder };
  }
}
