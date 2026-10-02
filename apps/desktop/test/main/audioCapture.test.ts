// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "vitest";
import * as config from "../../src/core/config.js";
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
  /** With no retry unless given one: a failed start is the dictation's failure at once. */
  function capture(startTimeout = 5_000, retry = { window: 0, delay: 0 }): { microphone: SessionAudioCapture; sent: AudioCommand[] } {
    const sent: AudioCommand[] = [];
    return { microphone: new SessionAudioCapture((command) => sent.push(command), startTimeout, retry), sent };
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

  /** The input is briefly unavailable (it is changing, or the helper is starting afresh): a start
   * that fails is tried again after the retry delay, as a new session, and the dictation starts
   * with the one that succeeds, its completion run once. The failed session's late reports reach
   * nothing. */
  test("a failed start is tried again as a new session, and the dictation starts when one succeeds", async () => {
    const { microphone, sent } = capture(5_000, { window: 1_000, delay: 20 });
    const current = recording();
    let losses = 0;
    microphone.start(current.onChunk, current.completion, () => {
      losses += 1;
    });

    microphone.receive({ type: "failed", session: 1, error: "HelperError" });
    microphone.receive({ type: "failed", session: 1, error: "HelperError" });
    expect([sent, current.completions]).toEqual([[{ type: "start", session: 1 }], []]);
    await sleep(60);
    expect(sent).toEqual([{ type: "start", session: 1 }, { type: "start", session: 2 }]);

    microphone.receive({ type: "lost", session: 2 });
    await sleep(60);
    expect(sent.at(-1)).toEqual({ type: "start", session: 3 });
    microphone.receive({ type: "started", session: 2 });
    microphone.receive({ type: "chunk", session: 2, samples: new Float32Array(4) });
    expect([current.completions, current.chunks]).toEqual([[], []]);

    microphone.receive({ type: "started", session: 3 });
    microphone.receive({ type: "chunk", session: 3, samples: new Float32Array(4) });
    expect([current.completions, current.chunks.length, losses]).toEqual([[null], 1, 0]);
    microphone.stop();
    expect(sent.at(-1)).toEqual({ type: "stop", session: 3 });
    expect(sent).toHaveLength(4);
  });

  /** Tries stop at the end of the retry window: a start that still fails then is the dictation's
   * failure, with the last reason, once. */
  test("a start that still fails after the retry window fails the dictation, once", async () => {
    const { microphone, sent } = capture(5_000, { window: 50, delay: 20 });
    const current = recording();
    microphone.start(current.onChunk, current.completion, () => {});

    microphone.receive({ type: "failed", session: 1, error: "First" });
    await sleep(100);
    expect([sent.length, current.completions]).toEqual([2, []]);
    microphone.receive({ type: "failed", session: 2, error: "Last" });
    microphone.receive({ type: "failed", session: 2, error: "Last" });
    await sleep(60);

    expect(sent).toHaveLength(2);
    expect(current.completions).toHaveLength(1);
    expect((current.completions[0] as MicrophoneError).description).toBe("MicrophoneError(Last)");
  });

  /** A dictation stopped, or started over, while a try waits: that try is never made. */
  test("a start stopped while a try waits is not tried again", async () => {
    const { microphone, sent } = capture(5_000, { window: 1_000, delay: 20 });
    const first = recording();
    microphone.start(first.onChunk, first.completion, () => {});
    microphone.receive({ type: "failed", session: 1, error: "HelperError" });
    microphone.stop();
    await sleep(60);
    expect([sent, first.completions]).toEqual([[{ type: "start", session: 1 }, { type: "stop", session: 1 }], []]);

    const second = recording();
    microphone.start(second.onChunk, second.completion, () => {});
    microphone.receive({ type: "failed", session: 2, error: "HelperError" });
    const third = recording();
    microphone.start(third.onChunk, third.completion, () => {});
    await sleep(60);
    expect(sent.slice(2)).toEqual([{ type: "start", session: 2 }, { type: "start", session: 3 }]);
  });

  /** The dictation's one start timeout covers every try: tries that keep failing, or one that never
   * answers, end at it. */
  test("the start timeout covers every try", async () => {
    const { microphone, sent } = capture(80, { window: 1_000, delay: 20 });
    const current = recording();
    microphone.start(current.onChunk, current.completion, () => {});
    microphone.receive({ type: "failed", session: 1, error: "HelperError" });
    await sleep(40);
    expect(sent).toHaveLength(2);

    await sleep(100);
    microphone.receive({ type: "failed", session: 2, error: "HelperError" });
    await sleep(60);
    expect(sent).toHaveLength(2);
    expect(current.completions).toHaveLength(1);
    expect((current.completions[0] as MicrophoneError).description).toBe("MicrophoneError(timeout)");

    // A try still waiting when the timeout comes is never made.
    const waiting = capture(40, { window: 1_000, delay: 100 });
    const late = recording();
    waiting.microphone.start(late.onChunk, late.completion, () => {});
    waiting.microphone.receive({ type: "failed", session: 1, error: "HelperError" });
    await sleep(160);
    expect(waiting.sent).toEqual([{ type: "start", session: 1 }]);
    expect((late.completions[0] as MicrophoneError).description).toBe("MicrophoneError(timeout)");
  });

  /** The app's own retry settings: a couple of tries within about two seconds of key-down, inside
   * the start timeout. */
  test("the default retry makes several tries within the start timeout", () => {
    expect(config.microphoneStartRetryWindow / config.microphoneStartRetryDelay).toBeGreaterThanOrEqual(2);
    expect(config.microphoneStartRetryWindow).toBeLessThan(config.microphoneStartTimeout);
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
