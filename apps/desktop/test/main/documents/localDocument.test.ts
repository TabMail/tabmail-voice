// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtemp, mkdir, writeFile, rename, symlink, rm, truncate, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { documentMaxBytes } from "../../../src/core/config.js";
import { LocalDocument, localDocumentPath } from "../../../src/main/documents/localDocument.js";

const roots: string[] = [];
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "voice-document-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const path = join(home, "document.pdf");
  await writeFile(path, "%PDF-synthetic");
  return { root, home, path };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("prepares the resolved path and reads its approved bytes", async () => {
  const { home, path } = await fixture();
  const document = await LocalDocument.prepare("~/document.pdf", home, signal());
  expect(document.path).toBe(await realpath(path));
  expect(new TextDecoder().decode(await document.read(signal()))).toBe("%PDF-synthetic");
});

test("a symlink within home exposes the target path for approval", async () => {
  const { home, path } = await fixture();
  const alias = join(home, "alias.pdf");
  await symlink(path, alias);
  expect((await LocalDocument.prepare(alias, home, signal())).path).toBe(await realpath(path));
});

test("rejects outside files, symlink escapes, and directories", async () => {
  const { root, home } = await fixture();
  const outside = join(root, "outside.pdf");
  await writeFile(outside, "private");
  const alias = join(home, "escape.pdf");
  await symlink(outside, alias);
  for (const path of [outside, alias, home]) await expect(LocalDocument.prepare(path, home, signal())).rejects.toThrow("regular local files");
});

test.each(["replacement", "edit", "symlink"])("rejects %s after preparation", async (kind) => {
  const { home, path, root } = await fixture();
  const document = await LocalDocument.prepare(path, home, signal());
  if (kind === "edit") await writeFile(path, "changed");
  else {
    await rename(path, join(root, "old.pdf"));
    if (kind === "symlink") await symlink(join(root, "old.pdf"), path);
    else await writeFile(path, "%PDF-synthetic");
  }
  await expect(document.read(signal())).rejects.toThrow("unchanged");
});

test("rejects an ancestor replaced by an outside symlink after preparation", async () => {
  const { home, root } = await fixture();
  const directory = join(home, "documents");
  await mkdir(directory);
  const path = join(directory, "one.pdf");
  await writeFile(path, "%PDF-synthetic");
  const document = await LocalDocument.prepare(path, home, signal());
  const moved = join(root, "moved");
  await rename(directory, moved);
  await symlink(moved, directory, "dir");
  await expect(document.read(signal())).rejects.toThrow("unchanged");
});

test("rejects oversize before allocating file contents", async () => {
  const { home, path } = await fixture();
  await truncate(path, documentMaxBytes + 1);
  await expect(LocalDocument.prepare(path, home, signal())).rejects.toThrow("20 MiB");
});

test("cancellation refuses preparation and reading", async () => {
  const { home, path } = await fixture();
  const document = await LocalDocument.prepare(path, home, signal());
  const abort = new AbortController(); abort.abort();
  await expect(LocalDocument.prepare(path, home, abort.signal)).rejects.toThrow();
  await expect(document.read(abort.signal)).rejects.toThrow();
});

test.each(["https://example.com/a.pdf", "file:///tmp/a.pdf", "relative.pdf", "/tmp/a\n.pdf"])("rejects nonlocal/control path %s", (path) => {
  expect(() => localDocumentPath(path, "/home/example", false)).toThrow();
});

test.each(["\\\\server\\share\\a.pdf", "\\\\?\\C:\\a.pdf", "C:\\a.pdf:secret", "C:\\CON.pdf", "C:\\dir.\\a.pdf", "C:\\dir \\a.pdf", "C:\\LPT1", "C:relative.pdf"])("rejects Windows special path %s", (path) => {
  expect(() => localDocumentPath(path, "C:\\Users\\example", true)).toThrow();
});

test("normalizes ordinary Windows home paths", () => {
  expect(localDocumentPath("~/Documents/a.pdf", "C:\\Users\\example", true)).toBe("C:\\Users\\example\\Documents\\a.pdf");
});
