// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test, vi } from "vitest";
import type { AudioCommand, AudioReport } from "../../src/shared/ipc.js";

vi.mock("../../src/renderer/captureWorklet.ts?worker&url", () => ({ default: "capture-worklet" }));

/** The audio window's page against a fake Web Audio and microphone: what it asks of the microphone
 * and reports back, in order. No real device is touched. */
async function audioPage(options: { holdsResume?: boolean } = {}): Promise<{
  send(command: AudioCommand): void;
  events: string[];
  reports: AudioReport[];
  loadWorklet(): void;
  grantMicrophone(): void;
  hear(samples: Float32Array): void;
  resume(): void;
}> {
  const events: string[] = [];
  const reports: AudioReport[] = [];
  let loaded!: () => void;
  const loading = new Promise<void>((resolve) => (loaded = resolve));
  let resumed!: () => void;
  const resuming = options.holdsResume ? new Promise<void>((resolve) => (resumed = resolve)) : Promise.resolve();
  let granted!: () => void;
  const granting = new Promise<void>((resolve) => (granted = resolve));
  let port: { onmessage: ((event: { data: Float32Array }) => void) | null } | null = null;
  let listener: ((command: AudioCommand) => void) | null = null;
  const node = () => ({ connect: <T>(next: T) => next, disconnect: () => events.push("disconnected") });

  vi.stubGlobal(
    "AudioContext",
    class {
      readonly audioWorklet = { addModule: () => loading };
      readonly destination = {};
      suspend = async () => {};
      resume = () => resuming;
      createMediaStreamSource = node;
      createGain = () => ({ ...node(), gain: { value: 1 } });
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      readonly port = { onmessage: null, close: () => events.push("port closed") };
      connect = <T>(next: T) => next;
      disconnect = () => {};
      constructor() {
        port = this.port;
      }
    },
  );
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        events.push("microphone taken");
        await granting;
        return { getTracks: () => [{ stop: () => events.push("microphone released") }] };
      },
    },
  });
  vi.stubGlobal("window", {
    voice: {
      onAudioCommand: (next: (command: AudioCommand) => void) => (listener = next),
      reportAudio: (report: AudioReport) => reports.push(report),
    },
  });
  vi.resetModules();
  await import("../../src/renderer/audio.js");
  return {
    send: (command) => listener?.(command),
    events,
    reports,
    loadWorklet: loaded,
    grantMicrophone: granted,
    hear: (samples) => port?.onmessage?.({ data: samples }),
    resume: () => resumed?.(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audio page", () => {
  test("a session started takes the microphone, reports its chunks, and releases it when stopped", async () => {
    const page = await audioPage();
    page.loadWorklet();
    page.grantMicrophone();

    page.send({ type: "start", session: 1 });
    await settle();
    expect(page.reports).toEqual([{ type: "started", session: 1 }]);
    page.hear(Float32Array.of(0.25, -0.5));
    page.send({ type: "stop", session: 1 });
    page.hear(Float32Array.of(1));

    expect(page.reports).toEqual([
      { type: "started", session: 1 },
      { type: "chunk", session: 1, samples: Float32Array.of(0.25, -0.5) },
    ]);
    expect(page.events.filter((event) => event.startsWith("microphone"))).toEqual(["microphone taken", "microphone released"]);
    expect(page.events).toContain("port closed");
  });

  /** Stopped while the worklet still loads (the first start after launch): the microphone is never
   * taken, not even briefly. */
  test("a session stopped while the worklet loads never takes the microphone", async () => {
    const page = await audioPage();
    page.grantMicrophone();

    page.send({ type: "start", session: 1 });
    page.send({ type: "stop", session: 1 });
    page.loadWorklet();
    await settle();

    expect(page.events).not.toContain("microphone taken");
    expect(page.reports).toEqual([]);
  });

  test("a session stopped while the audio context resumes releases the microphone and reports nothing", async () => {
    const page = await audioPage({ holdsResume: true });
    page.loadWorklet();
    page.grantMicrophone();

    page.send({ type: "start", session: 1 });
    await settle();
    page.send({ type: "stop", session: 1 });
    page.resume();
    await settle();

    expect(page.events.filter((event) => event.startsWith("microphone"))).toEqual(["microphone taken", "microphone released"]);
    expect(page.reports).toEqual([]);
  });

  test("a session stopped while the microphone is granted releases it as it comes", async () => {
    const page = await audioPage();
    page.loadWorklet();

    page.send({ type: "start", session: 1 });
    await settle();
    page.send({ type: "stop", session: 1 });
    page.grantMicrophone();
    await settle();

    expect(page.events.filter((event) => event.startsWith("microphone"))).toEqual(["microphone taken", "microphone released"]);
    expect(page.reports).toEqual([]);
  });
});
