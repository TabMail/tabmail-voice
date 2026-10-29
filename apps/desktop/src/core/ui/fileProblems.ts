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

/** While the settings file can't be read its AI features are off (owner, 2026-10-27: "we don't know
 * if consented, nor if AI disabled now"; "the thing to turn off is AI"): the menu says so, and a
 * dictation is refused with it. */
export const aiOffLine = "AI features are off until your settings file is fixed";

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
  const changes = file === "settings" ? "its AI features are off until the file is fixed" : "changes to your knowledge base and writing style aren't saved";
  return `TabMail Voice can't read its ${names[file].title.toLowerCase()} file, so ${changes}. Choose ${fixFileLabel(file)} in TabMail Voice's menu to fix it.`;
}

/** What the user is told when `file` can't be read, and how to fix it on `platform` (`process.platform`):
 * by hand first, else with the dialog's `resetButton`. The app never resets, moves or writes over the
 * file on its own. */
export function fileProblemNotice(file: StoredFile, problem: StoreProblem, platform: string): { message: string; detail: string } {
  const { title, held } = names[file];
  const name = title.toLowerCase();
  const meanwhile = file === "settings" ? `${aiOffLine}: TabMail Voice doesn't dictate or read your screen, and leaves the file as it is.` : `Until it is fixed, TabMail Voice uses the defaults for ${held}, saves no change to them, and leaves the file as it is.`;
  const reset = `Or choose ${resetButton} to start again; the file is kept, renamed.`;
  switch (problem.kind) {
    case "permission":
      return {
        message: `TabMail Voice doesn't have permission to read its ${name} file.`,
        detail: `${meanwhile}\n\n${permissionSteps(platform)}\n${problem.path}\n\nThen quit TabMail Voice and open it again.\n\n${reset}`,
      };
    case "damaged":
      return {
        message: `TabMail Voice's ${name} file is damaged.`,
        detail: `${meanwhile}\n\nTo reset ${held} to the defaults, quit TabMail Voice, move this file to the ${platform === "win32" ? "Recycle Bin" : "Trash"}, and open TabMail Voice again:\n${problem.path}\n\nThis removes what the file held on this computer.\n\n${reset}`,
      };
    case "unreadable":
      return {
        message: `TabMail Voice couldn't read its ${name} file (${problem.code}).`,
        detail: `${meanwhile}\n\nCheck that the disk holding it is connected and working, then quit TabMail Voice and open it again. The file:\n${problem.path}\n\n${reset}`,
      };
  }
}

/** The fix dialog's button for the user's factory reset of a file that can't be read (owner,
 * 2026-10-27), offered after the steps to fix it by hand. */
export const resetButton = "Reset to Defaults…";

/** Where the factory reset keeps the file that couldn't be read: beside it, its name dated with `now`
 * (local time), so nothing is deleted and the user can find it. */
export function resetCopyPath(path: string, now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`;
  const extension = path.endsWith(".json") ? ".json" : "";
  return `${path.slice(0, path.length - extension.length)} (before reset ${stamp})${extension}`;
}

/** The one confirmation before `file` is reset: what this computer loses, and where the file is kept
 * (`copy`). */
export function resetConfirmation(file: StoredFile, copy: string): { message: string; detail: string } {
  const lost =
    file === "settings"
      ? `Your settings on this computer go back to their defaults, your dictionary and excluded apps and websites among them, and the welcome guide opens to set TabMail Voice up again. Your sign-in, memory, knowledge base and writing style stay as they are.`
      : "Your knowledge base, writing style and their history on this computer go back to the defaults. Your other devices keep theirs, and while Sync with my other devices is on, theirs come back here. Your settings and memory stay as they are.";
  return { message: `Reset ${names[file].held} to the defaults?`, detail: `${lost}\n\nThe file that couldn't be read isn't deleted. It is kept as:\n${copy}` };
}

/** Said when the file couldn't be moved aside: nothing changed. */
export function resetFailed(file: StoredFile): { message: string; detail: string } {
  return { message: `TabMail Voice couldn't reset its ${names[file].title.toLowerCase()} file.`, detail: "Nothing was changed. The steps to fix it by hand still apply." };
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
