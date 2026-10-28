// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStore, type StoreProblem } from "../../core/util/keyValueStore.js";
import { errorName, log } from "../../core/log.js";

/** The app's preferences in a JSON file under its data folder, written whole on every change (they
 * change rarely: a Settings switch, a tip shown, a dictation holding a dictionary word). A file not
 * there yet starts empty. One there that can't be read, for want of permission or because it is
 * damaged, is never written over or moved: the app runs on defaults, every save answers false, and
 * `problem` says why, for the menu to tell the user how to fix it (ADR-DESK-063). */
export class JSONFileStore extends MemoryStore {
  readonly problem: StoreProblem | undefined;

  constructor(private readonly path: string) {
    const contents = read(path);
    super("problem" in contents ? {} : contents.values);
    this.problem = "problem" in contents ? contents.problem : undefined;
  }

  override set(key: string, value: unknown): boolean {
    super.set(key, value);
    return this.save();
  }

  /** One write of the file, which replaces it whole: every value is in it, or none is. */
  override setAll(values: Readonly<Record<string, unknown>>): boolean {
    super.setAll(values);
    return this.save();
  }

  override remove(key: string): void {
    super.remove(key);
    this.save();
  }

  /** Whether the file was written: never one that couldn't be read. */
  private save(): boolean {
    if (this.problem !== undefined) return false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Written beside it, then moved over it: a crash mid-write never leaves half a file.
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.snapshot(), null, 2));
      renameSync(temporary, this.path);
      return true;
    } catch (error) {
      log.error(`FileStore: save failed: ${errorName(error)}`);
      return false;
    }
  }
}

/** The file's values, none when it isn't there yet; else why it can't be read. */
function read(path: string): { values: Record<string, unknown> } | { problem: StoreProblem } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { values: {} };
    log.error(`FileStore: couldn't read a preferences file (${code}); nothing is saved to it`);
    return { problem: { kind: code === "EACCES" || code === "EPERM" ? "permission" : "unreadable", path, code } };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return { values: value as Record<string, unknown> };
  } catch {
    // Falls through: not JSON is damaged too.
  }
  log.error("FileStore: a preferences file is damaged; nothing is saved to it");
  return { problem: { kind: "damaged", path, code: "invalid" } };
}

/** A file error's code (`ENOENT`, `EACCES`), else its name. */
function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : errorName(error);
}
