// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
// A window of its own that it clicks with injected input (tests/mouse-fixture.cpp).
const fixture = spawn(process.argv[3], [], { stdio: ["pipe", "pipe", "inherit"] });
const fixtureReplies = [];
const fixtureLines = createInterface({ input: fixture.stdout });
fixtureLines.on("line", (line) => fixtureReplies.shift()?.(JSON.parse(line)));
const fixtureReady = new Promise((resolve) => fixtureReplies.push(resolve));
function press() {
  return new Promise((resolve) => {
    fixtureReplies.push(resolve);
    fixture.stdin.write("press\n");
  });
}
const pending = new Map();
const events = [];
let id = 0;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("error", (error) => { throw error; });
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.event === "string") {
    events.push(message.event);
    return;
  }
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
  fixture.kill();
  process.stderr.write("hotkey protocol timed out\n");
  process.exitCode = 1;
}, 10_000);
try {
  child.stdin.write("not JSON\n[]\n{\"method\":\"configure\"}\n");
  const configured = await request("configure", { hotkey: "rightControl", tapMaxDuration: 0.2, doubleTapWindow: 0.3 });
  assert.deepEqual(configured.result, { installed: true });
  // A click anywhere is told only while the chat window is open. Its hook runs before the click
  // reaches the window, and the helper writes in order, so a reply after the click comes after
  // anything the click told.
  assert.deepEqual(await fixtureReady, { ready: true });
  const clicks = () => events.filter((event) => event === "chatMouseDown").length;
  assert.deepEqual(await press(), { pressed: true });
  await request("dictationEnded");
  assert.equal(clicks(), 0, "a click told before the chat window opened");
  assert.deepEqual((await request("setChatOpen", { isOpen: true })).result, {});
  assert.deepEqual(await press(), { pressed: true });
  await request("dictationEnded");
  assert.equal(clicks(), 1, "a click while the chat window is open told once");
  assert.deepEqual((await request("setChatOpen", { isOpen: false })).result, {});
  assert.deepEqual(await press(), { pressed: true });
  await request("dictationEnded");
  assert.equal(clicks(), 1, "a click told after the chat window closed");
  fixture.stdin.end();
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
  process.stdout.write("hotkey request, chat click, refusal, malformed input, recovery and EOF checks passed\n");
} finally {
  clearTimeout(timeout);
  child.kill();
  fixture.kill();
  lines.close();
  fixtureLines.close();
}
