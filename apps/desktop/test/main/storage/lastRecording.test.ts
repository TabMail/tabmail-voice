// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import { LastRecording, removeQuietly } from "../../../src/main/storage/lastRecording.js";

const folders: string[] = [];
function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"));
  folders.push(folder);
  return folder;
}

/** The errors logged from now on. */
function loggedErrors(): string[] {
  const errors: string[] = [];
  configureLog({ isDebugBuild: false, sinks: { error: (text) => void errors.push(text) } });
  return errors;
}

/** A dictation's recordings folder in a fresh scratch folder, not created yet. */
function recordingsFolder(): string {
  return join(scratch(), "Recordings");
}

function filesIn(folder: string): string[] {
  return existsSync(folder) ? readdirSync(folder) : [];
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    for (const entry of [folder, ...readdirSync(folder).map((name) => join(folder, name))]) {
      if (statSync(entry).isDirectory()) chmodSync(entry, 0o700);
    }
    rmSync(folder, { recursive: true, force: true });
  }
  configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
});

/** The recordings kept for the debug menu: one file per dictation made in debug mode, under a random
 * name in the app's own folder, none ever overwriting another; every one deleted when debug mode goes
 * off, at quit and at launch, in order, so a write still pending is removed too. */
describe("LastRecording", () => {
  test("keeps nothing until debug mode is on", async () => {
    const recording = new LastRecording(recordingsFolder());
    recording.keep(Uint8Array.from([1]));
    await recording.flush();
    expect(filesIn(recording.folder)).toEqual([]);
    expect(recording.path).toBeNull();
  });

  /** The invariant: no recording overwrites another. Each one is its own file under a random name,
   * and Play Last Recording plays the newest. */
  test("keeps every recording in its own file and plays the newest", async () => {
    const recording = new LastRecording(recordingsFolder());
    recording.follow(true);
    const kept = Array.from({ length: 20 }, (_, index) => Uint8Array.from([index, index + 1]));
    for (const wav of kept) recording.keep(wav);
    await recording.flush();

    const names = filesIn(recording.folder);
    expect(names).toHaveLength(kept.length);
    for (const name of names) expect(name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/);
    const contents = names.map((name) => [...readFileSync(join(recording.folder, name))].join(",")).sort();
    expect(contents).toEqual(kept.map((wav) => [...wav].join(",")).sort());
    expect(recording.path).not.toBeNull();
    expect([...readFileSync(recording.path ?? "")]).toEqual([19, 20]);
  });

  test("the folder and every recording are for this user alone", async () => {
    const recording = new LastRecording(recordingsFolder());
    recording.follow(true);
    recording.keep(Uint8Array.from([7]));
    await recording.flush();
    if (process.platform === "win32") return;
    expect(statSync(recording.folder).mode & 0o777).toBe(0o700);
    expect(statSync(recording.path ?? "").mode & 0o777).toBe(0o600);
  });

  /** The invariant: no recording outlives debug mode, the app's run, or a crash. Every way out
   * (debug mode off, quit, the next launch) empties the folder, files left by an earlier run
   * included. */
  test.each([
    ["debug mode going off", (recording: LastRecording) => { recording.follow(false); return recording.flush(); }],
    ["quit", (recording: LastRecording) => recording.close(1_000)],
    ["the next launch", async (recording: LastRecording) => { await LastRecording.open(recording.folder, join(scratch(), "none.wav")).flush(); }],
  ])("%s deletes every recording", async (_, leave) => {
    const recording = new LastRecording(recordingsFolder());
    recording.follow(true);
    recording.keep(Uint8Array.from([1]));
    recording.keep(Uint8Array.from([2]));
    await recording.flush();
    writeFileSync(join(recording.folder, "left-by-a-crash.wav"), "old");
    const errors = loggedErrors();

    await leave(recording);
    expect(filesIn(recording.folder)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("launching removes the file earlier versions kept, and is fine with none", async () => {
    const folder = scratch();
    const earlier = join(folder, "TabMail-last-dictation.wav");
    writeFileSync(earlier, "old");
    const errors = loggedErrors();
    await LastRecording.open(recordingsFolder(), earlier).flush();
    expect(existsSync(earlier)).toBe(false);
    await LastRecording.open(recordingsFolder(), earlier).flush();
    expect(errors).toEqual([]);
  });

  /** Debug mode being told "on" again (any settings or account change, or a launch with it on) leaves
   * the kept recordings alone. */
  test("on again keeps the recordings already there", async () => {
    const recording = new LastRecording(recordingsFolder());
    recording.follow(true);
    recording.keep(Uint8Array.from([1, 2]));
    recording.follow(true);
    await recording.flush();
    expect([...readFileSync(recording.path ?? "")]).toEqual([1, 2]);
  });

  /** With debug mode off no recording is on disk, also for a dictation that started with it on and
   * ends after it went off, and quitting keeps nothing that ends after it. */
  test("a recording that ends after debug mode went off, or after quit, is not kept", async () => {
    const recording = new LastRecording(recordingsFolder());
    recording.follow(true);
    recording.keep(Uint8Array.from([1, 2, 3]));
    recording.follow(false);
    recording.keep(Uint8Array.from([4]));
    await recording.flush();
    expect(filesIn(recording.folder)).toEqual([]);
    expect(recording.path).toBeNull();

    recording.follow(true);
    recording.keep(Uint8Array.from([5]));
    await recording.flush();
    expect([...readFileSync(recording.path ?? "")]).toEqual([5]);

    recording.keep(Uint8Array.from([6]));
    await recording.close(1_000);
    recording.keep(Uint8Array.from([7]));
    await recording.flush();
    expect(filesIn(recording.folder)).toEqual([]);
  });

  /** Two cleanups racing over the same files both succeed, and say nothing: what one deletes is
   * already gone for the other. */
  test("cleanups racing over the same recordings both succeed silently", async () => {
    const recording = new LastRecording(recordingsFolder());
    recording.follow(true);
    for (let index = 0; index < 50; index += 1) recording.keep(Uint8Array.from([index]));
    await recording.flush();
    const errors = loggedErrors();

    const other = new LastRecording(recording.folder);
    other.clear();
    recording.follow(false);
    await Promise.all([other.flush(), recording.flush(), removeQuietly(recording.folder), removeQuietly(join(recording.folder, "gone.wav"))]);
    expect(filesIn(recording.folder)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a delete that fails for another reason is logged without a path", async () => {
    const parent = scratch();
    const recording = new LastRecording(join(parent, "Recordings"));
    recording.follow(true);
    recording.keep(Uint8Array.from([1]));
    await recording.flush();
    chmodSync(parent, 0o500);
    chmodSync(recording.folder, 0o500);
    const errors = loggedErrors();

    recording.follow(false);
    await recording.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("couldn't delete");
    expect(errors[0]).not.toContain(parent);
  });

  test("a write that fails is logged without a path or content, and later ones still run", async () => {
    const errors = loggedErrors();
    const folder = scratch();
    writeFileSync(join(folder, "a-file"), "");
    const blocked = new LastRecording(join(folder, "a-file", "Recordings"));
    blocked.follow(true);
    blocked.keep(Uint8Array.from([1]));
    await blocked.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("couldn't keep the recording");
    expect(errors[0]).not.toContain(folder);
    expect(blocked.path).toBeNull();

    // The same store keeps the next recording once the cause is gone, and still deletes it.
    rmSync(join(folder, "a-file"));
    blocked.keep(Uint8Array.from([9]));
    await blocked.flush();
    expect([...readFileSync(blocked.path ?? "")]).toEqual([9]);
    blocked.follow(false);
    await blocked.flush();
    expect(filesIn(blocked.folder)).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
