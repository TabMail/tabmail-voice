// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configureLog } from "../../../src/core/log.js";
import { LogFile } from "../../../src/main/storage/logFile.js";

const folders: string[] = [];
function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), "TabMailVoiceTests-"));
  folders.push(folder);
  return folder;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  configureLog({ isDebugBuild: false, sinks: { error: () => {} } });
});

/** The debug log file, written in a scratch folder: lines are appended in order, and a file past its
 * size limit is moved aside (replacing the earlier one) before the next line starts a new file. */

describe("LogFile", () => {
  test("appends lines in order, creating the folder", async () => {
    const path = join(scratch(), "Logs/Test.log");
    await LogFile.write("one\n", path, 1_000);
    await LogFile.write("two\n", path, 1_000);
    expect(read(path)).toBe("one\ntwo\n");
  });

  test("a full file is moved aside and a new one started", async () => {
    const path = join(scratch(), "Logs/Test.log");
    const previous = LogFile.previousPath(path);
    expect(previous.endsWith("/Logs/Test.1.log")).toBe(true);
    await LogFile.write("0123456789\n", path, 10);
    await LogFile.write("second\n", path, 10);
    expect(read(previous)).toBe("0123456789\n");
    expect(read(path)).toBe("second\n");
    // Within the limit nothing moves; past it again, the earlier file is replaced.
    await LogFile.write("third\n", path, 10);
    expect(read(path)).toBe("second\nthird\n");
    await LogFile.write("fourth\n", path, 10);
    expect(read(previous)).toBe("second\nthird\n");
    expect(read(path)).toBe("fourth\n");
  });

  /** Each line carries its time and level, in the order appended. */
  test("appended lines are stamped and kept in order", async () => {
    const file = new LogFile(join(scratch(), "Test.log"), 1_000_000);
    for (let index = 0; index < 20; index += 1) file.append("debug", `line ${index}`);
    file.append("ERROR", "last");
    await file.flush();
    const lines = (read(file.path) ?? "").trimEnd().split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2}) debug line 0$/);
    expect(lines.map((line) => line.split(" ").slice(2).join(" "))).toEqual([...Array.from({ length: 20 }, (_, index) => `line ${index}`), "last"]);
  });
});
