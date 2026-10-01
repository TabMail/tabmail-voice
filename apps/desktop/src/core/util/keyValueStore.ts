// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The app's preferences, as UserDefaults holds them on macOS: JSON values under string keys. The
 * main process keeps them in a JSON file under the app's data folder. */
export interface KeyValueStore {
  get(key: string): unknown;
  /** False when the value could not be kept past this run (the file could not be written): it is
   * held until the app quits. */
  set(key: string, value: unknown): boolean;
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
