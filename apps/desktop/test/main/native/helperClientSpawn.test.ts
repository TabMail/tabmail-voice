// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { HelperClient } from "../../../src/main/native/helperClient.js";
import { MemoryHelper } from "../../../src/main/native/memoryHelper.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

/** The Windows helpers are console programs; their console stays hidden at every start and
 *  restart, under Electron and under plain Node alike. */
test("a helper is started with no console window of its own", () => {
  const client = new HelperClient({ name: "fake-helper", executable: process.execPath, args: [join(__dirname, "../../support/fakeHelper.mjs")] });
  client.start();
  client.stop();
  expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
});

test("the memory helper is started with no console window of its own", () => {
  const scratch = mkdtempSync(join(tmpdir(), "voice-memory-spawn-"));
  try {
    vi.mocked(spawn).mockClear();
    const memory = new MemoryHelper({ executable: process.execPath, args: [join(__dirname, "../../support/fakeMemoryHelper.mjs"), "--record-dir", scratch], directory: join(scratch, "memory") });
    memory.prepare();
    memory.stop();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
