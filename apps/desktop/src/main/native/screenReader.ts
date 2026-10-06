// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../core/config.js";
import type { ScreenExclusions } from "../../core/dictation/excludedSites.js";
import type { ScreenRead } from "../../core/dictation/screenContext.js";
import { elapsed, errorName, log } from "../../core/log.js";
import { type HelperClient, HelperError } from "./helperClient.js";

/**
 * The screen read, in voice-screen-reader, a program of its own on every platform, so a slow read
 * never holds up a paste, the microphone or anything else the main helper does: it only comes too
 * late to be used. A read has no time limit of its own. One still going when the next
 * starts is no longer wanted: its process is ended and started afresh, as it is when a read is
 * still going past `screenReaderTimeout`.
 */
export class ScreenReader {
  private reading: Promise<ScreenRead | null> | null = null;

  constructor(private readonly helper: HelperClient) {}

  read(exclusions: ScreenExclusions): Promise<ScreenRead | null> {
    if (this.reading) {
      log.debug("ScreenReader: the last read is still going; restarting the reader");
      this.helper.restart();
    }
    const started = performance.now();
    const read = this.helper.request<ScreenRead | null>("readScreen", { excludedAppIDs: exclusions.apps, excludedHosts: exclusions.sites }, config.screenReaderTimeout);
    read.then(
      () => log.debug(() => `ScreenReader: read answered in ${elapsed(started)}`),
      (error: unknown) => log.debug(() => `ScreenReader: read failed (${errorName(error)}) after ${elapsed(started)}`),
    );
    this.reading = read;
    const done = () => {
      if (this.reading === read) this.reading = null;
    };
    read.then(done, (error: unknown) => {
      if (this.reading === read && error instanceof HelperError && error.kind === "timeout") this.helper.restart();
      done();
    });
    return read;
  }
}
