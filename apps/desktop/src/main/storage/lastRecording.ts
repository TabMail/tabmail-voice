// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { errorName, log } from "../../core/log.js";

/**
 * The latest dictation's audio, kept for the debug menu's Play Last Recording while debug mode is on
 * (ADR-DESK-018). Writes and the delete run in order, so a recording still being written when debug
 * mode goes off is removed after it lands, never left behind.
 */
export class LastRecording {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  get exists(): boolean {
    return existsSync(this.path);
  }

  keep(wav: Uint8Array): void {
    this.queue = this.queue.then(() => writeFile(this.path, wav)).catch((error: unknown) => {
      log.error(`main: couldn't keep the last recording: ${errorName(error)}`);
    });
  }

  /** Deletes the kept recording, if any: debug mode went off. */
  discard(): void {
    this.queue = this.queue.then(() => rm(this.path, { force: true })).catch((error: unknown) => {
      log.error(`main: couldn't delete the last recording: ${errorName(error)}`);
    });
  }

  /** Resolves once every keep and discard so far is done. */
  flush(): Promise<void> {
    return this.queue;
  }
}
