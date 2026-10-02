// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, extname, isAbsolute, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { shell } from "electron";
import * as config from "../../../core/config.js";
import { FileStoreError, type FileQuery, type FileStore, type FoundItem } from "../../../core/agent/connectors/files.js";

export type LinuxSearchRunner = (input: Record<string, unknown>) => Promise<unknown>;
export const linuxSearchRunner = (executable: string): LinuxSearchRunner => (input) => new Promise((resolve, reject) => {
  const child = execFile(executable, [], { encoding: "utf8", timeout: config.fileStoreRequestTimeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new FileStoreError("searchFailed", "GNOME Search"));
    else {
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new FileStoreError("searchFailed", "GNOME Search")); }
    }
  });
  child.stdin?.on("error", () => { /* Process completion reports failure. */ });
  child.stdin?.end(JSON.stringify(input) + "\n");
});
const documents = new Set([".pdf", ".txt", ".rtf", ".docx", ".odt", ".pptx", ".odp", ".xlsx", ".ods", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff", ".mp3", ".wav", ".m4a", ".mp4", ".mov", ".eml"]);
function localPath(path: string): boolean {
  return isAbsolute(path) && !path.includes("\0") && normalize(path) === path;
}
/** GNOME's existing LocalSearch index; no private crawler or index database. */
export class LinuxFileStore implements FileStore {
  readonly fileManagerName = "Files";
  constructor(private readonly home: string, private readonly runner: LinuxSearchRunner) {}

  async search(query: FileQuery, limit: number): Promise<FoundItem[]> {
    try {
      if (!localPath(this.home) || !Number.isInteger(limit) || limit < 1 || limit > 100 || query.words.length < 1 || query.words.length > 100) throw new Error("invalid query");
      const base = this.home.replace(/\/$/u, "");
      const rows = await this.runner({ words: query.words, kind: query.kind, scope: pathToFileURL(base + "/").href, limit,
        after: query.changedAfter?.toISOString() ?? null, before: query.changedBefore?.toISOString() ?? null });
      if (!Array.isArray(rows) || rows.length > limit) throw new Error("invalid results");
      return rows.map((row: unknown): FoundItem => {
        if (!Array.isArray(row) || row.length !== 4 || typeof row[0] !== "string" || typeof row[1] !== "string" || typeof row[3] !== "string") throw new Error("invalid row");
        const path = fileURLToPath(row[0]);
        if (!localPath(path) || !path.startsWith(base + "/")) throw new Error("outside home");
        const changed = row[2] === null ? null : typeof row[2] === "string" ? new Date(row[2]) : new Date(NaN);
        if (changed && !Number.isFinite(changed.getTime())) throw new Error("invalid date");
        return { path, name: row[1], kind: row[3] || "file", changed, subject: null, authors: [], isEmail: row[3] === "message/rfc822" };
      });
    } catch { throw new FileStoreError("searchFailed", "GNOME Search"); }
  }

  async open(path: string, reveal: boolean): Promise<boolean> {
    try {
      if (!localPath(path)) throw new Error("invalid path");
      const info = await lstat(path);
      let safe = !info.isSymbolicLink() && (info.isDirectory() || (info.isFile() && (info.mode & 0o111) === 0 && documents.has(extname(path).toLowerCase())));
      for (let parent = dirname(path); safe && parent !== dirname(parent); parent = dirname(parent)) {
        if ((await lstat(parent)).isSymbolicLink()) safe = false;
      }
      if (reveal || !safe) { shell.showItemInFolder(path); return false; }
      if (await shell.openPath(path)) throw new Error("open failed");
      return true;
    } catch { throw new FileStoreError("openFailed"); }
  }
}
