// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LastRecording } from "../../../src/main/storage/lastRecording.js";

/** Creating the folder waits while `held.on` until `held.release()` (hoisted above the imports). */
const held = vi.hoisted(() => ({ on: false, release: () => {}, gate: Promise.resolve() }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (held.on) await held.gate;
      return actual.mkdir(...args);
    },
  };
});

let folder = "";
afterEach(() => {
  held.release();
  held.on = false;
  rmSync(folder, { recursive: true, force: true });
});

/** A recording still being written when debug mode goes off, or quit begins, is deleted after it
 * lands: deletes wait for the writes before them. */
describe("LastRecording with a write in progress", () => {
  test.each([
    ["debug mode going off", (recording: LastRecording) => recording.follow(false)],
    ["quit", (recording: LastRecording) => void recording.close(10_000)],
  ])("%s deletes it once it lands", async (_, leave) => {
    folder = mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"));
    held.on = true;
    held.gate = new Promise<void>((resolve) => {
      held.release = resolve;
    });
    const recording = new LastRecording(join(folder, "Recordings"));
    recording.follow(true);
    recording.keep(Uint8Array.from([1]));

    leave(recording);
    // A delete that did not wait its turn has run by now, before the write lands.
    await new Promise((resolve) => setTimeout(resolve, 50));
    held.release();
    await recording.flush();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(recording.folder) ? readdirSync(recording.folder) : []).toEqual([]);
    expect(recording.path).toBeNull();
  });
});
