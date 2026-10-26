// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { NativeTargetWindow } from "./targetWindow.js";
import { CancellationError } from "../../core/util/timeout.js";
import * as config from "../../core/config.js";
import type { ScreenExclusions } from "../../core/dictation/excludedSites.js";
import type { ScreenRead } from "../../core/dictation/screenContext.js";
import { elapsed, errorName, log } from "../../core/log.js";
import { type HelperClient, HelperError } from "./helperClient.js";

/**
 * The screen read, in voice-screen-reader, a program of its own on every platform, so a slow read
 * never holds up a paste, the microphone or anything else the main helper does. A read has no time
 * limit of its own: a caller that stops waiting asks it to stop (`stop`), and it then answers with
 * what it has read so far (ADR-DESK-053). Reads are numbered, so a stop never reaches a later read.
 * One still going when the next starts is no longer wanted: its process is ended and started
 * afresh, as it is when a read is still going past `screenReaderTimeout`. A read takes what the
 * window shows, or with `wholeWindowOf` the whole window, on screen or not (ADR-DESK-016,
 * 2026-10-25), of the window that earlier read read: the helper reads it only while that window is
 * still the one in front, and answers null otherwise.
 */
export class ScreenReader {
  private reading: { read: Promise<ScreenRead | null>; number: number } | null = null;
  private reads = 0;
  /** Each read's number, by the promise `read` gave. */
  private readonly numbers = new WeakMap<Promise<ScreenRead | null>, number>();

  constructor(private readonly helper: HelperClient) {}

  /** End an obsolete read before capturing a target: a macOS target belongs to this reader
   * instance and must never be captured just before that instance is restarted. */
  async captureTarget(helper: HelperClient = this.helper): Promise<NativeTargetWindow | null> {
    if (this.reading) {
      this.helper.restart();
      this.reading = null;
    }
    return helper.request<NativeTargetWindow | null>("captureTarget");
  }

  async pasteTarget(target: NativeTargetWindow, transaction: number, deadline: number, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new CancellationError();
    const cancel = () => {
      void this.helper.request("cancelPaste", { target }).catch((error: unknown) => log.debug(`ScreenReader: paste cancellation failed (${errorName(error)})`));
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await this.helper.request("pasteTarget", { target, transaction, deadline }, config.helperRequestTimeout + config.insertionReplyGrace, signal);
    } finally { signal.removeEventListener("abort", cancel); }
  }

  private readonly targets = new WeakMap<Promise<ScreenRead | null>, Promise<NativeTargetWindow | null>>();

  read(exclusions: ScreenExclusions, wholeWindowOf?: Promise<ScreenRead | null>, target?: Promise<NativeTargetWindow | null>): Promise<ScreenRead | null> {
    const wholeWindow = wholeWindowOf !== undefined;
    const sameWindowAs = wholeWindowOf === undefined ? undefined : this.numbers.get(wholeWindowOf);
    if (wholeWindow && sameWindowAs === undefined) {
      log.debug("ScreenReader: the whole window of a read this reader did not make; not read");
      return Promise.resolve(null);
    }
    if (this.reading) {
      log.debug("ScreenReader: the last read is still going; restarting the reader");
      this.helper.restart();
    }
    const started = performance.now();
    this.reads += 1;
    const number = this.reads;
    const identity = wholeWindowOf === undefined ? target : this.targets.get(wholeWindowOf);
    const request = (target?: NativeTargetWindow | null) => target === null ? Promise.resolve(null) : this.helper.request<ScreenRead | null>("readScreen", { excludedAppIDs: exclusions.apps, excludedHosts: exclusions.sites, read: number, wholeWindow, ...(wholeWindow ? { sameWindowAs } : {}), ...(target === undefined ? {} : { target }) }, config.screenReaderTimeout);
    const read = identity === undefined ? request() : identity.then(request);
    if (identity) this.targets.set(read, identity);
    this.numbers.set(read, number);
    read.then(
      () => log.debug(() => `ScreenReader: read${wholeWindow ? " of the whole window" : ""} answered in ${elapsed(started)}`),
      (error: unknown) => log.debug(() => `ScreenReader: read${wholeWindow ? " of the whole window" : ""} failed (${errorName(error)}) after ${elapsed(started)}`),
    );
    this.reading = { read, number };
    const done = () => {
      if (this.reading?.read === read) this.reading = null;
    };
    read.then(done, (error: unknown) => {
      if (this.reading?.read === read && error instanceof HelperError && error.kind === "timeout") this.helper.restart();
      done();
    });
    return read;
  }

  /** Asks `read` to stop and answer with what it has read so far; nothing when it has answered or a
   * newer read has started. */
  stop(read: Promise<ScreenRead | null>): void {
    const reading = this.reading;
    if (reading?.read !== read) return;
    log.debug(`ScreenReader: asking read ${reading.number} to answer with what it has read so far`);
    this.helper.request("readScreenStop", { read: reading.number }).catch((error: unknown) => log.debug(() => `ScreenReader: stop failed (${errorName(error)})`));
  }
}
