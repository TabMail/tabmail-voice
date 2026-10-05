// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { redactionReplyMaxBytes, redactionTextMaxBytes, textRedactionTimeout } from "../../core/config.js";
import { CancellationError } from "../../core/util/timeout.js";
import type { HelperClient } from "./helperClient.js";

export interface TextSourceEdges { startKnown: boolean; endKnown: boolean }

/** Explicitly authorized document text uses the same Rust engine as screen text.
 * A failure never returns the input, nor queues private text during a restart. */
export class NativeTextRedactor {
  constructor(private readonly helper: Pick<HelperClient, "request">) {}

  async redact(text: string, signal: AbortSignal, edges?: TextSourceEdges): Promise<string> {
    if (signal.aborted) throw new CancellationError();
    if (Buffer.byteLength(text, "utf8") > redactionTextMaxBytes) throw new Error("Document text exceeds the redaction limit.");
    return new Promise<string>((resolve, reject) => {
      const canceled = () => reject(new CancellationError());
      signal.addEventListener("abort", canceled, { once: true });
      // Deliberately omit the helper signal: signal-bearing requests may wait
      // across restarts. This read-only operation must refuse immediately there.
      // The caller still cancels promptly; the bounded native result is discarded.
      void this.helper.request<unknown>("redactText", { text, ...edges }, textRedactionTimeout).then((reply) => {
        if (signal.aborted) throw new CancellationError();
        if (typeof reply !== "object" || reply === null || !("text" in reply) || typeof reply.text !== "string"
          || Buffer.byteLength(reply.text, "utf8") > redactionReplyMaxBytes) throw new Error("Invalid redaction reply.");
        resolve(reply.text);
      }).catch((error: unknown) => {
        reject(error instanceof CancellationError ? error : new Error("Document text could not be safely redacted."));
      }).finally(() => signal.removeEventListener("abort", canceled));
    });
  }
}
