// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { aiOffLine, fileProblemLine, fileProblemNotice, fixFileLabel, resetButton, resetConfirmation, resetCopyPath, resetFailed, storedFiles, unsavedBecauseOf } from "../../../src/core/ui/fileProblems.js";
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
      expect(detail).toContain(file === "settings" ? "are off until your settings file is fixed: TabMail Voice doesn't dictate or read your screen, and leaves the file as it is" : "saves no change to them, and leaves the file as it is");
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
    for (const platform of ["darwin", "win32", "linux"]) expect(fileProblemNotice("settings", kinds[0]!, platform).detail).toContain(`Then quit TabMail Voice and open it again.\n\nOr choose Reset to Defaults… to start again; the file is kept, renamed.`);
  });

  test("another read error names its code", () => {
    expect(fileProblemNotice("knowledgeBase", kinds[2]!, "darwin").message).toBe("TabMail Voice couldn't read its knowledge base file (EIO).");
  });

  /** Each notice whole, so no step of the fix (or what it costs) goes missing. */
  test("each notice says, whole, what the app does meanwhile and what the user does", () => {
    expect(fileProblemNotice("knowledgeBase", kinds[1]!, "darwin")).toEqual({
      message: "TabMail Voice's knowledge base file is damaged.",
      detail: `Until it is fixed, TabMail Voice uses the defaults for your knowledge base, writing style and their history, saves no change to them, and leaves the file as it is.\n\nTo reset your knowledge base, writing style and their history to the defaults, quit TabMail Voice, move this file to the Trash, and open TabMail Voice again:\n${path}\n\nThis removes what the file held on this computer.\n\nOr choose Reset to Defaults… to start again; the file is kept, renamed.`,
    });
    expect(fileProblemNotice("settings", kinds[2]!, "linux")).toEqual({
      message: "TabMail Voice couldn't read its settings file (EIO).",
      detail: `AI features are off until your settings file is fixed: TabMail Voice doesn't dictate or read your screen, and leaves the file as it is.\n\nCheck that the disk holding it is connected and working, then quit TabMail Voice and open it again. The file:\n${path}\n\nOr choose Reset to Defaults… to start again; the file is kept, renamed.`,
    });
    expect(fileProblemNotice("settings", kinds[0]!, "darwin")).toEqual({
      message: "TabMail Voice doesn't have permission to read its settings file.",
      detail: `AI features are off until your settings file is fixed: TabMail Voice doesn't dictate or read your screen, and leaves the file as it is.\n\nIn Finder, select the file, choose File > Get Info, and under Sharing & Permissions give your account Read & Write access. The file:\n${path}\n\nThen quit TabMail Voice and open it again.\n\nOr choose Reset to Defaults… to start again; the file is kept, renamed.`,
    });
  });

  /** The line above Settings, and the menu's while the settings can't be read. */
  test("the line shown while a file can't be read says what it costs and the Fix item", () => {
    expect(fileProblemLine("settings")).toBe("TabMail Voice can't read its settings file, so its AI features are off until the file is fixed. Choose Fix Settings File… in TabMail Voice's menu to fix it.");
    expect(fileProblemLine("knowledgeBase")).toBe("TabMail Voice can't read its knowledge base file, so changes to your knowledge base and writing style aren't saved. Choose Fix Knowledge Base File… in TabMail Voice's menu to fix it.");
    expect(aiOffLine).toBe("AI features are off until your settings file is fixed");
  });

  /** Each failed save points at the menu item as the menu names it. */
  test("a change that wasn't saved names the file's Fix item", () => {
    expect(fixFileLabel("knowledgeBase")).toBe("Fix Knowledge Base File…");
    expect(fixFileLabel("settings")).toBe("Fix Settings File…");
    for (const file of storedFiles) expect(unsavedBecauseOf(file)).toContain(`Choose ${fixFileLabel(file)} in TabMail Voice's menu`);
  });
  /** The user's factory reset (owner, 2026-10-27): every notice offers it after the steps by hand. */
  test("every notice offers the reset after the steps by hand", () => {
    expect(resetButton).toBe("Reset to Defaults…");
    for (const file of storedFiles)
      for (const problem of kinds)
        for (const platform of ["darwin", "win32", "linux"])
          expect(fileProblemNotice(file, problem, platform).detail).toMatch(/\n\nOr choose Reset to Defaults… to start again; the file is kept, renamed\.$/);
  });

  test("the reset keeps the file beside it, its name dated in local time", () => {
    const now = new Date(2099, 0, 2, 3, 4, 5);
    expect(resetCopyPath("/example/TabMail Voice/settings.json", now)).toBe("/example/TabMail Voice/settings (before reset 2099-01-02 03.04.05).json");
    expect(resetCopyPath("/example/TabMail Voice/userPrompts.json", new Date(2099, 11, 31, 23, 59, 58))).toBe("/example/TabMail Voice/userPrompts (before reset 2099-12-31 23.59.58).json");
    expect(resetCopyPath("/example/TabMail Voice/settings", now)).toBe("/example/TabMail Voice/settings (before reset 2099-01-02 03.04.05)");
  });

  /** The one confirmation says plainly what this computer loses and where the file is kept; for the
   * knowledge base and writing style, that the other devices keep theirs, which Device Sync brings
   * back. */
  test("the confirmation says what is lost on this computer and where the file is kept", () => {
    const copy = "/example/TabMail Voice/settings (before reset 2099-01-02 03.04.05).json";
    expect(resetConfirmation("settings", copy)).toEqual({
      message: "Reset your settings to the defaults?",
      detail: `Your settings on this computer go back to their defaults, your dictionary and excluded apps and websites among them, and the welcome guide opens to set TabMail Voice up again. Your sign-in, memory, knowledge base and writing style stay as they are.\n\nThe file that couldn't be read isn't deleted. It is kept as:\n${copy}`,
    });
    expect(resetConfirmation("knowledgeBase", copy)).toEqual({
      message: "Reset your knowledge base, writing style and their history to the defaults?",
      detail: `Your knowledge base, writing style and their history on this computer go back to the defaults. Your other devices keep theirs, and while Sync with my other devices is on, theirs come back here. Your settings and memory stay as they are.\n\nThe file that couldn't be read isn't deleted. It is kept as:\n${copy}`,
    });
  });

  test("a reset that failed says nothing changed", () => {
    expect(resetFailed("settings")).toEqual({ message: "TabMail Voice couldn't reset its settings file.", detail: "Nothing was changed. The steps to fix it by hand still apply." });
    expect(resetFailed("knowledgeBase").message).toBe("TabMail Voice couldn't reset its knowledge base file.");
  });
});
