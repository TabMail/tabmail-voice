// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { StoreProblem } from "../util/keyValueStore.js";

/** The app's files a problem can be told for: the settings file, and the knowledge base and writing
 * style's (`userPrompts.json`). */
export type StoredFile = "settings" | "knowledgeBase";

/** Every file a problem can be told for, in the menu's order. */
export const storedFiles: readonly StoredFile[] = ["settings", "knowledgeBase"];

const names: Record<StoredFile, { title: string; held: string }> = {
  settings: { title: "Settings", held: "your settings" },
  knowledgeBase: { title: "Knowledge Base", held: "your knowledge base, writing style and their history" },
};

/** While the settings file can't be read the whole app is off (owner, 2026-10-27: "since we don't
 * know if consented, nor if ai disabled now"): the menu says so, and a dictation is refused with it. */
export const appOffLine = "TabMail Voice is off until its settings file is fixed";

/** The menu item that tells how to fix `file`, shown while it can't be read. */
export function fixFileLabel(file: StoredFile): string {
  return `Fix ${names[file].title} File…`;
}

/** Why a change to `file` wasn't saved, said by Settings and the agent's tools each time. */
export function unsavedBecauseOf(file: StoredFile): string {
  return `TabMail Voice can't read its ${names[file].title.toLowerCase()} file, so this wasn't saved. Choose ${fixFileLabel(file)} in TabMail Voice's menu to fix it.`;
}

/** Said at the top of Settings while `file` can't be read. */
export function fileProblemLine(file: StoredFile): string {
  const changes = file === "settings" ? "it is off until the file is fixed" : "changes to your knowledge base and writing style aren't saved";
  return `TabMail Voice can't read its ${names[file].title.toLowerCase()} file, so ${changes}. Choose ${fixFileLabel(file)} in TabMail Voice's menu to fix it.`;
}

/** What the user is told when `file` can't be read, and how to fix it on `platform` (`process.platform`).
 * The app never resets, moves or writes over the file itself: the user does, by hand. */
export function fileProblemNotice(file: StoredFile, problem: StoreProblem, platform: string): { message: string; detail: string } {
  const { title, held } = names[file];
  const name = title.toLowerCase();
  const meanwhile = file === "settings" ? `${appOffLine}: it doesn't dictate, read or send anything, and leaves the file as it is.` : `Until it is fixed, TabMail Voice uses the defaults for ${held}, saves no change to them, and leaves the file as it is.`;
  switch (problem.kind) {
    case "permission":
      return {
        message: `TabMail Voice doesn't have permission to read its ${name} file.`,
        detail: `${meanwhile}\n\n${permissionSteps(platform)}\n${problem.path}\n\nThen quit TabMail Voice and open it again.`,
      };
    case "damaged":
      return {
        message: `TabMail Voice's ${name} file is damaged.`,
        detail: `${meanwhile}\n\nTo reset ${held} to the defaults, quit TabMail Voice, move this file to the ${platform === "win32" ? "Recycle Bin" : "Trash"}, and open TabMail Voice again:\n${problem.path}\n\nThis removes what the file held on this computer.`,
      };
    case "unreadable":
      return {
        message: `TabMail Voice couldn't read its ${name} file (${problem.code}).`,
        detail: `${meanwhile}\n\nCheck that the disk holding it is connected and working, then quit TabMail Voice and open it again. The file:\n${problem.path}`,
      };
  }
}

function permissionSteps(platform: string): string {
  switch (platform) {
    case "darwin":
      return "In Finder, select the file, choose File > Get Info, and under Sharing & Permissions give your account Read & Write access. The file:";
    case "win32":
      return "In File Explorer, right-click the file, choose Properties > Security, and give your account Read and Write permission. The file:";
    default:
      return "Give your account read and write permission for the file, for example with chmod u+rw in a terminal. The file:";
  }
}
