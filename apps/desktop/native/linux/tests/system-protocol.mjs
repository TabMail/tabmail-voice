// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let id = 0;
let diagnostic = "";
child.stderr.on("data", (chunk) => { diagnostic += chunk; });
lines.on("line", (line) => {
  const reply = JSON.parse(line);
  assert.ok(!reply.event, "voice-linux sends no microphone events");
  assert.ok(pending.has(reply.id));
  pending.get(reply.id)(reply);
  pending.delete(reply.id);
});
function request(method, params = {}) {
  const next = ++id;
  const reply = new Promise((resolve) => pending.set(next, resolve));
  child.stdin.write(`${JSON.stringify({ id: next, method, params })}\n`);
  return reply;
}
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 12_000);
try {
  assert.ok((await request("missingMethod")).error);
  assert.equal(typeof (await request("fullUserName")).result.name, "string");
  assert.equal((await request("appInfo", { path: "/synthetic/not-installed.desktop" })).result, null);
  assert.ok((await request("appInfo", { path: "/synthetic/not-desktop" })).error);
  // The microphone is voice-microphone's, a process of its own.
  for (const [method, params] of [["microphonePrepare", {}], ["microphoneStart", { session: 1, sampleRate: 16000 }], ["microphoneStop", { session: 1 }]]) {
    assert.ok((await request(method, params)).error, `voice-linux does no ${method}`);
  }
  const closed = once(child, "close");
  child.stdin.end();
  assert.deepEqual(await closed, [0, null]);
  assert.ok(diagnostic.split("\n").filter(Boolean).every((line) => /^debug accessibility: (bridge activation unavailable|initial focus unavailable|foreground has no focused element|foreground lookup unavailable)$/u.test(line)), "only bounded, content-free accessibility diagnostics are emitted");
  process.stdout.write("native Linux service validation, microphone refusal and EOF shutdown passed" + "\n");
} finally { clearTimeout(timeout); child.kill(); lines.close(); }
