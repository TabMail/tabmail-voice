// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AudioCapture } from "../core/audio.js";
import * as config from "../core/config.js";
import type { AudioCommand, AudioReport } from "../shared/ipc.js";

/** Why the microphone did not start; the message is for the log only. */
export class MicrophoneFailure extends Error {
  constructor(readonly reason: string) {
    super("Couldn't start the microphone.");
    this.name = "MicrophoneFailure";
  }

  get description(): string {
    return `MicrophoneFailure(${this.reason})`;
  }
}

/**
 * The microphone, driven by commands to whatever runs it: the macOS helper (`MacSystem.microphone`),
 * or elsewhere the hidden audio window (`getUserMedia` into an AudioWorklet at the recording rate).
 * Its reports, chunks included, come back to `receive`. Each `start` is a session; reports from an
 * earlier one are dropped. `stop` ends the session and releases the microphone (every dictation).
 */
export class SessionAudioCapture implements AudioCapture {
  private session = 0;
  private onChunk: ((samples: Float32Array) => void) | null = null;
  private completion: ((error: Error | null) => void) | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    /** Sends to what runs the microphone. */
    private readonly send: (command: AudioCommand) => void,
    private readonly startTimeout = config.microphoneStartTimeout,
  ) {}

  /** Does the microphone-off setup ahead of the first dictation (the helper's prepared engine, or
   * the audio window's worklet). */
  prepare(): void {
    this.send({ type: "prepare" });
  }

  start(onChunk: (samples: Float32Array) => void, completion: (error: Error | null) => void): void {
    this.session += 1;
    const session = this.session;
    this.onChunk = onChunk;
    this.completion = completion;
    this.startTimer = setTimeout(() => this.finishStart(session, new MicrophoneFailure("timeout")), this.startTimeout);
    this.send({ type: "start", session });
  }

  stop(): void {
    this.clearStartTimer();
    this.onChunk = null;
    this.completion = null;
    this.send({ type: "stop", session: this.session });
  }

  /** A report from the microphone. */
  receive(report: AudioReport): void {
    if (report.session !== this.session) return;
    switch (report.type) {
      case "started":
        return this.finishStart(report.session, null);
      case "failed":
        return this.finishStart(report.session, new MicrophoneFailure(report.error));
      case "chunk":
        this.onChunk?.(report.samples);
    }
  }

  private finishStart(session: number, error: Error | null): void {
    if (session !== this.session) return;
    this.clearStartTimer();
    const completion = this.completion;
    this.completion = null;
    completion?.(error);
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
  }
}
