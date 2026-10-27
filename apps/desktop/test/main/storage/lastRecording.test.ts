// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  test("keeps nothing until debug mode is on", async () => {
    const recording = new LastRecording(join(scratch(), "last.wav"));
    recording.keep(Uint8Array.from([1]));
    await recording.flush();
    expect(recording.exists).toBe(false);
  });

  test("keeps the latest recording and replaces the one before", async () => {
    const recording = new LastRecording(join(scratch(), "last.wav"));
    recording.follow(true);
    recording.keep(Uint8Array.from([1, 2, 3]));
    recording.keep(Uint8Array.from([4, 5]));
    await recording.flush();
    expect(recording.exists).toBe(true);
    expect([...readFileSync(recording.path)]).toEqual([4, 5]);
  });

  test("off deletes the file, and is fine with none", async () => {
    const recording = new LastRecording(join(scratch(), "last.wav"));
    recording.follow(false);
    await recording.flush();
    recording.follow(true);
    recording.keep(Uint8Array.from([1]));
    recording.follow(false);
    await recording.flush();
    expect(existsSync(recording.path)).toBe(false);
  });

  /** Debug mode being told "on" again (any settings or account change, or a launch with it on) leaves
   * the kept recording alone. */
  test("on again keeps the file already there", async () => {
    const recording = new LastRecording(join(scratch(), "last.wav"));
    recording.follow(true);
    recording.keep(Uint8Array.from([1, 2]));
    recording.follow(true);
    await recording.flush();
    expect([...readFileSync(recording.path)]).toEqual([1, 2]);
  });

  /** The invariant: with debug mode off no recording is on disk, also for a dictation that started
   * with it on and ends after it went off. */
  test("a recording that ends after debug mode went off is not kept", async () => {
    const recording = new LastRecording(join(scratch(), "last.wav"));
    recording.follow(true);
    recording.keep(Uint8Array.from([1, 2, 3]));
    recording.follow(false);
    recording.keep(Uint8Array.from([4]));
    await recording.flush();
    expect(existsSync(recording.path)).toBe(false);

    recording.follow(true);
    recording.keep(Uint8Array.from([5]));
    await recording.flush();
    expect([...readFileSync(recording.path)]).toEqual([5]);
  });

  /** The temporary folder is shared on Linux: the file is for this user alone, and a symlink planted
   * at its name is replaced, never written through. */
  test.skipIf(process.platform === "win32")("is private to the user and never written through a symlink", async () => {
    const folder = scratch();
    const victim = join(folder, "victim");
    writeFileSync(victim, "untouched");
    const recording = new LastRecording(join(folder, "last.wav"));
    symlinkSync(victim, recording.path);
    recording.follow(true);
    recording.keep(Uint8Array.from([7]));
    await recording.flush();
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect([...readFileSync(recording.path)]).toEqual([7]);
    expect(statSync(recording.path).mode & 0o777).toBe(0o600);
  });

  test("a write that fails is logged without a path or content, and later ones still run", async () => {
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => void errors.push(text) } });
    const folder = scratch();
    const missing = new LastRecording(join(folder, "no-such-folder", "last.wav"));
    missing.follow(true);
    missing.keep(Uint8Array.from([1]));
    await missing.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("couldn't keep the last recording");
    expect(errors[0]).not.toContain(folder);

    const recording = new LastRecording(join(folder, "last.wav"));
    recording.follow(true);
    recording.keep(Uint8Array.from([9]));
    await recording.flush();
    expect(existsSync(recording.path)).toBe(true);
  });
});
