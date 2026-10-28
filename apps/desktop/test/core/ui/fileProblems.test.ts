// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { appOffLine, fileProblemLine, fileProblemNotice, fixFileLabel, storedFiles, unsavedBecauseOf } from "../../../src/core/ui/fileProblems.js";
import type { StoreProblem } from "../../../src/core/util/keyValueStore.js";

const path = "/example/TabMail Voice/userPrompts.json";
const kinds: StoreProblem[] = [
  { kind: "permission", path, code: "EACCES" },
  { kind: "damaged", path, code: "invalid" },
  { kind: "unreadable", path, code: "EIO" },
];

/** What the user is told when a file couldn't be read at launch (ADR-DESK-063): which file, where it
 * is, that the app leaves it as it is, and what they do by hand to fix it. */
describe("file problems", () => {
  test.each(storedFiles.flatMap((file) => kinds.flatMap((problem) => ["darwin", "win32", "linux"].map((platform) => [file, problem, platform] as const))))(
    "%s, %o on %s: names the file and its path, and that it is left as it is",
    (file, problem, platform) => {
      const { message, detail } = fileProblemNotice(file, problem, platform);
      expect(message).toContain(file === "settings" ? "settings file" : "knowledge base file");
      expect(detail).toContain(path);
      expect(detail).toContain(file === "settings" ? "is off until its settings file is fixed: it doesn't dictate, read or send anything, and leaves the file as it is" : "saves no change to them, and leaves the file as it is");
    },
  );

  test("a damaged file is reset by the user, by hand, into the platform's trash", () => {
    expect(fileProblemNotice("knowledgeBase", kinds[1]!, "darwin").detail).toContain("quit TabMail Voice, move this file to the Trash, and open TabMail Voice again");
    expect(fileProblemNotice("knowledgeBase", kinds[1]!, "win32").detail).toContain("move this file to the Recycle Bin");
    expect(fileProblemNotice("settings", kinds[1]!, "linux").detail).toContain("To reset your settings to the defaults");
  });

  test("a file without permission says how to give it on each platform, then to reopen the app", () => {
    expect(fileProblemNotice("settings", kinds[0]!, "darwin").detail).toContain("Get Info, and under Sharing & Permissions give your account Read & Write access");
    expect(fileProblemNotice("settings", kinds[0]!, "win32").detail).toContain("Properties > Security");
    expect(fileProblemNotice("settings", kinds[0]!, "linux").detail).toContain("chmod u+rw");
    for (const platform of ["darwin", "win32", "linux"]) expect(fileProblemNotice("settings", kinds[0]!, platform).detail).toMatch(/Then quit TabMail Voice and open it again\.$/);
  });

  test("another read error names its code", () => {
    expect(fileProblemNotice("knowledgeBase", kinds[2]!, "darwin").message).toBe("TabMail Voice couldn't read its knowledge base file (EIO).");
  });

  /** Each notice whole, so no step of the fix (or what it costs) goes missing. */
  test("each notice says, whole, what the app does meanwhile and what the user does", () => {
    expect(fileProblemNotice("knowledgeBase", kinds[1]!, "darwin")).toEqual({
      message: "TabMail Voice's knowledge base file is damaged.",
      detail: `Until it is fixed, TabMail Voice uses the defaults for your knowledge base, writing style and their history, saves no change to them, and leaves the file as it is.\n\nTo reset your knowledge base, writing style and their history to the defaults, quit TabMail Voice, move this file to the Trash, and open TabMail Voice again:\n${path}\n\nThis removes what the file held on this computer.`,
    });
    expect(fileProblemNotice("settings", kinds[2]!, "linux")).toEqual({
      message: "TabMail Voice couldn't read its settings file (EIO).",
      detail: `TabMail Voice is off until its settings file is fixed: it doesn't dictate, read or send anything, and leaves the file as it is.\n\nCheck that the disk holding it is connected and working, then quit TabMail Voice and open it again. The file:\n${path}`,
    });
    expect(fileProblemNotice("settings", kinds[0]!, "darwin")).toEqual({
      message: "TabMail Voice doesn't have permission to read its settings file.",
      detail: `TabMail Voice is off until its settings file is fixed: it doesn't dictate, read or send anything, and leaves the file as it is.\n\nIn Finder, select the file, choose File > Get Info, and under Sharing & Permissions give your account Read & Write access. The file:\n${path}\n\nThen quit TabMail Voice and open it again.`,
    });
  });

  /** The line above Settings, and the menu's while the settings can't be read. */
  test("the line shown while a file can't be read says what it costs and the Fix item", () => {
    expect(fileProblemLine("settings")).toBe("TabMail Voice can't read its settings file, so it is off until the file is fixed. Choose Fix Settings File… in TabMail Voice's menu to fix it.");
    expect(fileProblemLine("knowledgeBase")).toBe("TabMail Voice can't read its knowledge base file, so changes to your knowledge base and writing style aren't saved. Choose Fix Knowledge Base File… in TabMail Voice's menu to fix it.");
    expect(appOffLine).toBe("TabMail Voice is off until its settings file is fixed");
  });

  /** Each failed save points at the menu item as the menu names it. */
  test("a change that wasn't saved names the file's Fix item", () => {
    expect(fixFileLabel("knowledgeBase")).toBe("Fix Knowledge Base File…");
    expect(fixFileLabel("settings")).toBe("Fix Settings File…");
    for (const file of storedFiles) expect(unsavedBecauseOf(file)).toContain(`Choose ${fixFileLabel(file)} in TabMail Voice's menu`);
  });
});
