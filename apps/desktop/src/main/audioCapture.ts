// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AudioCapture } from "../core/audio/recorder.js";
import * as config from "../core/config.js";
import { log } from "../core/log.js";
import type { AudioCommand, AudioReport } from "../shared/ipc.js";

/** Why the microphone did not start; the message is for the log only. */
export class MicrophoneError extends Error {
  constructor(readonly reason: string) {
    super("Couldn't start the microphone.");
    this.name = "MicrophoneError";
  }

  get description(): string {
    return `MicrophoneError(${this.reason})`;
  }
}

/**
 * The microphone, driven by commands to whatever runs it: a native helper (`NativeMicrophone`), or
 * elsewhere the hidden audio window (`getUserMedia` into an AudioWorklet at the recording rate).
 * Its reports, chunks included, come back to `receive`. Each try of a `start` is a session; reports
 * from an earlier one are dropped. `stop` ends the session and releases the microphone (every
 * dictation).
 *
 * A start that fails within `retry.window` of being asked is tried again after `retry.delay`, as a
 * new session (what runs the microphone has ended the failed one): the input can be briefly
 * unavailable while it changes. The dictation's one `startTimeout` covers every try.
 */
export class SessionAudioCapture implements AudioCapture {
  private session = 0;
  private onChunk: ((samples: Float32Array) => void) | null = null;
  private completion: ((error: Error | null) => void) | null = null;
  private onLost: (() => void) | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the start being made stops being tried again. */
  private retryUntil = 0;

  constructor(
    /** Sends to what runs the microphone. */
    private readonly send: (command: AudioCommand) => void,
    private readonly startTimeout = config.microphoneStartTimeout,
    private readonly retry = { window: config.microphoneStartRetryWindow, delay: config.microphoneStartRetryDelay },
  ) {}

  /** Does the microphone-off setup ahead of the first dictation (the helper's prepared engine, or
   * the audio window's worklet). */
  prepare(): void {
    this.send({ type: "prepare" });
  }

  start(onChunk: (samples: Float32Array) => void, completion: (error: Error | null) => void, onLost: () => void): void {
    this.clearTimers();
    this.onChunk = onChunk;
    this.completion = completion;
    this.onLost = onLost;
    this.retryUntil = Date.now() + this.retry.window;
    this.startTimer = setTimeout(() => this.finishStart(new MicrophoneError("timeout")), this.startTimeout);
    this.startSession();
  }

  stop(): void {
    this.clearTimers();
    this.onChunk = null;
    this.completion = null;
    this.onLost = null;
    this.send({ type: "stop", session: this.session });
  }

  /** What ran the microphone is gone (the helper exited). A session that had started is told
   * once; one still starting fails through its start instead. */
  lost(): void {
    const onLost = this.onLost;
    if (this.completion !== null || onLost === null) return;
    this.onLost = null;
    onLost();
  }

  /** A report from the microphone. */
  receive(report: AudioReport): void {
    if (report.session !== this.session) return;
    switch (report.type) {
      case "started":
        // Not after this session was lost: the next try is on its way.
        if (this.retryTimer === null) this.finishStart(null);
        return;
      case "failed":
        return this.startFailed(new MicrophoneError(report.error));
      case "chunk":
        this.onChunk?.(report.samples);
        return;
    }
  }

  private startSession(): void {
    this.session += 1;
    this.send({ type: "start", session: this.session });
  }

  /** The session being started failed: another is tried while the start may still be retried. */
  private startFailed(error: MicrophoneError): void {
    if (this.completion === null || this.retryTimer !== null) return;
    if (Date.now() >= this.retryUntil) return this.finishStart(error);
    log.debug(`microphone: start failed (${error.reason}); trying again`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startSession();
    }, this.retry.delay);
  }

  private finishStart(error: Error | null): void {
    this.clearTimers();
    const completion = this.completion;
    this.completion = null;
    completion?.(error);
  }

  private clearTimers(): void {
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.startTimer = null;
    this.retryTimer = null;
  }
}
