// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Runs in the AudioWorkletGlobalScope, whose globals the DOM library does not declare.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
}
declare function registerProcessor(name: string, processor: new (options: { processorOptions: { chunkFrames: number } }) => AudioWorkletProcessor): void;

/** Collects the microphone's mono samples, at the context's rate, into chunks of `chunkFrames` and
 * posts each to the page (OpenWhispr's approach: a worklet, never the deprecated
 * ScriptProcessorNode). */
class CaptureProcessor extends AudioWorkletProcessor {
  private chunk: Float32Array;
  private filled = 0;

  constructor(options: { processorOptions: { chunkFrames: number } }) {
    super(options);
    this.chunk = new Float32Array(options.processorOptions.chunkFrames);
  }

  process(inputs: Float32Array[][]): boolean {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(samples.length - offset, this.chunk.length - this.filled);
      this.chunk.set(samples.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.chunk.length) {
        this.port.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(this.chunk.length);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
