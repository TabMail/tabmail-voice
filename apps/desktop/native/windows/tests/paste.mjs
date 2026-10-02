// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
const fixture = spawn(process.argv[3], [], { stdio: ["pipe", "pipe", "pipe"] });
const helper = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
let id = 0, errors = "";
for (const child of [fixture, helper]) {
  child.stderr.on("data", (value) => { errors += value; });
  child.on("error", (error) => { throw error; });
  child.on("exit", (code) => { if (code !== null && code !== 0) throw new Error(`${child === fixture ? "Fixture" : "Helper"} exited ${code}; ${errors}`); });
}
const pending = new Map();
const helperLines = createInterface({ input: helper.stdout });
helperLines.on("line", (line) => {
  const reply = JSON.parse(line);
  const answer = pending.get(reply.id);
  assert.ok(answer, "each reply matches a request");
  pending.delete(reply.id); answer(reply);
});
const messages = [], readers = [];
const fixtureLines = createInterface({ input: fixture.stdout });
fixtureLines.on("line", (line) => {
  const reply = JSON.parse(line);
  if (readers.length) readers.shift()(reply); else messages.push(reply);
});
const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => readers.push(resolve));
function request(method, params = {}) {
  const requestID = ++id;
  const result = new Promise((resolve) => pending.set(requestID, resolve));
  helper.stdin.write(`${JSON.stringify({ id: requestID, method, params })}\n`);
  return { id: requestID, result };
}
async function command(value) {
  const deadline = Date.now() + 1000;
  while (true) {
    fixture.stdin.write(`${value}\n`);
    const reply = await next();
    assert.equal(reply.command ?? reply.mode, value);
    if (value !== "clipboard" || !reply.busy) return reply;
    assert.ok(Date.now() < deadline, "clipboard becomes readable within one second");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => { helper.kill(); fixture.kill(); process.exitCode = 1; }, 20_000);
try {
  const { window } = await next();
  const params = (extra = {}) => ({ window, text: "Synthetic inserted text", restoreDelay: 200, deadline: Date.now() + 2000, ...extra });
  await command("seed");
  const original = await command("clipboard");
  assert.deepEqual(original, {
    command: "clipboard", text: "Synthetic clipboard original",
    binary: "synthetic binary format", excluded: false,
  }, "seeded clipboard contains both formats before insertion");
  const pasted = await request("insert", params()).result;
  assert.equal(pasted.error, undefined, "native insertion succeeds");
  assert.equal((await command("value")).text, "Before Synthetic inserted text after.");
  assert.deepEqual(await command("clipboard"), original, "original text and registered binary formats restored");
  for (const mode of ["password", "readOnly", "button"]) {
    await command(mode);
    assert.ok((await request("insert", params()).result).error, `${mode} insertion refused`);
    assert.equal((await command("value")).text, "Before selected after.");
    assert.deepEqual(await command("clipboard"), original, "refusal preserves every seeded format");
  }
  await command("editable");
  for (const extra of [{ window: 0 }, { window: window + 1 }, { window: -1 }, { deadline: Date.now() - 1 }, { text: "" }, { text: "bad\0text" }]) {
    assert.ok((await request("insert", params(extra)).result).error, "invalid or stale request refused");
  }
  assert.equal((await command("value")).text, "Before selected after.");
  assert.deepEqual(await command("clipboard"), original);
  // Hold the clipboard so insertion cannot commit until cancellation has been received.
  await command("lock");
  const canceled = request("insert", params());
  helper.stdin.write(`${JSON.stringify({ method: "cancel", params: { id: canceled.id } })}\n`);
  await request("frontmostApp").result; // stdin barrier after the cancellation, before unlocking.
  await command("unlock");
  assert.ok((await canceled.result).error, "cancel before mutation refused");
  assert.equal((await command("value")).text, "Before selected after.");
  assert.deepEqual(await command("clipboard"), original);
  // The user's copy during the restore delay wins over our original snapshot.
  const changing = request("insert", params({ restoreDelay: 800 }));
  let active = null;
  for (let attempt = 0; attempt < 100; ++attempt) {
    const value = await command("clipboard");
    if (value.excluded) { active = value; break; }
    await pause(5);
  }
  assert.equal(active?.text, "Synthetic inserted text", "app clipboard content excludes history/cloud");
  // SendInput queues Ctrl+V; seeing the temporary clipboard does not mean the target consumed it.
  // Simulate a later user copy only after insertion, during the delayed restoration window.
  const inserted = "Before Synthetic inserted text after.";
  const consumedBy = Date.now() + 600;
  while ((await command("value")).text !== inserted) {
    assert.ok(Date.now() < consumedBy, "target consumes paste before the newer-copy scenario");
    await pause(5);
  }
  await command("copy");
  assert.equal((await changing.result).error, undefined);
  assert.equal((await command("clipboard")).text, "Synthetic newer copy", "newer copy preserved");
  assert.equal((await command("value")).text, "Before Synthetic inserted text after.");
  // A slow clipboard owner must not consume the separate restoration budget.
  // The target still has time to receive the paste before the insertion deadline.
  await command("editable");
  await command("delayed");
  const delayed = await request("insert", params({ restoreDelay: 800, deadline: Date.now() + 3000 })).result;
  assert.equal(delayed.error, undefined, "delayed rendering and restoration fit the insertion budget");
  assert.equal((await command("value")).text, "Before Synthetic inserted text after.");
  assert.equal((await command("clipboard")).text, "Synthetic delayed clipboard", "delayed original is restored");
  await command("editable");
  await command("delayed");
  const expired = await request("insert", params({ restoreDelay: 800, deadline: Date.now() + 2000 })).result;
  assert.ok(expired.error, "delayed rendering does not authorize insertion after its deadline");
  assert.equal((await command("value")).text, "Before selected after.", "expired request never sends input");
  assert.equal((await command("clipboard")).text, "Synthetic delayed clipboard", "expired request leaves original clipboard intact");
  assert.equal((await request("frontmostApp").result).result.window, window, "helper remains available after a refused late insertion");
  const exits = [once(fixture, "exit"), once(helper, "exit")];
  fixture.stdin.end(); helper.stdin.end();
  for (const exit of exits) assert.deepEqual(await exit, [0, null]);
  assert.equal(pending.size, 0); assert.equal(errors.replaceAll("\r\n", "\n").replace(/^debug paste stage: (focus-check|clipboard-open|clipboard-snapshot|final-focus-check|clipboard-write|send-input|clipboard-restore|complete)\n/gmu, ""), "", "only categorical insertion diagnostics are emitted");
  process.stdout.write("Windows insertion, clipboard formats, cancellation, privacy, refusal and newer-copy checks passed\n");
} finally {
  clearTimeout(timeout); helper.kill(); fixture.kill(); helperLines.close(); fixtureLines.close();
}
