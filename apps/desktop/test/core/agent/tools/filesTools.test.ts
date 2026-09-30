// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test } from "vitest";
import { type FileQuery, type FileStore, FileOpenTool, FilesSearchTool, FileStoreError, filesTools, type FoundItem } from "../../../../src/core/agent/tools/filesTools.js";
import { ToolArgumentError } from "../../../../src/core/agent/tools/connectorTool.js";
import * as config from "../../../../src/core/config.js";
import { LocalDateTime } from "../../../../src/core/util/localDateTime.js";

/** Spotlight as the Answer prompt's Files tools, against a stand-in store (never the user's files):
 * the search asked for, what the model reads back, and what `file_open` asks the helper to open
 * (from the Swift `FilesToolsTests`; the Spotlight query and `OpenPolicy` are the helper's,
 * `FileSearchTests`). */

const home = "/Users/example";

/** Spotlight in memory: records each search and open, returning `items` up to the limit and opening
 * what `opens` allows. */
class FakeFileStore implements FileStore {
  items: FoundItem[] = [];
  opens = true;
  failure: Error | null = null;
  readonly queries: FileQuery[] = [];
  readonly limits: number[] = [];
  readonly opened: { path: string; reveal: boolean }[] = [];

  async search(query: FileQuery, limit: number): Promise<FoundItem[]> {
    this.queries.push(query);
    this.limits.push(limit);
    return this.items.slice(0, limit);
  }

  async open(path: string, reveal: boolean): Promise<boolean> {
    if (this.failure) throw this.failure;
    this.opened.push({ path, reveal });
    return !reveal && this.opens;
  }
}

/** A week from today, at 00:00. */
const day = (() => {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
})();

const pad = (value: number) => String(value).padStart(2, "0");
const isoDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function item(fields: Partial<FoundItem> & { path: string; name: string; kind: string }): FoundItem {
  return { changed: null, subject: null, authors: [], isEmail: false, ...fields };
}

let store: FakeFileStore;
beforeEach(() => {
  store = new FakeFileStore();
});

describe("files_search", () => {
  /** The words, kind and dates as asked, a day for `changed_before` reading through its end; the items
   * newest first with their kind, change and a `~` path, an email by subject and sender. */
  test("the matches are read with their paths", async () => {
    const changed = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
    store.items = [
      item({ path: `${home}/Documents/Tax return.pdf`, name: "Tax return.pdf", kind: "PDF document", changed }),
      item({ path: `${home}/Library/Mail/V10/1.emlx`, name: "1.emlx", kind: "Mail Message", changed: day, subject: "Your tax return", authors: ["Sam Example", "Alex Example"], isEmail: true }),
      item({ path: `${home}/Library/Mail/V10/2.emlx`, name: "2.emlx", kind: "Email Message", isEmail: true }),
      item({ path: home, name: "example", kind: "Folder" }),
      item({ path: "/Volumes/Shared/tax.txt", name: "tax.txt", kind: "Plain Text" }),
      item({ path: `${home}example/tax.txt`, name: "tax.txt", kind: "Plain Text" }),
    ];
    const tool = new FilesSearchTool(store, home);

    const result = await tool.run({ query: " tax  return ", kind: "pdf", changed_after: isoDay(day), changed_before: isoDay(day) });

    expect(store.queries).toEqual([{ words: ["tax", "return"], kind: "pdf", changedAfter: day, changedBefore: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1) }]);
    expect(result).toBe(
      [
        'Items matching "tax return", newest first:',
        `- Tax return.pdf (PDF document), changed ${LocalDateTime.describe(changed)}: ~/Documents/Tax return.pdf`,
        `- Email "Your tax return" from Sam Example, Alex Example, changed ${LocalDateTime.describe(day)}: ~/Library/Mail/V10/1.emlx`,
        '- Email "2.emlx": ~/Library/Mail/V10/2.emlx',
        "- example (Folder): ~",
        "- tax.txt (Plain Text): /Volumes/Shared/tax.txt",
        `- tax.txt (Plain Text): ${home}example/tax.txt`,
      ].join("\n"),
    );
  });

  test("nothing matching says so", async () => {
    const tool = new FilesSearchTool(store, home);

    expect(await tool.run({ query: "invoice" })).toBe('Nothing matches "invoice".');
    expect(store.queries).toEqual([{ words: ["invoice"], kind: "any", changedAfter: null, changedBefore: null }]);
  });

  /** A search matching more than the model is shown stops at the limit and says there are more;
   * exactly the limit doesn't. */
  test("a search matching many is cut short and says so", async () => {
    const limit = config.filesSearchMaxResults;
    store.items = Array.from({ length: limit + 1 }, (_, index) => item({ path: `${home}/Notes ${index}.txt`, name: `Notes ${index}.txt`, kind: "Plain Text" }));
    const tool = new FilesSearchTool(store, home);

    const lines = (await tool.run({ query: "notes" })).split("\n");

    expect(store.limits).toEqual([limit + 1]);
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(limit);
    expect(lines.at(-1)).toBe("(More items match; search with more words, a kind or dates.)");
    store.items.pop();
    expect(await tool.run({ query: "notes" })).not.toContain("More items match");
  });

  /** Arguments it can't use search nothing: the model is told why. */
  test.each<Record<string, unknown>>([{}, { query: "  " }, { query: 7 }, { query: "tax", kind: "video" }, { query: "tax", kind: "toString" }, { query: "tax", changed_after: "last week" }, { query: "tax", changed_before: "2099-02-30" }])(
    "%j is not searched",
    async (args) => {
      const tool = new FilesSearchTool(store, home);

      await expect(tool.run(args)).rejects.toBeInstanceOf(ToolArgumentError);
      expect(store.queries).toEqual([]);
    },
  );

  test("an unknown kind names the kinds there are", () => {
    expect(() => FilesSearchTool.query({ query: "tax", kind: "video" })).toThrow("kind must be one of: any, document, pdf, image, presentation, spreadsheet, folder, email.");
  });
});

