// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test, vi } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import { LastRecording } from "../../../src/main/storage/lastRecording.js";

/** A delete that never finishes, as a stuck disk would give (hoisted above the imports). */
vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")),
  rm: () => new Promise<void>(() => {}),
}));

afterEach(() => {
  vi.useRealTimers();
  configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
});

/** Quitting waits for the recordings to be deleted only up to its bound, so it never hangs; what is
 * left goes at the next launch. */
describe("LastRecording.close", () => {
  test("a delete that never finishes holds quitting only up to the bound, and is logged", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    configureLog({ isDebugBuild: false, sinks: { error: (text) => void errors.push(text) } });
    let closed = false;
    void new LastRecording("/nonexistent/Recordings").close(2_000).then(() => {
      closed = true;
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toBe(true);
    expect(errors).toEqual(["main: the recordings weren't deleted at quit: TimeoutError"]);
  });
});
