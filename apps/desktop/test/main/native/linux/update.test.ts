// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import * as config from "../../../../src/core/config.js";
import { log } from "../../../../src/core/log.js";
import { installUpdateFailures, linuxUpdatePlatform } from "../../../../src/main/native/linux/update.js";
import { type RunFile, type UpdateInfo, type UpdateSource, UpdateError } from "../../../../src/main/updater.js";

const update: UpdateInfo = {
  version: "1.2.3",
  files: [{ url: "TabMail-Voice-1.2.3-linux-arm64.deb", sha512: "c2hhNTEy" }],
  signature: "c2lnbmF0dXJl",
  downloadedFile: "/home/user/.cache/update.deb",
};
const script = "/opt/TabMail Voice/resources/linux/install-update";
const args = ["/home/user/.cache/update.deb", "1.2.3", "c2hhNTEy", "c2lnbmF0dXJl"];

function setUp(reply: Awaited<ReturnType<RunFile>> | Error) {
  const calls: [string, string[], number | undefined][] = [];
  const run: RunFile = (file, runArgs, timeout) => {
    calls.push([file, runArgs, timeout]);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  const relaunch = vi.fn();
  const platform = linuxUpdatePlatform({ source: new EventEmitter() as unknown as UpdateSource, script, run, relaunch });
  return { platform, calls, relaunch };
}

async function refusal(promise: Promise<void>): Promise<UpdateError> {
  const error: unknown = await promise.then(() => null, (reason: unknown) => reason);
  if (!(error instanceof UpdateError)) throw new Error("not refused with an UpdateError");
  return error;
}

describe("Linux updates (ADR-DESK-050)", () => {
  test("nothing installs at the quit", () => {
    expect(setUp({ code: 0, stdout: "" }).platform.installsOnQuit).toBe(false);
  });

  test("a download is proven by install-update, as the user, with the signed fields from the feed", async () => {
    const { platform, calls } = setUp({ code: 0, stdout: "" });

    await platform.verify(update);

    expect(calls).toEqual([[script, ["verify", ...args], config.updateVerifyTimeout]]);
  });

  /** A feed without a signature, or a download without the file, is handed on empty: the script,
   * not the app, is what refuses it. */
  test("what the feed left out is passed empty, for the script to refuse", async () => {
    const { platform, calls } = setUp({ code: 3, stdout: "" });

    const error = await refusal(platform.verify({ version: "1.2.3" }));

    expect(calls[0]?.[1]).toEqual(["verify", "", "1.2.3", "", ""]);
    expect(error.message).toBe(installUpdateFailures[3]);
  });

  test.each([3, 4, 5])("install-update's exit %i is said in words", async (code) => {
    const { platform } = setUp({ code, stdout: "" });

    expect((await refusal(platform.verify(update))).message).toBe(installUpdateFailures[code]);
  });

  test("an unknown exit, or a script that couldn't run, is a failure too", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    try {
      expect((await refusal(setUp({ code: 9, stdout: "" }).platform.verify(update))).message).toBe("Version 1.2.3 couldn't be checked.");
      expect((await refusal(setUp(new Error("ENOENT")).platform.verify(update))).message).toBe("Version 1.2.3 couldn't be checked.");
      expect((await refusal(setUp(new Error("ENOENT")).platform.install(update))).message).toBe("Version 1.2.3 couldn't be installed.");
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });

  test("installing runs install-update as root through pkexec, with no time limit, then opens the new version", async () => {
    const { platform, calls, relaunch } = setUp({ code: 0, stdout: "" });

    await platform.install(update);

    expect(calls).toEqual([["/usr/bin/pkexec", [script, "install", ...args], undefined]]);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  test("a dismissed authorization is a cancel, not a failure, and nothing reopens", async () => {
    const { platform, relaunch } = setUp({ code: 126, stdout: "" });

    const error = await refusal(platform.install(update));

    expect(error.options.canceled).toBe(true);
    expect(relaunch).not.toHaveBeenCalled();
  });

  test.each([127, 6, 5, 4, 3])("an install that ends %i fails, saying why, and nothing reopens", async (code) => {
    const { platform, relaunch } = setUp({ code, stdout: "" });

    const error = await refusal(platform.install(update));

    expect(error.message).toBe(installUpdateFailures[code]);
    expect(error.options.canceled).toBeUndefined();
    expect(relaunch).not.toHaveBeenCalled();
  });
});
