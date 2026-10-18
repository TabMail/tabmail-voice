// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildMemoryHelper } from "../../scripts/memory-helper.mts";
import { buildNative } from "../../scripts/linux/build-native.mts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

// The memory helper's own build is tested in memoryHelperBuild.test.ts.
vi.mock("../../scripts/memory-helper.mts", () => ({ buildMemoryHelper: vi.fn() }));

const helpers = ["voice-hotkey", "voice-linux", "voice-microphone", "voice-screen-reader", "voice-field-reader", "voice-files", "voice-productivity"];

describe("the Linux helper build", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("puts every helper, the memory helper's own build among them, in dist/helpers", () => {
    const root = mkdtempSync(join(tmpdir(), "voice-linux-build-"));
    roots.push(root);
    // What CMake would have built for this machine, and the memory helper's build.
    const build = join(root, "native/linux/build", process.arch);
    mkdirSync(build, { recursive: true });
    for (const helper of helpers) writeFileSync(join(build, helper), `built ${helper}`);
    const memory = join(root, "memory-build", "fts_helper");
    mkdirSync(join(root, "memory-build"));
    writeFileSync(memory, "the pinned memory helper");
    vi.mocked(execFileSync).mockReturnValue(Buffer.alloc(0));
    vi.mocked(buildMemoryHelper).mockReturnValue(memory);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    buildNative(root);

    const destination = join(root, "dist/helpers");
    for (const helper of helpers) expect(readFileSync(join(destination, helper), "utf8")).toBe(`built ${helper}`);
    expect(readFileSync(join(destination, "voice-memory"), "utf8")).toBe("the pinned memory helper");
    // Built for this machine's architecture (a Linux package is built on the one it ships for),
    // named, so the toolchain's own host can't decide it.
    expect(vi.mocked(buildMemoryHelper).mock.calls).toEqual([[root, process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"]]);
  });
});
