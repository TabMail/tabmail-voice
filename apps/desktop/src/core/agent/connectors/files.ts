// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../config.js";
import { LocalDateTime } from "../../util/localDateTime.js";
import { Arguments, type ConnectorServices, type ConnectorTool, defineConnector, ToolArgumentError } from "./contract.js";

/** The kinds of item the backend's `files_search` offers. */
export const fileKinds = ["any", "document", "pdf", "image", "presentation", "spreadsheet", "folder", "email"] as const;

export type FileKind = (typeof fileKinds)[number];

/** What a file search asks for: every word, of a kind, changed within the dates when given. */
export interface FileQuery {
  words: string[];
  kind: FileKind;
  changedAfter: Date | null;
  changedBefore: Date | null;
}

/** An item a file search found: a file or folder, or an Apple Mail message. */
export interface FoundItem {
  path: string;
  name: string;
  /** What the Finder calls its kind ("PDF document"). */
  kind: string;
  changed: Date | null;
  /** For an email: its subject and senders. */
  subject: string | null;
  authors: string[];
  isEmail: boolean;
}

/** The user's files (Spotlight and the Finder through `voice-macos` on a Mac, ADR-DESK-026). */
export interface FileStore {
  /** OS file manager used when a potentially executable item is only revealed. */
  readonly fileManagerName?: string;
  /** Items in the user's home folder matching `query`, most recently changed first, at most `limit`. */
  search(query: FileQuery, limit: number): Promise<FoundItem[]>;
  /** Opens the item at `path` (absolute) in its usual app, or shows it in the Finder: with `reveal`,
   * or when it can run something. True when it was opened. */
  open(path: string, reveal: boolean): Promise<boolean>;
}

/** Why a search or an open failed: the model reads the message, and tells the user. */
export type FileStoreErrorKind = "searchFailed" | "openFailed";

const fileStoreFailureMessages: Record<FileStoreErrorKind, string> = {
  searchFailed: "Spotlight could not run the search.",
  openFailed: "The item could not be opened or shown. It may have been moved or deleted, or no app opens it.",
};

export class FileStoreError extends Error {
  constructor(readonly kind: FileStoreErrorKind, searchProvider = "Spotlight") {
    super(kind === "searchFailed" ? `${searchProvider} could not run the search.` : fileStoreFailureMessages[kind]);
    this.name = "FileStoreError";
  }

  static isKind(value: unknown): value is FileStoreErrorKind {
    return typeof value === "string" && Object.hasOwn(fileStoreFailureMessages, value);
  }
}

export const filesConnector = defineConnector({
  id: "files",
  order: 40,
  platforms: ["darwin", "win32", "linux"],
  displayName: "Files",
  settingsDescription: "Finds indexed files and email messages in your home folder, and opens the ones you ask for.",
  tools: ({ fileStore, home }: Pick<ConnectorServices, "fileStore" | "home">): ConnectorTool[] => [new FilesSearchTool(fileStore, home), new FileOpenTool(fileStore, home)],
});

/** Finds files, and Apple Mail messages Spotlight has indexed, in the user's home folder
 * (`files_search`), for "find the PDF Sam sent last week". */
export class FilesSearchTool implements ConnectorTool {
  readonly name = "files_search";
  readonly connector = "files";
  readonly progressLabel = "Searching your files";

  constructor(
    private readonly store: FileStore,
    private readonly home: string,
  ) {}

  confirmation(): null {
    return null;
  }

  /** At most `filesSearchMaxResults` items, newest first; a search matching more says so. */
  async run(args: Record<string, unknown>): Promise<string> {
    const query = FilesSearchTool.query(args);
    const limit = config.filesSearchMaxResults;
    // One more than shown, to know whether there are more.
    const items = await this.store.search(query, limit + 1);
    const request = `"${query.words.join(" ")}"`;
    if (items.length === 0) return `Nothing matches ${request}.`;
    const lines = [`Items matching ${request}, newest first:`, ...items.slice(0, limit).map((item) => `- ${this.describe(item)}`)];
    if (items.length > limit) lines.push("(More items match; search with more words, a kind or dates.)");
    return lines.join("\n");
  }

