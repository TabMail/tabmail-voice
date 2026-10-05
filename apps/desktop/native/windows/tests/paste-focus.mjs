// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

function client(executable, args = []) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [], waiters = [];
  let errors = "";
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (waiters.length) waiters.shift()(value); else messages.push(value);
  });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.on("error", (error) => { throw error; });
  return { child, lines, errors: () => errors,
    next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve)) };
}
const helper = client(process.argv[2]);
const fixture = client(process.argv[3], ["paste-focus"]);
const timeout = setTimeout(() => { helper.child.kill(); fixture.child.kill(); process.exit(1); }, 15_000);
let id = 0;
function request(method, params = {}) {
  const current = ++id;
  helper.child.stdin.write(`${JSON.stringify({ id: current, method, params })}\n`);
  return helper.next().then((reply) => { assert.equal(reply.id, current); return reply; });
}
async function command(value) {
  fixture.child.stdin.write(`${value}\n`);
  return fixture.next();
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const { window } = await fixture.next();
  assert.deepEqual((await request("frontmostApp")).result, { window });
  await command("seed");
  const initial = await command("stats");
  assert.equal(initial.focus, 1);
  assert.equal(initial.firstEmpty && initial.secondEmpty && initial.clipboardOriginal, true);
  const params = () => ({ window, text: "Synthetic focus paste", deadline: Date.now() + 2500 });
  assert.equal((await request("insert", params())).error, undefined, "stable logical focus accepts paste without editable patterns");
  const stable = await command("stats");
  assert.equal(stable.firstExact && stable.secondEmpty && stable.clipboardPasted, true, "positive control delivers exact text, which stays on the clipboard");

  // A held clipboard: the paste waits to open it. Focus moves during that wait, and the check
  // after it refuses before the clipboard is written.
  await command("seed");
  await command("lock");
  const offset = helper.errors().length;
  const pending = request("insert", params());
  const deadline = Date.now() + 1000;
  while (!helper.errors().slice(offset).includes("paste stage: clipboard-open")) {
    assert.ok(Date.now() < deadline, "initial UIA identity is captured before changing focus");
    await pause(5);
  }
  const moved = await command("switch");
  assert.equal(moved.focus, 2);
  assert.equal(moved.nativeFocus, initial.nativeFocus, "logical focus changes within the same native focus HWND");
  await command("unlock");
  const result = await pending;
  const after = await command("stats");
  assert.ok(result.error, `changed UIA identity refuses the old insertion: ${JSON.stringify(after)}`);
  assert.equal(after.firstExact && after.secondEmpty && after.clipboardOriginal, true,
    "neither recipient nor clipboard changes after focus moves");
  assert.deepEqual((await request("frontmostApp")).result, { window }, "top-level window remains unchanged");
  process.stdout.write("Same-HWND UIA focus refusal, recipients and clipboard checks passed\n");
} finally {
  clearTimeout(timeout);
  const exits = Promise.all([helper, fixture].map(({ child }) => child.exitCode === null ? once(child, "exit") : Promise.resolve()));
  const cleanup = setTimeout(() => { helper.child.kill(); fixture.child.kill(); }, 2000);
  helper.child.stdin.end(); fixture.child.stdin.end();
  await exits;
  clearTimeout(cleanup);
  helper.lines.close(); fixture.lines.close();
}
