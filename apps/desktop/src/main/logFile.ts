// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { LogLevel } from "../core/log.js";

/**
 * Debug builds, and a packaged build while debug mode is on (`isDebugLogging`), keep their log in a
 * file, so a session can be read after the fact: on macOS
 * `~/Library/Logs/TabMail Voice/TabMail Voice.log`. Past `maxBytes` it becomes `TabMail Voice.1.log`
 * and a new one starts. Lines are written in order, off the caller's path.
 */
export class LogFile {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly maxBytes: number,
  ) {}

  append(level: LogLevel, text: string): void {
    const line = `${timestamp(new Date())} ${level} ${text}\n`;
    this.queue = this.queue.then(() => LogFile.write(line, this.path, this.maxBytes)).catch(() => {});
  }

  /** Resolves once every line appended so far is written. */
  flush(): Promise<void> {
    return this.queue;
  }

  /** Appends `line` to the file at `path`, first moving a file past `maxBytes` aside. */
  static async write(line: string, path: string, maxBytes: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const size = await stat(path).then((stats) => stats.size, () => null);
    if (size !== null && size > maxBytes) {
      const earlier = LogFile.previousPath(path);
      await rm(earlier, { force: true });
      await rename(path, earlier);
    }
    await appendFile(path, line);
  }

  /** Where a full log file is moved: "TabMail Voice.log" → "TabMail Voice.1.log". */
  static previousPath(path: string): string {
    const extension = extname(path);
    return `${path.slice(0, path.length - extension.length)}.1${extension}`;
  }
}

/** ISO 8601 in local time with its offset and milliseconds, as the Swift app's log wrote it. */
function timestamp(date: Date): string {
  const pad = (value: number, length = 2) => String(Math.abs(value)).padStart(length, "0");
  const offset = -date.getTimezoneOffset();
  const zone = offset === 0 ? "Z" : `${offset > 0 ? "+" : "-"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${zone}`;
}