  /** The search the arguments describe: `query`'s words, `kind` (any by default), and the dates, a day
   * for `changed_before` reading through its end. */
  static query(args: Record<string, unknown>): FileQuery {
    const text = Arguments.text(args, "query");
    if (text === null) throw ToolArgumentError.missing("query");
    const kind = Arguments.text(args, "kind") ?? "any";
    if (!isFileKind(kind)) throw new ToolArgumentError(`kind must be one of: ${fileKinds.join(", ")}.`);
    return { words: text.split(/\s+/u), kind, changedAfter: Arguments.localDate(args, "changed_after")?.date ?? null, changedBefore: Arguments.localEnd(args, "changed_before") };
  }

  /** The item as the model reads it, with the path `file_open` takes (the home folder as `~`). */
  private describe(item: FoundItem): string {
    const changed = item.changed === null ? "" : `, changed ${LocalDateTime.describe(item.changed)}`;
    const path = abbreviated(item.path, this.home);
    if (!item.isEmail) return `${item.name} (${item.kind})${changed}: ${path}`;
    const from = item.authors.length === 0 ? "" : ` from ${item.authors.join(", ")}`;
    return `Email "${item.subject ?? item.name}"${from}${changed}: ${path}`;
  }
}

function isFileKind(value: string): value is FileKind {
  return (fileKinds as readonly string[]).includes(value);
}

/** `path` with the home folder written `~`. */
function abbreviated(path: string, home: string): string {
  if (windowsHome(home)) {
    const normalized = path.replaceAll("\\", "/");
    const base = home.replaceAll("\\", "/").replace(/\/$/u, "");
    const lower = normalized.toLowerCase();
    return lower === base.toLowerCase() || lower.startsWith(`${base.toLowerCase()}/`) ? `~${normalized.slice(base.length)}` : path;
  }
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function windowsHome(home: string): boolean {
  return /^[a-z]:[\\/]/iu.test(home);
}

/** Opens what `files_search` found in its usual app, or shows it in the Finder (`file_open`). Opening
 * neither sends nor creates, so nothing is asked first; an app or a script is only ever shown. */
export class FileOpenTool implements ConnectorTool {
  readonly name = "file_open";
  readonly connector = "files";
  readonly progressLabel = "Opening it";

  constructor(
    private readonly store: FileStore,
    private readonly home: string,
  ) {}

  confirmation(): null {
    return null;
  }

  async run(args: Record<string, unknown>): Promise<string> {
    const given = Arguments.text(args, "path");
    if (given === null) throw ToolArgumentError.missing("path");
    const windows = windowsHome(this.home);
    const homeRelative = given === "~" || given.startsWith("~/") || (windows && given.startsWith("~\\"));
    const expanded = homeRelative ? `${this.home}${given.slice(1)}` : given;
    const path = windows ? expanded.replaceAll("/", "\\") : expanded;
    // Windows accepts local drive paths only. Network/device paths and alternate streams never
    // come from our home-scoped index; leave native safe-open policy to classify real items.
    const noControls = !Array.from(path).some((character) => character.charCodeAt(0) < 32);
    const absolute = windows ? /^[a-z]:\\[^<>:"|?*]*$/iu.test(path) && noControls : path.startsWith("/");
    if (!absolute) throw new ToolArgumentError("path must be a path files_search returned.");
    const name = path.split(windows ? "\\" : "/").filter((part) => part !== "").at(-1) ?? path;
    const manager = this.store.fileManagerName ?? "Finder";
    const reveal = args.reveal === true;
    const opened = await this.store.open(path, reveal);
    if (opened) return `Opened ${name}.`;
    if (reveal) return `Showed ${name} in the ${manager}.`;
    return `Showed ${name} in the ${manager} instead of opening it: it is an app, a script, a link or another item that can run or install something.`;
  }
}
