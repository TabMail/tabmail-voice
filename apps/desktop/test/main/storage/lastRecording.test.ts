// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import { LastRecording } from "../../../src/main/storage/lastRecording.js";

const folders: string[] = [];
function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"));
  folders.push(folder);
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
});

/** The last recording kept for the debug menu: written while debug mode is on, deleted when it goes
 * off, in order, so a write still pending is removed too. */
describe("LastRecording", () => {
  test("keeps the latest recording and replaces the one before", async () => {
    const recording = new LastRecording(join(scratch(), "last.wav"));
    expect(recording.exists).toBe(false);
    recording.keep(Uint8Array.from([1, 2, 3]));
    recording.keep(Uint8Array.from([4, 5]));
    await recording.flush();
    expect(recording.exists).toBe(true);
    expect([...readFileSync(recording.path)]).toEqual([4, 5]);
  });

  test("discard deletes the file, and is fine with none", async () => {
    const recording = new LastRecording(join(scratch(), "last.wav"));
    recording.discard();
    await recording.flush();
    recording.keep(Uint8Array.from([1]));
    recording.discard();
    await recording.flush();
    expect(existsSync(recording.path)).toBe(false);
  });

  /** The invariant: after debug mode goes off no recording is on disk, even one written just then. */
  test("a discard right after a keep leaves nothing behind", async () => {
    const recording = new LastRecording(join(scratch(), "last.wav"));
    recording.keep(Uint8Array.from([1, 2, 3]));
    recording.discard();
    await recording.flush();
    expect(existsSync(recording.path)).toBe(false);
  });

  test("a write that fails is logged without a path or content, and later ones still run", async () => {
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => void errors.push(text) } });
    const folder = scratch();
    const missing = new LastRecording(join(folder, "no-such-folder", "last.wav"));
    missing.keep(Uint8Array.from([1]));
    await missing.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("couldn't keep the last recording");
    expect(errors[0]).not.toContain(folder);

    const recording = new LastRecording(join(folder, "last.wav"));
    recording.keep(Uint8Array.from([9]));
    await recording.flush();
    expect(existsSync(recording.path)).toBe(true);
  });
});
