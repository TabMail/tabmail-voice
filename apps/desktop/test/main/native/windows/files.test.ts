// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, expect, test, vi } from "vitest";
import { localPath, WindowsFileStore, windowsSearchSQL } from "../../../../src/main/native/windows/files.js";
import type { FileQuery } from "../../../../src/core/agent/connectors/files.js";

const mocks = vi.hoisted(() => ({ lstat: vi.fn(), openPath: vi.fn(), reveal: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat }));
vi.mock("electron", () => ({ shell: { openPath: mocks.openPath, showItemInFolder: mocks.reveal } }));
const home = "C:\\Users\\Example";
const query: FileQuery = { words: ["report"], kind: "any", changedAfter: null, changedBefore: null };
const row = { path: `${home}\\Documents\\report.txt`, name: "report.txt", kind: "Text Document", changed: "2026-09-30T10:00:00Z", subject: null, authors: [], isEmail: false };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true });
  mocks.openPath.mockResolvedValue("");
});

test("home scoped query ANDs words with filename/content and applies kind and exclusive date bounds", () => {
  const sql = windowsSearchSQL(home, { ...query, words: ["tax", "report"], kind: "pdf", changedAfter: new Date("2026-01-01Z"), changedBefore: new Date("2026-02-01Z") }, 11);
  expect(sql).toContain("SELECT TOP 11");
  expect(sql).toContain("SCOPE='file:C:/Users/Example'");
  expect(sql).toContain("System.ItemNameDisplay LIKE '%tax%'");
  expect(sql).toContain('CONTAINS(System.Search.Contents, \'"report*"\')');
  expect(sql).toContain("System.FileExtension='.pdf'");
  expect(sql).toContain("System.DateModified >= '2026-01-01 00:00:00'");
  expect(sql).toContain("System.DateModified < '2026-02-01 00:00:00'");
  expect(sql).toMatch(/ORDER BY System.DateModified DESC$/u);
});

test("literal words escape SQL quotes, LIKE wildcards, and full text phrase quotes", () => {
  const sql = windowsSearchSQL(home, { ...query, words: ["a'%_[b", 'say"hello'] }, 11);
  expect(sql).toContain("LIKE '%a''[%][_][[]b%'");
  expect(sql).toContain('CONTAINS(System.Search.Contents, \'"say""hello*"\')');
});

test("a user asterisk never becomes a broader content wildcard", () => {
  const sql = windowsSearchSQL(home, { ...query, words: ["literal*"] }, 11);
  expect(sql).toContain("LIKE '%literal*%'");
  expect(sql).not.toContain("CONTAINS");
});

test.each([0, -1, 1.5, 101, NaN])("invalid result limit %s fails before runner", async (limit) => {
  const runner = vi.fn();
  await expect(new WindowsFileStore(home, runner).search(query, limit)).rejects.toThrow("Windows Search could not run the search.");
  expect(runner).not.toHaveBeenCalled();
});

test("valid index metadata becomes shared results", async () => {
  const runner = vi.fn().mockResolvedValue([row]);
  expect(await new WindowsFileStore(home, runner).search(query, 11)).toEqual([{ ...row, changed: new Date(row.changed) }]);
});

test.each([null, {}, [{ ...row, path: "C:\\Users\\ExampleOther\\report.txt" }], [{ ...row, path: "\\\\server\\share\\report.txt" }], [{ ...row, changed: "invalid" }], [{ ...row, authors: [null] }], [{ ...row, name: null }]])("malformed or out of scope results fail closed: %j", async (rows) => {
  await expect(new WindowsFileStore(home, async () => rows).search(query, 11)).rejects.toThrow("Windows Search could not run the search.");
});

test.each(["C:report.txt", "\\\\server\\share\\report.txt", "\\\\?\\C:\\report.txt", "C:\\report.txt:run", "C:\\nul.txt", "C:\\folder.\\report.txt", "C:\\..\\report.txt", "C:\\report\u0000.txt"])("unsupported path opens nothing: %j", async (path) => {
  expect(localPath(path)).toBe(false);
  await expect(new WindowsFileStore(home).open(path, false)).rejects.toThrow("could not be opened");
  expect(mocks.openPath).not.toHaveBeenCalled();
  expect(mocks.reveal).not.toHaveBeenCalled();
});

test("normal documents open and explicit reveal uses File Explorer", async () => {
  const store = new WindowsFileStore(home);
  expect(await store.open(row.path, false)).toBe(true);
  expect(mocks.openPath).toHaveBeenCalledWith(row.path);
  expect(await store.open(row.path, true)).toBe(false);
  expect(mocks.reveal).toHaveBeenCalledWith(row.path);
});

test.each(["setup.exe", "run.ps1", "link.lnk", "book.xlsm", "book.xls", "slides.ppt", "letter.doc", "unknown.xyz", "run.js"])("executable or unknown %s is only revealed", async (name) => {
  const path = `${home}\\Documents\\${name}`;
  expect(await new WindowsFileStore(home).open(path, false)).toBe(false);
  expect(mocks.openPath).not.toHaveBeenCalled();
  expect(mocks.reveal).toHaveBeenCalledWith(path);
});

test("a junction ancestor makes an otherwise safe document reveal-only", async () => {
  mocks.lstat.mockImplementation(async (path: string) => ({ isSymbolicLink: () => path.endsWith("Documents"), isDirectory: () => false, isFile: () => true }));
  expect(await new WindowsFileStore(home).open(row.path, false)).toBe(false);
  expect(mocks.openPath).not.toHaveBeenCalled();
});

test("an unsuccessful OS open is not reported as success", async () => {
  mocks.openPath.mockResolvedValue("no association");
  await expect(new WindowsFileStore(home).open(row.path, false)).rejects.toThrow("could not be opened");
});
