// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Why a store's file, there at launch, couldn't be read: no permission to read it, damaged (not a JSON
 * object), or another read error. Nothing is saved to it while the app runs, unless the user resets it
 * (`fileProblems.ts` says what the user can do). */
export interface StoreProblem {
  kind: "permission" | "damaged" | "unreadable";
  path: string;
  /** The read error's code (`EACCES`, `EIO`), or `invalid` for a damaged file. */
  code: string;
}

/** The app's preferences, as UserDefaults holds them on macOS: JSON values under string keys. The
 * main process keeps them in a JSON file under the app's data folder. */
export interface KeyValueStore {
  /** Set when the store's file was there but couldn't be read: every save answers false. */
  readonly problem?: StoreProblem;
  get(key: string): unknown;
  /** False when the value could not be kept past this run (the file could not be written): it is
   * held until the app quits. */
  set(key: string, value: unknown): boolean;
  /** Sets every key in `values` at once (`undefined` removes one), kept or lost together: false, as
   * for `set`, when none of them could be kept past this run. */
  setAll(values: Readonly<Record<string, unknown>>): boolean;
  remove(key: string): void;
}

/** Held in memory only: tests, and the base of the file-backed store. */
export class MemoryStore implements KeyValueStore {
  protected readonly values: Map<string, unknown>;

  constructor(values: Record<string, unknown> = {}) {
    this.values = new Map(Object.entries(values));
  }

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown): boolean {
    this.values.set(key, value);
    return true;
  }

  setAll(values: Readonly<Record<string, unknown>>): boolean {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) this.values.delete(key);
      else this.values.set(key, value);
    }
    return true;
  }

  remove(key: string): void {
    this.values.delete(key);
  }

  /** Everything stored, for writing out. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }
}

export function storedString(store: KeyValueStore, key: string): string | null {
  const value = store.get(key);
  return typeof value === "string" ? value : null;
}

export function storedBool(store: KeyValueStore, key: string): boolean | null {
  const value = store.get(key);
  return typeof value === "boolean" ? value : null;
}

export function storedInteger(store: KeyValueStore, key: string): number | null {
  const value = store.get(key);
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