describe("file_open", () => {
  /** A document is opened from the `~` path the search gave; with `reveal` it is shown in the Finder;
   * nothing is asked first. */
  test("a document is opened or shown", async () => {
    const tool = new FileOpenTool(store, home);

    expect(await tool.run({ path: "~/Documents/Tax return.pdf" })).toBe("Opened Tax return.pdf.");
    expect(await tool.run({ path: `${home}/Documents/Tax return.pdf`, reveal: true })).toBe("Showed Tax return.pdf in the Finder.");
    expect(await tool.run({ path: "~", reveal: "yes" })).toBe("Opened example.");
    expect(await tool.run({ path: "/Volumes/Shared/Receipts/" })).toBe("Opened Receipts.");
    expect(store.opened).toEqual([
      { path: `${home}/Documents/Tax return.pdf`, reveal: false },
      { path: `${home}/Documents/Tax return.pdf`, reveal: true },
      { path: home, reveal: false },
      { path: "/Volumes/Shared/Receipts/", reveal: false },
    ]);
    expect(tool.confirmation()).toBeNull();
  });

  /** What the helper would only show (an app or a script) is reported as shown instead. */
  test("an app or script is only shown, and says why", async () => {
    store.opens = false;
    const tool = new FileOpenTool(store, home);

    expect(await tool.run({ path: "~/Downloads/setup.command" })).toBe("Showed setup.command in the Finder instead of opening it: it is an app, a script, a link or another item that can run or install something.");
  });

  /** A path that isn't one `files_search` gave opens nothing: `~user` and relative paths included. */
  test.each<Record<string, unknown>>([{}, { path: " " }, { path: "Documents/Tax return.pdf" }, { path: "~example/Documents/Tax return.pdf" }, { path: 7 }])("%j opens nothing", async (args) => {
    const tool = new FileOpenTool(store, home);

    await expect(tool.run(args)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(store.opened).toEqual([]);
  });

  /** An item that can't be opened fails the call, which the model tells the user. */
  test("a failed open is reported", async () => {
    store.failure = new FileStoreError("openFailed");
    const tool = new FileOpenTool(store, home);

    await expect(tool.run({ path: "~/Documents/Gone.pdf" })).rejects.toThrow("The item could not be opened or shown. It may have been moved or deleted, or no app opens it.");
    expect(new FileStoreError("searchFailed").message).toBe("Spotlight could not run the search.");
  });
});

describe("connector", () => {
  /** The Files switch covers both tools, and neither asks first. */
  test("the Files switch covers its tools", () => {
    const tools = filesTools(store, home);

    expect(tools.map((tool) => [tool.connector, tool.name])).toEqual([
      ["files", "files_search"],
      ["files", "file_open"],
    ]);
    expect(tools.map((tool) => tool.confirmation({ query: "tax", path: "/tmp/example.pdf" }))).toEqual([null, null]);
  });
});
