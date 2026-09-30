// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import { sleep } from "../../src/core/util/timeout.js";
import { MicrophoneError, SessionAudioCapture } from "../../src/main/audioCapture.js";
import type { AudioCommand } from "../../src/shared/ipc.js";

/** One `start`: the chunks it was given and how it completed. */
function recording(): { chunks: Float32Array[]; completions: (Error | null)[]; onChunk: (samples: Float32Array) => void; completion: (error: Error | null) => void } {
  const chunks: Float32Array[] = [];
  const completions: (Error | null)[] = [];
  return { chunks, completions, onChunk: (samples) => chunks.push(samples), completion: (error) => completions.push(error) };
}

/** The microphone's sessions, with the microphone (the helper or the audio window) replaced by a list
 * of what it is sent. */
describe("SessionAudioCapture", () => {
  function capture(startTimeout = 5_000): { microphone: SessionAudioCapture; sent: AudioCommand[] } {
    const sent: AudioCommand[] = [];
    return { microphone: new SessionAudioCapture((command) => sent.push(command), startTimeout), sent };
  }

  test("each start is a session the window reports on", () => {
    const { microphone, sent } = capture();
    const first = recording();
    microphone.prepare();
    microphone.start(first.onChunk, first.completion, () => {});
    microphone.receive({ type: "started", session: 1 });
    microphone.receive({ type: "chunk", session: 1, samples: new Float32Array(4) });
    microphone.stop();

    expect(sent).toEqual([{ type: "prepare" }, { type: "start", session: 1 }, { type: "stop", session: 1 }]);
    expect(first.completions).toEqual([null]);
    expect(first.chunks).toHaveLength(1);
  });

  /** A late report from an earlier dictation never reaches the one after it: not its start, its
   * failure nor its audio. */
  test("reports from an earlier session are dropped", () => {
    const { microphone } = capture();
    const first = recording();
    const second = recording();
    microphone.start(first.onChunk, first.completion, () => {});
    microphone.stop();
    microphone.start(second.onChunk, second.completion, () => {});

    microphone.receive({ type: "failed", session: 1, error: "NotReadableError" });
    microphone.receive({ type: "started", session: 1 });
    microphone.receive({ type: "chunk", session: 1, samples: new Float32Array(4) });
    expect([first.completions, first.chunks, second.completions, second.chunks]).toEqual([[], [], [], []]);

    microphone.receive({ type: "started", session: 2 });
    microphone.receive({ type: "chunk", session: 2, samples: new Float32Array(4) });
    expect([second.completions, second.chunks.length]).toEqual([[null], 1]);
  });

  /** What ran the microphone is gone: a session that had started is told, once; one still
   * starting is not (its start fails instead), nor one already stopped. */
  test("a lost microphone is reported to its started session only", () => {
    const { microphone } = capture();
    let losses = 0;
    const onLost = () => {
      losses += 1;
    };
    const first = recording();
    microphone.start(first.onChunk, first.completion, onLost);
    microphone.lost();
    expect(losses).toBe(0);

    microphone.receive({ type: "started", session: 1 });
    microphone.lost();
    microphone.lost();
    expect(losses).toBe(1);

    const second = recording();
    microphone.stop();
    microphone.start(second.onChunk, second.completion, onLost);
    microphone.receive({ type: "started", session: 2 });
    microphone.stop();
    microphone.lost();
    expect(losses).toBe(1);
  });

  /** The microphone stopped by itself (its input's format changed): its started session is told
   * once, as when the helper exits; one still starting fails through its start; an earlier or a
   * stopped session's report reaches nothing. */
  test("a microphone lost mid-session is reported to that session only", () => {
    const { microphone } = capture();
    let losses = 0;
    const onLost = () => {
      losses += 1;
    };
    const first = recording();
    microphone.start(first.onChunk, first.completion, onLost);
    microphone.receive({ type: "started", session: 1 });
    microphone.receive({ type: "lost", session: 1 });
    microphone.receive({ type: "lost", session: 1 });
    expect([losses, first.completions]).toEqual([1, [null]]);

    const second = recording();
    microphone.stop();
    microphone.start(second.onChunk, second.completion, onLost);
    microphone.receive({ type: "lost", session: 1 });
    expect([losses, second.completions]).toEqual([1, []]);
    microphone.receive({ type: "lost", session: 2 });
    microphone.receive({ type: "started", session: 2 });
    expect(losses).toBe(1);
    expect(second.completions).toHaveLength(1);
    expect((second.completions[0] as MicrophoneError).description).toBe("MicrophoneError(lost)");

    const third = recording();
    microphone.start(third.onChunk, third.completion, onLost);
    microphone.receive({ type: "started", session: 3 });
    microphone.stop();
    microphone.receive({ type: "lost", session: 3 });
    expect(losses).toBe(1);
  });

  test("a microphone that fails to start says why, once", () => {
    const { microphone } = capture();
    const current = recording();
    microphone.start(current.onChunk, current.completion, () => {});

    microphone.receive({ type: "failed", session: 1, error: "NotAllowedError" });
    microphone.receive({ type: "started", session: 1 });

    expect(current.completions).toHaveLength(1);
    expect((current.completions[0] as MicrophoneError).description).toBe("MicrophoneError(NotAllowedError)");
  });

  /** A window that never answers fails the start at its timeout, and a start reported after that is
   * too late. */
  test("a start the window never reports fails at its timeout, once", async () => {
    const { microphone } = capture(50);
    const current = recording();
    microphone.start(current.onChunk, current.completion, () => {});

    await sleep(150);
    microphone.receive({ type: "started", session: 1 });

    expect(current.completions).toHaveLength(1);
    expect((current.completions[0] as MicrophoneError).description).toBe("MicrophoneError(timeout)");
  });

  /** Started again before the earlier start was reported: the earlier session's timeout doesn't fail
   * the newer start. */
  test("an earlier session's timeout leaves the next start alone", async () => {
    const { microphone } = capture(100);
    const first = recording();
    const second = recording();
    microphone.start(first.onChunk, first.completion, () => {});
    await sleep(50);
    microphone.start(second.onChunk, second.completion, () => {});

    await sleep(80);
    microphone.receive({ type: "started", session: 2 });

    expect(second.completions).toEqual([null]);
  });

  test("a stopped session delivers nothing more", async () => {
    const { microphone } = capture(50);
    const current = recording();
    microphone.start(current.onChunk, current.completion, () => {});
    microphone.stop();

    microphone.receive({ type: "chunk", session: 1, samples: new Float32Array(4) });
    microphone.receive({ type: "failed", session: 1, error: "NotReadableError" });
    microphone.receive({ type: "started", session: 1 });
    await sleep(150);

    expect([current.completions, current.chunks]).toEqual([[], []]);
  });
});
