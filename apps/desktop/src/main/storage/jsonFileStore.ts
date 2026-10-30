// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as config from "../../core/config.js";
import { MemoryStore, type StoreProblem } from "../../core/util/keyValueStore.js";
import { errorName, log } from "../../core/log.js";

/** The app's preferences in a JSON file under its data folder, written whole on every change (they
 * change rarely: a Settings switch, a tip shown, a dictation holding a dictionary word). A file not
 * there yet starts empty. One there that can't be read, for want of permission or because it is
 * damaged, is never written over or moved on the app's own: the app runs on defaults, every save
 * answers false, and `problem` says why, for the menu to tell the user how to fix it, by hand or with
 * the user's factory reset (`moveAside`; ADR-DESK-063). */
export class JSONFileStore extends MemoryStore {
  private currentProblem: StoreProblem | undefined;
  /** No file was there at launch: the store started empty, at the defaults. */
  readonly isNew: boolean;

  constructor(private readonly path: string) {
    const contents = read(path);
    super("problem" in contents ? {} : contents.values);
    this.currentProblem = "problem" in contents ? contents.problem : undefined;
    this.isNew = "isNew" in contents;
    // A file read is the user's alone from now on (root ADR-035), whatever it was written with before.
    // One that couldn't be read is left as it is, for the user to fix.
    if (!("problem" in contents) && !this.isNew) restrict(path, config.privateFileMode);
  }

  get problem(): StoreProblem | undefined {
    return this.currentProblem;
  }

  /** The user's factory reset of a file that couldn't be read (owner, 2026-10-27): the file is moved
   * to `aside`, never deleted, and the store starts afresh at the defaults, written to a new file from
   * its next change. Throws, changing nothing, when there is no problem, `aside` is taken, or the file
   * can't be moved. */
  moveAside(aside: string): void {
    if (this.currentProblem === undefined) throw new Error("FileStore: only a file that couldn't be read is reset");
    if (existsSync(aside)) throw new Error("FileStore: the reset copy's name is taken");
    renameSync(this.path, aside);
    this.values.clear();
    this.currentProblem = undefined;
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
    if (this.currentProblem !== undefined) return false;
    try {
      // The folders it makes, and the file, are the user's alone (root ADR-035).
      mkdirSync(dirname(this.path), { recursive: true, mode: config.privateFolderMode });
      // Written beside it, then moved over it: a crash mid-write never leaves half a file.
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.snapshot(), null, 2), { mode: config.privateFileMode });
      // A temporary file left by a crash keeps its permissions through the write: set again.
      chmodSync(temporary, config.privateFileMode);
      renameSync(temporary, this.path);
      return true;
    } catch (error) {
      log.error(`FileStore: save failed: ${errorName(error)}`);
      return false;
    }
  }
}

/** Root ADR-035: the app's data folder is the user's alone, set on every platform rather than left to the
 * system's defaults (some Linux distributions make a home's folders readable by everyone). */
export function restrictDataFolder(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: config.privateFolderMode });
  } catch (error) {
    log.error(`FileStore: the data folder couldn't be made (${errorCode(error)})`);
    return;
  }
  restrict(path, config.privateFolderMode);
}

function restrict(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    log.error(`FileStore: permissions not set (${errorCode(error)})`);
  }
}

/** The file's values, none when it isn't there yet; else why it can't be read. */
function read(path: string): { values: Record<string, unknown>; isNew?: true } | { problem: StoreProblem } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { values: {}, isNew: true };
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
