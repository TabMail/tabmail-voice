// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../core/config.js";
import { errorName, log } from "../../core/log.js";
import type { AudioCommand, AudioReport } from "../../shared/ipc.js";
import { type HelperClient, HelperError } from "./helperClient.js";

/** The shared audio protocol, which `voice-microphone` speaks on every platform. */
export class NativeMicrophone {
  constructor(private readonly helper: HelperClient, private readonly name: string) {}
  microphone(report: (report: AudioReport) => void): (command: AudioCommand) => void {
    this.helper.on("microphoneChunk", (message) => {
      const samples = decodeSamples(message.samples);
      if (Number.isInteger(message.session) && samples) report({ type: "chunk", session: message.session as number, samples });
    });
    return (command) => {
      switch (command.type) {
        case "prepare":
          this.helper.request("microphonePrepare").catch((error: unknown) => this.failed("prepared", error));
          return;
        case "start": {
          const { session } = command;
          this.helper.request("microphoneStart", { session, sampleRate: config.recordingSampleRate }, config.microphoneStartTimeout).then(
            () => report({ type: "started", session }),
            (error: unknown) => report({ type: "failed", session, error: errorName(error) }),
          );
          return;
        }
        case "stop":
          this.helper.request("microphoneStop", { session: command.session }).catch((error: unknown) => this.failed("stopped", error));
      }
    };
  }

  /** A prepare or stop that got no answer. One whose helper exited is no error: the helper ends
   * itself after each dictation's stop and whenever its capture ends, and the helper started in its
   * place is prepared again (its `onStart`), with the microphone off. */
  private failed(what: "prepared" | "stopped", error: unknown): void {
    const message = `${this.name}: microphone not ${what}: ${errorName(error)}`;
    if (error instanceof HelperError && error.kind === "exited") log.debug(message);
    else log.error(message);
  }

}

/** A chunk's samples as the helper sends them: base64 of little-endian 32-bit floats. Null when
 * malformed. */
export function decodeSamples(value: unknown): Float32Array | null {
  if (typeof value !== "string") return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
  // Its own copy: a Buffer is a view into a shared pool.
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}
