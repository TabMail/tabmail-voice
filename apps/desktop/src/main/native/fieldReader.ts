// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../core/config.js";
import type { ScreenExclusions } from "../../core/dictation/excludedSites.js";
import type { FieldSource } from "../../core/dictionary/correctionWatch.js";
import { elapsed, errorName, log } from "../../core/log.js";
import { type HelperClient, HelperError } from "./helperClient.js";

/**
 * The focused field's read for correction learning (`CorrectionWatch`, ADR-DESK-038), in
 * voice-field-reader, a program of its own on every platform beside voice-screen-reader
 * (ADR-DESK-053), so a slow read (a terminal's viewport) never holds up a paste, the caret or the
 * microphone. The field read is of the paste's own target, the app or window the main helper named at
 * key-down and the paste was checked against, never of what the reader finds in front after the paste
 * (a window switched to in that moment may show the same words and teach a false correction). The two
 * programs name it by an identity both share: the process on macOS and Linux (`pid`; a Linux window
 * token is each process's own, so the main helper's token is mapped to its window's process by
 * `identity`), the window's handle on Windows (`window`). A read still going when the next is asked is
 * no longer wanted (reads within one watch come one after another, so it is a superseded watch's): the
 * process is ended and started afresh, as it is when a request is still going past
 * `fieldReaderTimeout`.
 */
export class FieldReader implements FieldSource {
  private reading: Promise<unknown> | null = null;
  /** The target's name on the wire: `window` on Windows, `pid` elsewhere. */
  private readonly targetKey: "pid" | "window";

  constructor(
    private readonly helper: HelperClient,
    platform: NodeJS.Platform,
    /** The reader's identity of the paste's target (the main helper's `frontmostApp` at key-down), or
     * null for none: itself on macOS and Windows, its window's process on Linux. */
    private readonly identity: (target: number) => number | null,
  ) {
    this.targetKey = platform === "win32" ? "window" : "pid";
  }

  async value(target: number, exclusions: ScreenExclusions): Promise<string | null> {
    if (this.reading) {
      log.debug("FieldReader: the last read is still going; restarting the reader");
      this.helper.restart();
    }
    const own = this.identity(target);
    if (own === null) {
      log.debug("FieldReader: the target has no identity the reader shares; nothing read");
      return null;
    }
    const reply = await this.request<{ value?: unknown } | null>("focusedFieldValue", {
      [this.targetKey]: own,
      maxLength: config.correctionMaxFieldLength,
      excludedAppIDs: exclusions.apps,
      excludedHosts: exclusions.sites,
    });
    return typeof reply?.value === "string" && reply.value.length <= config.correctionMaxFieldLength ? reply.value : null;
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const started = performance.now();
    const request = this.helper.request<T>(method, params, config.fieldReaderTimeout);
    this.reading = request;
    const done = () => {
      if (this.reading === request) this.reading = null;
    };
    request.then(
      () => {
        log.debug(() => `FieldReader: ${method} answered in ${elapsed(started)}`);
        done();
      },
      (error: unknown) => {
        log.debug(() => `FieldReader: ${method} failed (${errorName(error)}) after ${elapsed(started)}`);
        if (this.reading === request && error instanceof HelperError && error.kind === "timeout") this.helper.restart();
        done();
      },
    );
    return request;
  }
}
