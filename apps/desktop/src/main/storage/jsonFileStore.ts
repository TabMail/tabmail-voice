// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStore } from "../../core/util/keyValueStore.js";
import { errorName, log } from "../../core/log.js";

/** The app's preferences in a JSON file under its data folder, written whole on every change (they
 * change rarely: a Settings switch, a tip shown, a dictation holding a dictionary word). An unreadable
 * file starts empty. */
export class JSONFileStore extends MemoryStore {
  constructor(private readonly path: string) {
    super(read(path));
  }

  override set(key: string, value: unknown): boolean {
    super.set(key, value);
    return this.save();
  }

  override remove(key: string): void {
    super.remove(key);
    this.save();
  }

  /** Whether the file was written. */
  private save(): boolean {
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

function read(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through: an unreadable file is an empty one.
  }
  log.error("FileStore: unreadable preferences file; starting empty");
  return {};
}
