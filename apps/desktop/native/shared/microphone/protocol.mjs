// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// voice-microphone's wire on Windows and Linux, run against the built helper: it refuses malformed
// requests and goes on, ends itself with the restart code once its one capture is over (its session
// stopped, its start failed, a newer start came), and EOF ends it at once. Run directly:
// `node protocol.mjs <voice-microphone> [--capture]`; `--capture` requires a working default input
// (Linux's test gives it a synthetic one), which a machine without one can't give.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/** The exit code voice-microphone ends itself with, as the shared core's header defines it. */
export const restartExitCode = Number(/VoiceMicrophoneRestartExitCode = (\d+)/.exec(readFileSync(new URL("../rust/include/voice_core.h", import.meta.url), "utf8"))?.[1]);

function start(executable, env) {
  const child = spawn(executable, [], { env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const chunks = [];
  let id = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event) {
      assert.equal(message.event, "microphoneChunk", "the only event is a chunk");
      chunks.push(message);
      return;
    }
    assert.ok(pending.has(message.id), "every reply matches its request");
    pending.get(message.id)(message);
    pending.delete(message.id);
  });
  // `close` comes after the last stdout line, so every reply and chunk sent before the exit is read.
  const closed = once(child, "close");
  return {
    child, chunks, closed,
    stderr: () => stderr.replaceAll("\r\n", "\n"),
    request(method, params = {}) {
      const next = ++id;
      const reply = new Promise((resolve) => pending.set(next, resolve));
      child.stdin.write(`${JSON.stringify({ id: next, method, params })}\n`);
      return reply;
    },
    lines,
  };
}

/** Runs every check; returns the samples heard for the captured session (none without `capture`). */
export async function microphoneProtocol(executable, { env, capture = false } = {}) {
  assert.ok(Number.isInteger(restartExitCode) && restartExitCode > 0, "the core header names the restart code");
  const helpers = [];
  const timeout = setTimeout(() => {
    for (const helper of helpers) helper.child.kill();
    process.stderr.write("voice-microphone protocol timed out\n");
    process.exitCode = 1;
  }, 20_000);
  try {
    // Malformed requests are refused and the helper goes on; a stop of a session that never ran
    // changes nothing; EOF ends it with 0.
    const idle = start(executable, env);
    helpers.push(idle);
    idle.child.stdin.write("not JSON\n[]\n{\"method\":\"microphoneStart\"}\n");
    for (const params of [{}, { session: 0 }, { session: -1 }, { session: "1" }, { session: 1.5 }]) {
      assert.ok((await idle.request("microphoneStop", params)).error, `a stop needs a positive session: ${JSON.stringify(params)}`);
      assert.ok((await idle.request("microphoneStart", { ...params, sampleRate: 16000 })).error, `a start needs a positive session: ${JSON.stringify(params)}`);
    }
    for (const sampleRate of [undefined, 0, -1, 7999, 192001, "16000", 16000.5]) {
      assert.ok((await idle.request("microphoneStart", { session: 1, sampleRate })).error, `a start needs a recording rate: ${sampleRate}`);
    }
    assert.ok((await idle.request("readScreen")).error, "voice-microphone does nothing but the microphone");
    assert.ok((await idle.request("caretAnchor")).error, "voice-microphone does nothing but the microphone");
    assert.deepEqual((await idle.request("microphoneStop", { session: 5 })).result, {}, "a stop before its start is no error");
    // Session 5 was stopped before it started: its late start does not run, and the helper goes on.
    assert.deepEqual((await idle.request("microphoneStart", { session: 5, sampleRate: 16000 })).result, {}, "a start already stopped is skipped");
    idle.child.stdin.end();
    assert.deepEqual(await idle.closed, [0, null], "EOF ends an idle helper");
    assert.equal(idle.chunks.length, 0, "nothing is heard before a start");

    // One capture per process: the session's stop, or its failed start, ends it with the restart code.
    const once1 = start(executable, env);
    helpers.push(once1);
    const prepared = await once1.request("microphonePrepare");
    const started = await once1.request("microphoneStart", { session: 1, sampleRate: 16000 });
    if (capture) {
      assert.deepEqual(prepared.result, {}, "a working input is prepared");
      assert.deepEqual(started.result, {}, "a working input starts");
      for (const by = Date.now() + 3000; once1.chunks.length < 10 && Date.now() < by;) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(once1.chunks.length >= 10, "a running capture sends chunks");
      assert.deepEqual((await once1.request("microphoneStop", { session: 1 })).result, {}, "its stop is answered before it ends");
    } else if (started.error) {
      // No input on this machine: the failed start ends the process, after its reply.
    } else {
      assert.deepEqual((await once1.request("microphoneStop", { session: 1 })).result, {}, "its stop is answered before it ends");
    }
    assert.deepEqual(await once1.closed, [restartExitCode, null], "the capture over, the helper ends itself to be started afresh");
    const samples = [];
    for (const chunk of once1.chunks) {
      assert.equal(chunk.session, 1, "chunks name their session");
      const bytes = Buffer.from(chunk.samples, "base64");
      assert.equal(bytes.length % 4, 0, "chunks are 32-bit floats");
      for (let i = 0; i < bytes.length; i += 4) samples.push(bytes.readFloatLE(i));
    }
    assert.ok(samples.every(Number.isFinite), "every sample is a number");

    if (capture) {
      // A newer start before the running session's stop gets no second capture: it is refused, and
      // the process ends so the app's retry starts it in a fresh one.
      const twice = start(executable, env);
      helpers.push(twice);
      assert.deepEqual((await twice.request("microphoneStart", { session: 2, sampleRate: 16000 })).result, {});
      assert.ok((await twice.request("microphoneStart", { session: 3, sampleRate: 16000 })).error, "a second capture is refused");
      assert.deepEqual(await twice.closed, [restartExitCode, null], "a newer start ends the process");
      assert.ok(twice.chunks.every((chunk) => chunk.session === 2), "no chunk is sent for the refused session");
    }
    for (const helper of helpers) {
      assert.ok(helper.stderr().split("\n").filter(Boolean).every((line) => /^debug microphone: (ending, to be started afresh|capture lost; ending)$/u.test(line)), "only fixed debug lines are logged");
    }
    return samples;
  } finally {
    clearTimeout(timeout);
    for (const helper of helpers) { helper.child.kill(); helper.lines.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2], "pass the voice-microphone executable");
  await microphoneProtocol(process.argv[2], { capture: process.argv.includes("--capture") });
  process.stdout.write("voice-microphone validation, one capture per process, restart exit and EOF checks passed\n");
}
