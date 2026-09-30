// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test, vi } from "vitest";
import type { AudioCommand, AudioReport } from "../../../src/shared/ipc.js";

vi.mock("../../../src/renderer/audio/captureWorklet.ts?worker&url", () => ({ default: "capture-worklet" }));

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
  await import("../../../src/renderer/audio/index.js");
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

/** The audio page across sessions: a worklet that fails to load the first time, a first microphone
 * granted only when the test says, and an audio context whose resume can be held. Each microphone is
 * numbered by its request, and the context's state is kept. */
async function sessionsPage(options: { failsFirstLoad?: boolean; holdsFirstMicrophone?: boolean; holdsResume?: boolean } = {}): Promise<{
  send(command: AudioCommand): void;
  events: string[];
  reports: AudioReport[];
  state(): string;
  grantFirstMicrophone(): void;
  resume(): void;
}> {
  const events: string[] = [];
  const reports: AudioReport[] = [];
  let listener: ((command: AudioCommand) => void) | null = null;
  let firstGrant!: (stream: unknown) => void;
  const firstMicrophone = new Promise<unknown>((resolve) => (firstGrant = resolve));
  let resumed!: () => void;
  const resuming = new Promise<void>((resolve) => (resumed = resolve));
  let contexts = 0;
  let microphones = 0;
  let state = "suspended";
  const stream = (n: number) => ({ getTracks: () => [{ stop: () => events.push(`microphone ${n} released`) }] });
  const node = () => ({ connect: <T>(next: T) => next, disconnect: () => {} });

  vi.stubGlobal(
    "AudioContext",
    class {
      readonly n = ++contexts;
      readonly destination = {};
      readonly audioWorklet = {
        addModule: async () => {
          if (options.failsFirstLoad && this.n === 1) throw new Error("unavailable");
        },
      };
      suspend = async () => {
        state = "suspended";
      };
      resume = async () => {
        events.push("resume");
        if (options.holdsResume) await resuming;
        state = "running";
      };
      createMediaStreamSource = node;
      createGain = () => ({ ...node(), gain: { value: 1 } });
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      readonly port = { onmessage: null, close: () => {} };
      connect = <T>(next: T) => next;
      disconnect = () => {};
    },
  );
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        const n = ++microphones;
        events.push(`microphone ${n} taken`);
        return options.holdsFirstMicrophone && n === 1 ? firstMicrophone : stream(n);
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
  await import("../../../src/renderer/audio/index.js");
  return {
    send: (command) => listener?.(command),
    events,
    reports,
    state: () => state,
    grantFirstMicrophone: () => firstGrant(stream(1)),
    resume: () => resumed(),
  };
}

describe("audio page across sessions", () => {
  /** A worklet that failed to load is loaded afresh by the next session, which then records. */
  test("a failed worklet load fails its session, and the next one loads it again and records", async () => {
    const page = await sessionsPage({ failsFirstLoad: true });

    page.send({ type: "start", session: 1 });
    await settle();
    expect(page.reports).toEqual([{ type: "failed", session: 1, error: "Error" }]);
    expect(page.events.filter((event) => event.startsWith("microphone"))).toEqual([]);

    page.send({ type: "start", session: 2 });
    await settle();
    expect(page.reports).toContainEqual({ type: "started", session: 2 });
    page.send({ type: "stop", session: 2 });
    expect(page.events).toContain("microphone 1 released");
  });

  /** A microphone granted late to a session already replaced is released, and leaves the session
   * recording now, and its audio context, alone. */
  test("an old session's late microphone is released without touching the new recording", async () => {
    const page = await sessionsPage({ holdsFirstMicrophone: true });

    page.send({ type: "start", session: 1 });
    await settle();
    page.send({ type: "start", session: 2 });
    await settle();
    expect(page.reports).toEqual([{ type: "started", session: 2 }]);
    expect(page.state()).toBe("running");
    page.grantFirstMicrophone();
    await settle();

    expect(page.events).toContain("microphone 1 released");
    expect(page.events).not.toContain("microphone 2 released");
    expect(page.state()).toBe("running");
    expect(page.reports).toEqual([{ type: "started", session: 2 }]);
    page.send({ type: "stop", session: 2 });
    expect(page.events).toContain("microphone 2 released");
  });

  /** Stopped before its microphone is granted, a session releases it as it comes, without waiting on
   * the audio context. */
  test("a stopped session's late microphone is released at once, with the context's resume held", async () => {
    const page = await sessionsPage({ holdsFirstMicrophone: true, holdsResume: true });

    page.send({ type: "start", session: 1 });
    await settle();
    page.send({ type: "stop", session: 1 });
    page.grantFirstMicrophone();
    await settle();
    const before = [...page.events];
    page.resume();
    await settle();

    expect(before).toContain("microphone 1 released");
    expect(before).not.toContain("resume");
    expect(page.reports).toEqual([]);
  });
});
