// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { sleep } from "../src/core/timeout.js";
import { shortcutsCommand } from "../src/main/shortcuts.js";

// A small output cap, so a stand-in can print past it: a test's other output stays far below.
vi.mock("../src/core/config.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/core/config.js")>()), shortcutsMaxOutputBytes: 1_024 }));

// The real execFile, watched: a test can see whether a process was started at all.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

/** The main process's `shortcuts` command, run as a stand-in script that prints what it got: no test
 * runs a shortcut of the user's. */
describe.runIf(process.platform !== "win32")("the shortcuts command", () => {
  const directory = mkdtempSync(join(tmpdir(), "tabmail-voice-shortcuts-"));
  const running = () => new AbortController().signal;

  /** A stand-in for `shortcuts`: runs `body` (sh), with the arguments it got as `$@`. */
  const standIn = (body: string) => {
    const path = join(directory, randomUUID());
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o700);
    return shortcutsCommand(path);
  };
  /** Prints each argument on its own line, then `output`. */
  const echo = (output: string) => standIn(`for argument in "$@"; do printf '[%s]\\n' "$argument"; done\nprintf '%s' '${output}'`);

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** The name reaches the command as one argument, after `--`, whatever it holds (a name like an
   * option too, MIS-068), and the text output comes back as printed. */
  test.each(['Log "water"; now $(true)', "-o /tmp/x", "--help"])("a run passes %j as the name and returns the output", async (name) => {
    expect(await echo("Done\n").run(name, running())).toBe(`[run]\n[--output-type]\n[public.plain-text]\n[--]\n[${name}]\nDone\n`);
  });

  /** A run takes no input: the command reads its input to the end, and gets none. */
  test("the command gets no input", async () => {
    expect(await standIn("printf '[%s]' \"$(cat)\"").run("Morning", running())).toBe("[]");
  });

  test("the list is one name per line", async () => {
    expect(await echo("Morning\n\nLog water\n").names(running())).toEqual(["[list]", "Morning", "Log water"]);
  });

  /** A failure comes back as the command reported it, for the model to read; with nothing reported,
   * as Node's. */
  test("a failure is reported", async () => {
    await expect(standIn("printf 'Error: Could not find the shortcut\\n' >&2\nexit 1").run("Example", running())).rejects.toThrow(/^Error: Could not find the shortcut$/);
    await expect(standIn("exit 3").names(running())).rejects.toThrow(/Command failed/);
  });

  /** Output up to the cap comes back whole; past it the request fails rather than coming back cut
   * short. */
  test("output past the cap fails", async () => {
    const printing = (bytes: number) => standIn(`head -c ${bytes} /dev/zero | tr '\\0' x`);

    expect(await printing(1_024).run("Morning", running())).toBe("x".repeat(1_024));
    await expect(printing(1_025).run("Morning", running())).rejects.toThrow(/maxBuffer/);
  });

  /** A cancelled request ends the command: what it would have done later never happens. */
  test("cancelling ends the command", async () => {
    const file = join(directory, randomUUID());
    const controller = new AbortController();

    const run = standIn(`sleep 1\ntouch '${file}'`).run("Morning", controller.signal);
    await sleep(200);
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "CancellationError" });
    await sleep(1_500);
    expect(existsSync(file)).toBe(false);
  });

  /** A request already cancelled starts no command: no process, not one Node would end a tick later. */
  test("an already cancelled request runs nothing", async () => {
    const file = join(directory, randomUUID());
    const command = standIn(`touch '${file}'`);
    const controller = new AbortController();
    controller.abort();
    vi.mocked(execFile).mockClear();

    await expect(command.run("Morning", controller.signal)).rejects.toMatchObject({ name: "CancellationError" });
    await expect(command.names(controller.signal)).rejects.toMatchObject({ name: "CancellationError" });
    await sleep(500);
    expect(execFile).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  /** The command that runs uncancelled does what it says: the two tests above are not green for a
   * command that never runs. */
  test("an uncancelled command runs", async () => {
    const file = join(directory, randomUUID());
    vi.mocked(execFile).mockClear();

    await standIn(`touch '${file}'`).run("Morning", running());

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(true);
  });
});

/** The real `shortcuts` command takes the arguments as given, and a name like an option, after `--`, as
 * a shortcut's name: `--help` is looked up (and not found) rather than printing the help and
 * succeeding, and the arguments are no usage error. Runs no shortcut. */
describe.runIf(existsSync("/usr/bin/shortcuts"))("the real shortcuts command", () => {
  test("a name like an option is a name", async () => {
    const failure = shortcutsCommand().run("--help", new AbortController().signal);

    await expect(failure).rejects.toThrow();
    // The argument parser's own messages, which are not translated; the lookup's may be.
    await expect(failure).rejects.not.toThrow(/unexpected argument|Missing expected argument|Usage:|OVERVIEW:/);
  });
});
