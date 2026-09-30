// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import * as config from "../../../src/core/config.js";

type Processor = { process(inputs: Float32Array[][]): boolean };
type ProcessorClass = new (options: { processorOptions: { chunkFrames: number } }) => Processor;

/** The frames a worklet is handed per call (Web Audio's render quantum). */
const renderQuantum = 128;

/** The port the next processor gets, as the AudioWorkletGlobalScope hands one to each. */
let nextPort: { postMessage(message: unknown, transfer?: Transferable[]): void } | null = null;
let registered: ProcessorClass | null = null;

beforeAll(async () => {
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      readonly port = nextPort;
    },
  );
  vi.stubGlobal("registerProcessor", (name: string, processor: ProcessorClass) => {
    if (name === "capture") registered = processor;
  });
  // A worklet script, not a module: loaded for what it registers.
  const worklet = "../../../src/renderer/audio/captureWorklet.js";
  await import(/* @vite-ignore */ worklet);
});

afterEach(() => {
  nextPort = null;
});

/** Feeds `samples` to a new capture processor a render quantum at a time, through a real message
 * channel (whose transfers detach, as the browser's do), and returns every chunk the page gets. */
async function capture(samples: Float32Array): Promise<Float32Array[]> {
  const channel = new MessageChannel();
  const received: Float32Array[] = [];
  channel.port2.on("message", (chunk: Float32Array) => received.push(chunk));
  let posts = 0;
  const expected = Math.floor(samples.length / config.audioChunkFrames);
  nextPort = {
    postMessage(message, transfer) {
      // A processor stuck posting would never return: fail it instead.
      posts += 1;
      if (posts > expected) throw new Error(`posted ${posts} chunks for ${expected}`);
      channel.port1.postMessage(message, transfer as never);
    },
  };
  const Processor = registered;
  if (!Processor) throw new Error("no capture processor registered");
  const processor = new Processor({ processorOptions: { chunkFrames: config.audioChunkFrames } });
  for (let offset = 0; offset < samples.length; offset += renderQuantum) {
    expect(processor.process([[samples.subarray(offset, offset + renderQuantum)]])).toBe(true);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  channel.port1.close();
  return received;
}

describe("CaptureProcessor", () => {
  /** Every sample the microphone gives reaches the page once, in order, in chunks of
   * `audioChunkFrames`; what does not fill a chunk yet stays behind. */
  test("delivers the samples in order, chunk after chunk", async () => {
    const chunks = 3;
    const samples = Float32Array.from({ length: chunks * config.audioChunkFrames + renderQuantum }, (_, index) => ((index % 997) - 498) / 500);

    const received = await capture(samples);

    expect(received.map((chunk) => chunk.length)).toEqual(Array.from({ length: chunks }, () => config.audioChunkFrames));
    const joined = new Float32Array(received.reduce((total, chunk) => total + chunk.length, 0));
    received.reduce((offset, chunk) => (joined.set(chunk, offset), offset + chunk.length), 0);
    expect(joined).toEqual(samples.subarray(0, chunks * config.audioChunkFrames));
  });

  test("a call with no input posts nothing and keeps the processor running", () => {
    nextPort = {
      postMessage() {
        throw new Error("posted with no input");
      },
    };
    const Processor = registered;
    if (!Processor) throw new Error("no capture processor registered");
    expect(new Processor({ processorOptions: { chunkFrames: config.audioChunkFrames } }).process([[]])).toBe(true);
  });
});
