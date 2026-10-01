// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../../core/config.js";
import { errorName, log } from "../../core/log.js";
import type { AudioCommand, AudioReport } from "../../shared/ipc.js";
import type { HelperClient } from "./helperClient.js";

/** The shared audio protocol; each platform helper owns its native microphone sessions. */
export class NativeMicrophone {
  constructor(private readonly helper: HelperClient, private readonly name: string) {}
  microphone(report: (report: AudioReport) => void): (command: AudioCommand) => void {
    this.helper.on("microphoneChunk", (message) => {
      const samples = decodeSamples(message.samples);
      if (Number.isInteger(message.session) && samples) report({ type: "chunk", session: message.session as number, samples });
    });
    this.helper.on("microphoneLost", (message) => {
      if (Number.isInteger(message.session)) report({ type: "lost", session: message.session as number });
    });
    return (command) => {
      switch (command.type) {
        case "prepare":
          this.helper.request("microphonePrepare").catch((error: unknown) => log.error(`${this.name}: microphone not prepared: ${errorName(error)}`));
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
          this.helper.request("microphoneStop", { session: command.session }).catch((error: unknown) => log.error(`${this.name}: microphone not stopped: ${errorName(error)}`));
      }
    };
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
