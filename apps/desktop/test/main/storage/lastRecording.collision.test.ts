// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import { LastRecording } from "../../../src/main/storage/lastRecording.js";

/** Every random name the same, as a collision would give (hoisted above the imports). */
vi.mock("node:crypto", async () => ({
  ...(await vi.importActual<typeof import("node:crypto")>("node:crypto")),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

let folder = "";
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
});

/** No recording overwrites another, even under a name that collides: the second is not written, and
 * that is logged. */
describe("LastRecording under a colliding name", () => {
  test("the recording already there is kept, and the one after it is logged as not kept", async () => {
    folder = mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"));
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => void errors.push(text) } });
    const recording = new LastRecording(join(folder, "Recordings"));
    recording.follow(true);
    recording.keep(Uint8Array.from([1]));
    recording.keep(Uint8Array.from([2]));
    await recording.flush();

    expect(readdirSync(recording.folder)).toHaveLength(1);
    expect([...readFileSync(recording.path ?? "")]).toEqual([1]);
    expect(errors).toEqual(["main: couldn't keep the recording: Error"]);
  });
});
