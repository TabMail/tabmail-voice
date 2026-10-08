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
 * microphone. The field read is of the app or window the reader finds in front as the watch starts,
 * by the reader's own identity of it (a process on macOS, a window on Windows, the reader's own window
 * token on Linux), so nothing passes between it and the main helper. A request still going when a
 * new watch starts is no longer wanted: the process is ended and started afresh, as it is when a
 * request is still going past `fieldReaderTimeout`.
 */
export class FieldReader implements FieldSource {
  private reading: Promise<unknown> | null = null;
  /** The target's name on the wire: `pid` on macOS, `window` elsewhere. */
  private readonly targetKey: "pid" | "window";

  constructor(private readonly helper: HelperClient, platform: NodeJS.Platform) {
    this.targetKey = platform === "darwin" ? "pid" : "window";
  }

  async target(): Promise<number | null> {
    if (this.reading) {
      log.debug("FieldReader: the last read is still going; restarting the reader");
      this.helper.restart();
    }
    const reply = await this.request<Record<string, unknown> | null>("frontmostApp", {});
    const target = reply?.[this.targetKey];
    return typeof target === "number" && Number.isSafeInteger(target) && target > 0 ? target : null;
  }

  async value(target: number, exclusions: ScreenExclusions): Promise<string | null> {
    const reply = await this.request<{ value?: unknown } | null>("focusedFieldValue", {
      [this.targetKey]: target,
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
