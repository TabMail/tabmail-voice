// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { MacNoteStore, NotesScripts } from "../../../src/core/agent/connectors/macos/notes.js";
import { NotesCreateTool, NotesSearchTool } from "../../../src/core/agent/connectors/notes.js";
import { osascript } from "../../../src/main/native/macos/osascript.js";

/** Whether to run the notes tools against the real Notes app: off unless asked for
 * (`TABMAIL_VOICE_LIVE_NOTES=1`), as it adds a note to the user's Notes, and macOS asks the first
 * time the terminal sends Notes an Apple Event. */
const live = process.platform === "darwin" && process.env.TABMAIL_VOICE_LIVE_NOTES === "1";

/** A test waits this long for Notes, which may first have to start (milliseconds). */
const liveTimeout = 120_000;

/** Moves every note whose title holds `argv[1]` to Recently Deleted, the way a user deletes one, then
 * every folder whose name holds it, by name and subfolders first (deleting through the list of folders
 * found leaves them in place): test only, the app never deletes. */
const deleteNotes = `on run argv
    tell application "Notes"
        delete (notes whose name contains (item 1 of argv))
        set folderNames to name of (folders of default account whose name contains (item 1 of argv))
        repeat with folderName in reverse of folderNames
            delete (first folder of default account whose name is (contents of folderName))
        end repeat
    end tell
end run`;

/** Makes the folder `argv[1]` in the default account, the folder `argv[2]` in it, and a note with the
 * HTML body `argv[3]` in that subfolder: test only, the app adds notes to the default folder alone. */
const addNoteInSubfolder = `on run argv
    tell application "Notes"
        set theParent to make new folder at default account with properties {name:item 1 of argv}
        set theChild to make new folder at theParent with properties {name:item 2 of argv}
        make new note at theChild with properties {body:item 3 of argv}
    end tell
end run`;

/** The title and folder of the first unlocked, titled note in each account other than the default one
 * whose title no note in the default account holds (so only a search of that account finds it), read
 * only: one record per account that has one. */
const firstNoteOfOtherAccounts = `on run argv
    set found to {}
    tell application "Notes"
        set defaultName to name of default account
        repeat with theAccount in accounts
            if name of theAccount is not defaultName then
                set picked to false
                repeat with theFolder in folders of theAccount
                    if not picked then
                        repeat with theNote in (notes of theFolder whose password protected is false and name is not "")
                            if not picked then
                                set theName to name of theNote
                                if (count of (notes of default account whose name contains theName or plaintext contains theName)) is 0 then
                                    set end of found to theName & (character id 31) & (name of theFolder)
                                    set picked to true
                                end if
                            end if
                        end repeat
                    end if
                end repeat
            end if
        end repeat
    end tell
    set AppleScript's text item delimiters to character id 30
    return found as text
end run`;

/** The notes tools run for real, through osascript, against the Notes app: the note `notes_create`
 * adds is the one `notes_search` finds, with its folder, last change and text; a note in a subfolder
 * is found once, with that folder; a note in another account is found; and a search that matches a
 * deleted note reads it and the others. Every note
 * and folder is named with one run's marker, and deleted after. On macOS 27 Notes can't name a note's
 * own folder (`container`), which failed every search and every note added, after adding it. */
describe.runIf(live)("the notes tools against Notes", () => {
  const marker = `TabMail Voice test ${randomUUID()}`;
  const store = new MacNoteStore(osascript);
  const signal = new AbortController().signal;

  afterAll(async () => {
    await osascript.run(deleteNotes, [marker], signal);
  }, liveTimeout);

  test(
    "the note added is found with its folder, last change and text",
    async () => {
      const startedAt = Date.now();
      const added = await new NotesCreateTool(store).run({ title: `${marker} added`, body: 'Line "one"\n\nLine 3 > 2 & more' }, signal);

      const found = (await store.search(`${marker} added`, signal)).filter((note) => note.title === `${marker} added`);

      expect(added).toMatch(new RegExp(`^Added the note "${marker} added" in the .+ folder\\.$`));
      expect(found).toHaveLength(1);
      expect(found[0]?.folder).not.toBe("");
      expect(added).toContain(`in the ${found[0]?.folder} folder`);
      expect(found[0]?.text).toContain('Line "one"');
      expect(found[0]?.text).toContain("Line 3 > 2 & more");
      // Notes keeps the last change to the second; it is no earlier than the second the test began.
      expect(found[0]?.changed?.getTime()).toBeGreaterThanOrEqual(Math.floor(startedAt / 1000) * 1000);
      expect(found[0]?.changed?.getTime()).toBeLessThanOrEqual(Date.now());
    },
    liveTimeout,
  );

  /** `folders of` an account lists its subfolders too, and a folder's notes are its own: a note in a
   * subfolder is read once, with the subfolder's name. */
  test(
    "a note in a subfolder is found once, with that folder",
    async () => {
      await osascript.run(addNoteInSubfolder, [`${marker} folder`, `${marker} subfolder`, NotesScripts.html(`${marker} nested`, "Nested text")], signal);

      const found = (await store.search(`${marker} nested`, signal)).filter((note) => note.title === `${marker} nested`);

      expect(found.map((note) => [note.folder, note.text.includes("Nested text")])).toEqual([[`${marker} subfolder`, true]]);
    },
    liveTimeout,
  );

  /** Every account is searched, not just the default one, read only: the first note of each other
   * account is found by its title, with its folder. Nothing is added to another account, which may
   * sync somewhere else; with one account, or none of the others holding a note, there is nothing to
   * check. */
  test(
    "a note in another account is found, with its folder",
    async () => {
      const others = (await osascript.run(firstNoteOfOtherAccounts, [], signal)).split(NotesScripts.noteSeparator).filter((record) => record !== "");

      for (const record of others) {
        const [title = "", folder = ""] = record.split(NotesScripts.fieldSeparator);
        const found = (await store.search(title, signal)).filter((note) => note.title === title && note.folder === folder);
        expect(found.length, "the first note of another account").toBeGreaterThan(0);
      }
    },
    liveTimeout,
  );

  /** A deleted note waits in Recently Deleted, which a search can still match: the search reads it,
   * and the other matches, rather than failing on it. */
  test(
    "a search matching a deleted note still reads",
    async () => {
      await new NotesCreateTool(store).run({ title: `${marker} deleted`, body: "Deleted text" }, signal);
      await new NotesCreateTool(store).run({ title: `${marker} kept`, body: "Kept text" }, signal);
      await osascript.run(deleteNotes, [`${marker} deleted`], signal);

      const result = await new NotesSearchTool(store).run({ query: marker }, signal);

      expect(result).toContain(`"${marker} kept"`);
      expect(result).toContain("Kept text");
      expect(result).toContain(`"${marker} deleted"`);
      expect(result).toContain("Deleted text");
    },
    liveTimeout,
  );
});
