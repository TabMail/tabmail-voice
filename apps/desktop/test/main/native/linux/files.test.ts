// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { beforeEach, expect, test as anyHostTest, vi } from "vitest";
import { LinuxFileStore } from "../../../../src/main/native/linux/files.js";
const mocks = vi.hoisted(() => ({ lstat: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat }));
vi.mock("electron", () => ({ shell: { openPath: mocks.openPath, showItemInFolder: mocks.showItemInFolder } }));
// The store reads paths and file URLs by the machine's own rules, Linux's; a Windows machine
// running the tests (its release build) reads them by its own.
const test = anyHostTest.skipIf(process.platform === "win32");
const query = { words: ["report"], kind: "any" as const, changedAfter: null, changedBefore: null };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.openPath.mockResolvedValue("");
  mocks.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, mode: 0o644 });
});
test("passes words as data and constrains the query to the home URI", async () => {
  const runner = vi.fn().mockResolvedValue([["file:///home/synthetic/report%20one.pdf", "report one.pdf", "2026-10-01T12:00:00Z", "application/pdf"]]);
  const store = new LinuxFileStore("/home/synthetic", runner);
  const rows = await store.search({ ...query, words: ["' OR anything"] }, 5);
  expect(runner).toHaveBeenCalledWith({ words: ["' OR anything"], kind: "any", scope: "file:///home/synthetic/", limit: 5, after: null, before: null });
  expect(rows[0]?.path).toBe("/home/synthetic/report one.pdf");
});
test.each(["file:///etc/report.pdf", "file:///home/synthetic-other/report.pdf", "https://example.com/report.pdf", "file:///home/synthetic/../report.pdf"])("refuses an invalid or out-of-home result %s", async (url) => {
  const store = new LinuxFileStore("/home/synthetic", async () => [[url, "report", null, "application/pdf"]]);
  await expect(store.search(query, 5)).rejects.toThrow("GNOME Search");
});
test("opens an ordinary document", async () => {
  const store = new LinuxFileStore("/home/synthetic", async () => []);
  await expect(store.open("/home/synthetic/report.pdf", false)).resolves.toBe(true);
  expect(mocks.openPath).toHaveBeenCalledWith("/home/synthetic/report.pdf");
});
test("reveals executable documents without launching them", async () => {
  mocks.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, mode: 0o755 });
  const store = new LinuxFileStore("/home/synthetic", async () => []);
  await expect(store.open("/home/synthetic/report.pdf", false)).resolves.toBe(false);
  expect(mocks.openPath).not.toHaveBeenCalled();
  expect(mocks.showItemInFolder).toHaveBeenCalled();
});
test("reveals a document through a symlinked ancestor", async () => {
  mocks.lstat.mockImplementation(async (path: string) => ({ isSymbolicLink: () => path === "/home/synthetic/link", isDirectory: () => false, isFile: () => true, mode: 0o644 }));
  const store = new LinuxFileStore("/home/synthetic", async () => []);
  await expect(store.open("/home/synthetic/link/report.pdf", false)).resolves.toBe(false);
  expect(mocks.openPath).not.toHaveBeenCalled();
});
