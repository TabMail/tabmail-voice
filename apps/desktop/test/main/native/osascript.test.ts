// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test, vi } from "vitest";
import { ScriptError } from "../../../src/core/agent/connectors/appleScript.js";
import { MessagesScripts } from "../../../src/core/agent/connectors/messages.js";
import { NotesScripts } from "../../../src/core/agent/connectors/notes.js";
import { sleep } from "../../../src/core/util/timeout.js";
import { osascript } from "../../../src/main/native/osascript.js";

// A small output cap, so a script can print past it: a test's other output stays far below.
vi.mock("../../../src/core/config.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../../src/core/config.js")>()), appleScriptMaxOutputBytes: 1_024 }));

// The real execFile, watched: a test can see whether a process was started at all.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

/** The main process's osascript, run for real on scripts that tell no app: no test sends Notes or
 * Messages an Apple Event. Their scripts are only compiled, against each app's dictionary. */
describe.runIf(process.platform === "darwin")("osascript", () => {
  const directory = mkdtempSync(join(tmpdir(), "tabmail-voice-osascript-"));
  const marker = () => join(directory, randomUUID());
  const running = () => new AbortController().signal;
  /** Returns its first argument. */
  const echo = "on run argv\n  return item 1 of argv\nend run";
  /** Creates the file its first argument names, after `delay` seconds. */
  const touch = (delay: number) => `on run argv\n  delay ${delay}\n  do shell script "touch " & quoted form of (item 1 of argv)\nend run`;

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** osascript gets the arguments as `argv`, apart from the source, whatever they hold, and its result
   * comes back without the line break osascript adds. */
  test("the arguments are passed as they are and the result comes back", async () => {
    const source = 'on run argv\n  return (item 1 of argv) & "|" & (item 2 of argv)\nend run';

    expect(await osascript.run(source, ['" & quit & "', "two\nlines\n"], running())).toBe('" & quit & "|two\nlines\n');
  });

  /** An argument that looks like an osascript option is data too: a search for `-e …` comes back as it
   * was written and runs none of it (without `--` it ran as script). */
  test("an argument like an option is never run", async () => {
    const file = marker();
    const injected = `-eproperty p : do shell script "touch " & quoted form of "${file}"`;

    for (const argument of [injected, "-e", "--", "-"]) {
      expect(await osascript.run(echo, [argument], running())).toBe(argument);
    }
    expect(existsSync(file)).toBe(false);
  });

  /** A cancelled request ends the script: what it would have done later never happens. */
  test("cancelling ends the script", async () => {
    const file = marker();
    const controller = new AbortController();

    const run = osascript.run(touch(1), [file], controller.signal);
    await sleep(200);
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "CancellationError" });
    await sleep(1_500);
    expect(existsSync(file)).toBe(false);
  });

  /** A request already cancelled starts no script at all: no osascript process, not one Node would
   * end a tick later. */
  test("an already cancelled request runs nothing", async () => {
    const file = marker();
    const controller = new AbortController();
    controller.abort();
    vi.mocked(execFile).mockClear();

    await expect(osascript.run(touch(0), [file], controller.signal)).rejects.toMatchObject({ name: "CancellationError" });
    await sleep(1_000);
    expect(execFile).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  /** The script that runs uncancelled does what it says: the two tests above are not green for a
   * script that never runs. */
  test("an uncancelled script runs", async () => {
    const file = marker();

    vi.mocked(execFile).mockClear();

    await osascript.run(touch(0), [file], running());

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(true);
  });

  /** When macOS refuses the Apple Event (-1743), the error names the app and where to allow it. */
  test("a refused app says where to allow it", async () => {
    const source = '-- tell application "Example"\nerror "Not authorized to send Apple events to Example." number -1743';

    await expect(osascript.run(source, [], running())).rejects.toEqual(ScriptError.noAccess("Example"));
  });

  /** Any other error comes back as osascript reported it, for the model to read. */
  test("another error is reported", async () => {
    const failure = osascript.run('error "Example failure"', [], running());

    await expect(failure).rejects.toBeInstanceOf(ScriptError);
    // osascript's own line, not Node's `Command failed: …` around it.
    await expect(failure).rejects.toThrow(/^\d+:\d+: execution error: Example failure \(-2700\)$/);
  });

  /** Output past the cap fails the script rather than coming back cut short, with a message though
   * osascript reported nothing. */
  test("output past the cap fails", async () => {
    const failure = osascript.run('on run argv\n  set out to ""\n  repeat 2048 times\n    set out to out & "x"\n  end repeat\n  return out\nend run', [], running());

    await expect(failure).rejects.toMatchObject({ name: "ScriptError", message: expect.stringMatching(/maxBuffer/) });
  });

  /** Each script compiles against its app's dictionary, which runs nothing and sends no event. */
  test.each([
    ["notes search", NotesScripts.search],
    ["notes create", NotesScripts.create],
    ["messages send", MessagesScripts.send],
  ])("the %s script compiles", async (_name, source) => {
    const compiled = join(directory, `${randomUUID()}.scpt`);

    await promisify(execFile)("/usr/bin/osacompile", ["-o", compiled, "-e", source]);

    expect(existsSync(compiled)).toBe(true);
  });
});
