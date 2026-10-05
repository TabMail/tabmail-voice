// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { test, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fstatSync } from "node:fs";
const state = vi.hoisted(() => ({ afterRead: undefined as undefined | (() => Promise<void>), reads: 0, descriptors: [] as number[], cleanup: [] as (() => Promise<void>)[] }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    state.descriptors.push(handle.fd);
    state.cleanup.push(close);
    handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
      const result = await read(...readArgs);
      state.reads++;
      const after = state.afterRead; state.afterRead = undefined;
      if (after) await after();
      return result;
    }) as typeof handle.read;
    return handle;
  }};
});
import { LocalDocument } from "../../../src/main/documents/localDocument.js";
const roots: string[] = [];
afterEach(async () => {
  for (const close of state.cleanup.splice(0)) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  state.afterRead = undefined; state.reads = 0;
  state.descriptors = [];
});
async function prepare() {
  const root = await mkdtemp(join(tmpdir(), "voice-document-lifecycle-")); roots.push(root);
  const path = join(root, "synthetic.pdf"), before = Buffer.alloc(131072, "A");
  await writeFile(path, before);
  const signal = new AbortController().signal;
  return { root, path, before, signal, document: await LocalDocument.prepare(path, root, signal) };
}
test("unchanged approved bytes are returned and the descriptor is closed", async () => {
  const f = await prepare();
  const result = await f.document.read(f.signal);
  expect(Buffer.from(result)).toEqual(f.before);
  expect(state.reads).toBe(2);
  expect(state.descriptors).toHaveLength(1);
  for (const fd of state.descriptors) expect(() => fstatSync(fd)).toThrow(/EBADF/u);
});
test("an in-place writer between chunks cannot publish mixed approved and replacement bytes", async () => {
  const f = await prepare(), after = Buffer.alloc(131072, "B");
  state.afterRead = () => writeFile(f.path, after);
  let result: Uint8Array | undefined, error: unknown;
  try { result = await f.document.read(f.signal); } catch (caught) { error = caught; }
  expect(await readFile(f.path)).toEqual(after);
  expect(state.reads).toBe(2);
  expect(state.descriptors).toHaveLength(1);
  for (const fd of state.descriptors) expect(() => fstatSync(fd)).toThrow(/EBADF/u);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("unchanged");
  expect(result).toBeUndefined();
});

test.each(["cancel", "read error"])("a mid-read %s refuses bytes and closes the actual descriptor", async (reason) => {
  const f = await prepare(), abort = new AbortController();
  state.afterRead = async () => {
    if (reason === "cancel") abort.abort();
    else throw new Error("synthetic read failure");
  };
  let result: Uint8Array | undefined, error: unknown;
  try { result = await f.document.read(abort.signal); } catch (caught) { error = caught; }
  expect(state.reads).toBe(1);
  expect(state.descriptors).toHaveLength(1);
  for (const fd of state.descriptors) expect(() => fstatSync(fd)).toThrow(/EBADF/u);
  expect(error).toBeInstanceOf(Error);
  expect(result).toBeUndefined();
  expect(await readFile(f.path)).toEqual(f.before);
});
