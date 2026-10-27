// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { errorName, log } from "../../core/log.js";

/**
 * The latest dictation's audio, kept for the debug menu's Play Last Recording while debug mode is on
 * (ADR-DESK-018). `follow(on)` mirrors debug mode: off, the file is deleted and a recording still
 * being made is not kept when it finishes (a dictation that started in debug mode keeps its audio
 * only while debug mode stays on). Writes and the delete run in order, so a recording being written
 * as debug mode goes off is removed after it lands. The file is created for this user alone and
 * never over an existing file or symlink: the temporary folder is shared on Linux.
 */
export class LastRecording {
  private queue: Promise<void> = Promise.resolve();
  private on = false;

  constructor(readonly path: string) {}

  get exists(): boolean {
    return existsSync(this.path);
  }

  /** Debug mode is on or off (`AppSettings.isDebugMode`); off deletes the kept recording, if any. */
  follow(on: boolean): void {
    this.on = on;
    if (on) return;
    this.queue = this.queue.then(() => rm(this.path, { force: true })).catch((error: unknown) => {
      log.error(`main: couldn't delete the last recording: ${errorName(error)}`);
    });
  }

  keep(wav: Uint8Array): void {
    if (!this.on) return;
    this.queue = this.queue
      .then(() => rm(this.path, { force: true }))
      .then(() => writeFile(this.path, wav, { flag: "wx", mode: 0o600 }))
      .catch((error: unknown) => {
        log.error(`main: couldn't keep the last recording: ${errorName(error)}`);
      });
  }

  /** Resolves once every keep and delete so far is done. */
  flush(): Promise<void> {
    return this.queue;
  }
}
