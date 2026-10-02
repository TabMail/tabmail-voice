// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import { shell } from "electron";
import * as config from "../../../core/config.js";
import { FileStoreError, type FileQuery, type FileStore, type FoundItem } from "../../../core/agent/connectors/files.js";

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const like = (value: string): string => value.replace(/[[%_]/gu, (character) => `[${character}]`);
const kinds = { document: "document", image: "picture", presentation: "presentation", spreadsheet: "spreadsheet", folder: "folder", email: "email" } as const;

/** SQL data escaping follows Windows Search SQL, rather than PowerShell or shell syntax. */
export function windowsSearchSQL(home: string, query: FileQuery, limit: number): string {
  if (!localPath(home) || !Number.isInteger(limit) || limit < 1 || limit > 100 || query.words.length < 1 || query.words.length > 100 || query.words.some((word) => word.length === 0 || word.length > 512 || Array.from(word).some((character) => character.charCodeAt(0) < 32))) throw new FileStoreError("searchFailed", "Windows Search");
  const scope = `file:${win32.normalize(home).replaceAll("\\", "/").replace(/\/$/u, "")}`;
  const clauses = [`SCOPE=${literal(scope)}`];
  for (const word of query.words) {
    const contains = literal(`"${word.replaceAll('"', '""')}*"`);
    const name = literal(`%${like(word)}%`);
    // An asterisk in a user word is literal, never a full-text wildcard. Windows Search
    // cannot escape that wildcard in CONTAINS, so use literal property matching for that word.
    const content = word.includes("*") || !/[\p{L}\p{N}]/u.test(word) ? "" : ` OR CONTAINS(System.Author, ${contains}) OR CONTAINS(System.Search.Contents, ${contains})`;
    clauses.push(`(System.ItemNameDisplay LIKE ${name} OR System.Subject LIKE ${name}${content})`);
  }
  if (query.kind === "pdf") clauses.push("System.FileExtension='.pdf'");
  else if (query.kind !== "any") {
    if (!Object.hasOwn(kinds, query.kind)) throw new FileStoreError("searchFailed", "Windows Search");
    clauses.push(`System.Kind=${literal(kinds[query.kind as keyof typeof kinds])}`);
  }
  for (const [date, operator] of [[query.changedAfter, ">="], [query.changedBefore, "<"]] as const) {
    if (date !== null) {
      if (!Number.isFinite(date.getTime())) throw new FileStoreError("searchFailed", "Windows Search");
      // Windows Search SQL parses UTC calendar literals with a space separator; ISO T/Z
      // strings do not compare correctly in its OLE DB provider (native guest regression).
      clauses.push(`System.DateModified ${operator} ${literal(date.toISOString().slice(0, 19).replace("T", " "))}`);
    }
  }
  return `SELECT TOP ${limit} System.ItemPathDisplay, System.ItemNameDisplay, System.ItemTypeText, System.DateModified, System.Subject, System.Author, System.Kind FROM SystemIndex WHERE ${clauses.join(" AND ")} ORDER BY System.DateModified DESC`;
}

// Fixed executable script; query text is JSON on stdin, never executable PowerShell source.
export const windowsSearchScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$c = $null; $r = $null
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $c = New-Object -ComObject ADODB.Connection
  $c.ConnectionTimeout = 5; $c.CommandTimeout = 20
  $c.Open('Provider=Search.CollatorDSO;Extended Properties=Application=Windows')
  $r = $c.Execute([string]$inputData.sql)
  function Field($name) { $v = $r.Fields.Item($name).Value; if ($v -is [DBNull]) { return $null }; return $v }
  $rows = @()
  while (!$r.EOF -and $rows.Count -lt 100) {
    $changed = Field 'System.DateModified'
    $rows += [pscustomobject]@{
      path = Field 'System.ItemPathDisplay'; name = Field 'System.ItemNameDisplay'
      kind = Field 'System.ItemTypeText'
      changed = $(if ($null -ne $changed) { [DateTime]::SpecifyKind([DateTime]$changed, [DateTimeKind]::Utc).ToString('o') } else { $null })
      subject = Field 'System.Subject'; authors = @(Field 'System.Author' | Where-Object { $null -ne $_ })
      isEmail = (@(Field 'System.Kind') -contains 'email')
    }
    $r.MoveNext()
  }
  [Console]::Out.Write((ConvertTo-Json -InputObject $rows -Depth 5 -Compress))
} catch { exit 1 } finally {
  if ($null -ne $r) { $r.Close() }; if ($null -ne $c) { $c.Close() }
}
`;

export type SearchRunner = (sql: string) => Promise<unknown>;
export const runWindowsSearch: SearchRunner = (sql) => new Promise((resolve, reject) => {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const child = execFile(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsSearchScript, "utf16le").toString("base64")], { windowsHide: true, encoding: "utf8", timeout: config.fileStoreRequestTimeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new FileStoreError("searchFailed", "Windows Search"));
    else {
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/u, ""))); }
      catch { reject(new FileStoreError("searchFailed", "Windows Search")); }
    }
  });
  child.stdin?.on("error", () => { /* Exit callback reports the failed process. */ });
  child.stdin?.end(JSON.stringify({ sql }));
});

/** Local Win32 paths only; no devices, alternate streams, or ambiguous normalized names. */
export function localPath(path: string): boolean {
  if (!/^[a-z]:[\\/]/iu.test(path) || /[<>:"|?*]/u.test(path.slice(2)) || Array.from(path).some((character) => character.charCodeAt(0) < 32)) return false;
  return path.slice(3).split(/[\\/]/u).every((part) => part === "" || (!/[ .]$/u.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) && part !== "." && part !== ".."));
}

const documents = new Set([".pdf", ".txt", ".rtf", ".docx", ".odt", ".pptx", ".odp", ".xlsx", ".ods", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff", ".mp3", ".wav", ".m4a", ".mp4", ".mov", ".eml"]);

export class WindowsFileStore implements FileStore {
  readonly fileManagerName = "File Explorer";
  constructor(private readonly home: string, private readonly runner: SearchRunner = runWindowsSearch) {}

  async search(query: FileQuery, limit: number): Promise<FoundItem[]> {
    try {
      const rows = await this.runner(windowsSearchSQL(this.home, query, limit));
      if (!Array.isArray(rows) || rows.length > limit) throw new Error("invalid rows");
      const base = win32.normalize(this.home).replace(/\\$/u, "").toLowerCase();
      return rows.map((row: unknown) => {
        if (row === null || typeof row !== "object") throw new Error("invalid row");
        const item = row as Record<string, unknown>;
        if (typeof item.path !== "string" || !localPath(item.path) || !win32.normalize(item.path).toLowerCase().startsWith(`${base}\\`) || typeof item.name !== "string" || typeof item.kind !== "string" || typeof item.isEmail !== "boolean" || !Array.isArray(item.authors) || item.authors.some((author) => typeof author !== "string") || (item.subject !== null && typeof item.subject !== "string")) throw new Error("invalid row");
        const changed = item.changed === null ? null : typeof item.changed === "string" ? new Date(item.changed) : new Date(NaN);
        if (changed !== null && !Number.isFinite(changed.getTime())) throw new Error("invalid date");
        return { path: item.path, name: item.name, kind: item.kind, changed, subject: item.subject as string | null, authors: item.authors as string[], isEmail: item.isEmail };
      });
    } catch { throw new FileStoreError("searchFailed", "Windows Search"); }
  }

  async open(path: string, reveal: boolean): Promise<boolean> {
    try {
      if (!localPath(path)) throw new Error("invalid path");
      const normalized = win32.normalize(path);
      const info = await lstat(normalized);
      let safe = !info.isSymbolicLink() && (info.isDirectory() || (info.isFile() && documents.has(win32.extname(normalized).toLowerCase())));
      // Junction/symlink ancestors may redirect a benign-looking document to executable content.
      for (let parent = win32.dirname(normalized); safe && parent !== win32.dirname(parent); parent = win32.dirname(parent)) {
        if ((await lstat(parent)).isSymbolicLink()) safe = false;
      }
      if (reveal || !safe) { shell.showItemInFolder(normalized); return false; }
      if (await shell.openPath(normalized)) throw new Error("open failed");
      return true;
    } catch { throw new FileStoreError("openFailed"); }
  }
}
