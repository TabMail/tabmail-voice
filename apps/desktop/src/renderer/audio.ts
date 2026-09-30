// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as config from "../core/config.js";
import type { AudioCommand, AudioReport } from "../shared/ipc.js";
import "./bridge.js";
import workletURL from "./captureWorklet.ts?worker&url";

/**
 * The microphone, in the hidden audio window (`SessionAudioCapture` in the main process drives it):
 * `getUserMedia` into an AudioWorklet in a context at the recording rate, so Chromium resamples,
 * and each chunk goes back to the main process. A session holds the microphone from `start` to
 * `stop` and no longer: it is released after every dictation.
 */

interface Session {
  id: number;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  node: AudioWorkletNode | null;
  stopped: boolean;
}

let context: AudioContext | null = null;
let ready: Promise<AudioContext> | null = null;
let current: Session | null = null;

function report(message: AudioReport): void {
  window.voice.reportAudio(message);
}

/** The audio context with the worklet loaded, made once. It outputs through a muted gain, so the
 * worklet is pulled without anything being heard. */
function prepare(): Promise<AudioContext> {
  ready ??= (async () => {
    const made = new AudioContext({ sampleRate: config.recordingSampleRate, latencyHint: "interactive" });
    await made.audioWorklet.addModule(workletURL);
    await made.suspend();
    context = made;
    return made;
  })().catch((error: unknown) => {
    // Tried afresh at the next start, which reports the failure for its session.
    ready = null;
    throw error;
  });
  return ready;
}

async function start(id: number): Promise<void> {
  stop();
  const session: Session = { id, stream: null, source: null, node: null, stopped: false };
  current = session;
  try {
    const audio = await prepare();
    if (session.stopped) return release(session);
    // The raw signal, as the Swift app's AVAudioEngine input gave it: no voice processing.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    session.stream = stream;
    if (session.stopped) return release(session);
    await audio.resume();
    if (session.stopped) return release(session);
    const source = audio.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audio, "capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, processorOptions: { chunkFrames: config.audioChunkFrames } });
    const mute = audio.createGain();
    mute.gain.value = 0;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!session.stopped) report({ type: "chunk", session: id, samples: event.data });
    };
    source.connect(node).connect(mute).connect(audio.destination);
    session.source = source;
    session.node = node;
    report({ type: "started", session: id });
  } catch (error) {
    release(session);
    report({ type: "failed", session: id, error: error instanceof Error ? error.name : typeof error });
  }
}

/** Ends the session in progress, releasing the microphone. */
function stop(): void {
  if (current) release(current);
  current = null;
}

function release(session: Session): void {
  session.stopped = true;
  session.node?.port.close();
  session.node?.disconnect();
  session.source?.disconnect();
  for (const track of session.stream?.getTracks() ?? []) track.stop();
  session.stream = null;
  if (current === session || current === null) void context?.suspend();
}

window.voice.onAudioCommand((command: AudioCommand) => {
  switch (command.type) {
    case "prepare":
      // A failure here is reported by the start that tries again.
      prepare().catch(() => {});
      return;
    case "start":
      void start(command.session);
      return;
    case "stop":
      if (current?.id === command.session) stop();
      return;
  }
});
