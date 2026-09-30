// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Something whose state others watch: listeners hear of every change, and stop with the function
 * `observe` returns. */
export class Observable {
  private readonly listeners = new Set<() => void>();

  observe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
