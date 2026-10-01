// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let id = 0;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("error", (error) => { throw error; });
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.event === "string") return;
  const completion = pending.get(message.id);
  assert.ok(completion, "every reply matches its request");
  pending.delete(message.id);
  completion(message);
});
function request(method, params = {}) {
  id += 1;
  const requestID = id;
  return new Promise((resolve) => {
    pending.set(requestID, resolve);
    child.stdin.write(`${JSON.stringify({ id: requestID, method, params })}\n`);
  });
}
const timeout = setTimeout(() => {
  child.kill();
  process.stderr.write("hotkey protocol timed out\n");
  process.exitCode = 1;
}, 10_000);
try {
  child.stdin.write("not JSON\n[]\n{\"method\":\"configure\"}\n");
  const configured = await request("configure", { hotkey: "rightControl", tapMaxDuration: 0.2, doubleTapWindow: 0.3 });
  assert.deepEqual(configured.result, { installed: true });
  assert.deepEqual((await request("setChatOpen", { isOpen: true })).result, {});
  assert.deepEqual((await request("setChatOpen", { isOpen: false })).result, {});
  assert.deepEqual((await request("dictationEnded")).result, {});
  assert.deepEqual((await request("configure", { hotkey: "rightAlt", tapMaxDuration: 0.2, doubleTapWindow: 0.3 })).result, { installed: true });
  assert.ok((await request("configure", { hotkey: "function", tapMaxDuration: 0.2, doubleTapWindow: 0.3 })).error);
  assert.ok((await request("configure", { hotkey: "rightControl", tapMaxDuration: -1, doubleTapWindow: 0.3 })).error);
  assert.ok((await request("setChatOpen", { isOpen: "yes" })).error);
  assert.ok((await request("unknown")).error);
  assert.deepEqual((await request("configure", { hotkey: "rightControl", tapMaxDuration: 0.2, doubleTapWindow: 0.3 })).result, { installed: true });
  const exit = once(child, "exit");
  child.stdin.end();
  assert.deepEqual(await exit, [0, null], "EOF ends the helper");
  assert.equal(pending.size, 0);
  assert.equal(stderr, "", "protocol writes no private diagnostics");
  process.stdout.write("hotkey request, refusal, malformed input, recovery and EOF checks passed\n");
} finally {
  clearTimeout(timeout);
  child.kill();
  lines.close();
}
