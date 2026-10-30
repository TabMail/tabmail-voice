// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorName, log } from "../../core/log.js";
import { withTimeout } from "../../core/util/timeout.js";

/**
 * Deletes `path`, a file or a folder with everything in it. The one way a recording is deleted: one
 * already gone is fine and says nothing (`force`), since two cleanups can race over the same files;
 * any other failure is logged, never thrown or shown.
 */
export async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    log.error(`main: couldn't delete a recording: ${errorName(error)}`);
  }
}

/**
 * The audio of the dictations made in debug mode, for the debug menu's Play Last Recording, which
 * plays the newest (ADR-DESK-018). Each recording is its own file under a random name in `folder`,
 * the app's own per-user folder, created for this user alone, so none overwrites another. None
 * outlives debug mode or the app's run: `follow(false)` (debug mode off), `close` (quit) and `open`
 * (launch, for what a crash or a force-quit left) delete every file in the folder. A dictation that
 * started in debug mode keeps its audio only while debug mode stays on. Writes and deletes run in
 * order, so a recording being written as debug mode goes off is removed after it lands.
 */
export class LastRecording {
  private queue: Promise<void> = Promise.resolve();
  private on = false;
  private newest: string | null = null;

  constructor(readonly folder: string) {}

  /** At launch: deletes what an earlier run left in `folder`, and the file `earlierFile` earlier
   * versions kept the last recording in. */
  static open(folder: string, earlierFile: string): LastRecording {
    const recording = new LastRecording(folder);
    recording.clear();
    recording.queue = recording.queue.then(() => removeQuietly(earlierFile));
    return recording;
  }

  /** The newest recording this run kept, while it is on disk: none once the folder is emptied. */
  get path(): string | null {
    return this.newest !== null && existsSync(this.newest) ? this.newest : null;
  }

  /** Debug mode is on or off (`AppSettings.isDebugMode`); off deletes every recording. */
  follow(on: boolean): void {
    this.on = on;
    if (!on) this.clear();
  }

  /** Deletes every recording in the folder, after the writes and deletes before it. */
  clear(): void {
    this.queue = this.queue.then(() => removeQuietly(this.folder));
  }

  keep(wav: Uint8Array): void {
    if (!this.on) return;
    const path = join(this.folder, `${randomUUID()}.wav`);
    this.queue = this.queue
      .then(() => mkdir(this.folder, { recursive: true, mode: 0o700 }))
      .then(() => writeFile(path, wav, { flag: "wx", mode: 0o600 }))
      .then(() => {
        this.newest = path;
      })
      .catch((error: unknown) => {
        log.error(`main: couldn't keep the recording: ${errorName(error)}`);
      });
  }

  /** At quit: keeps nothing more and deletes every recording, waiting at most `timeout` ms so quitting
   * never hangs; what is left then goes at the next launch. */
  close(timeout: number): Promise<void> {
    this.follow(false);
    return withTimeout(timeout, () => this.flush()).catch((error: unknown) => {
      log.error(`main: the recordings weren't deleted at quit: ${errorName(error)}`);
    });
  }

  /** Resolves once every keep and delete so far is done. */
  flush(): Promise<void> {
    return this.queue;
  }
}
