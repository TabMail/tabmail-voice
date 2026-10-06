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
const methods = new Map();
function request(method, params = {}) {
  const requestID = ++id;
  methods.set(requestID, method);
  const result = new Promise((resolve) => pending.set(requestID, resolve));
  helper.stdin.write(`${JSON.stringify({ id: requestID, method, params })}\n`);
  return { id: requestID, result };
}
async function command(value) {
  const deadline = Date.now() + 1000;
  fixtureCommand = value;
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
let fixtureCommand = "window";
// Say what never answered, or a hung run fails without a word.
const timeout = setTimeout(() => {
  const stages = errors.match(/^debug paste stage: [a-z-]+$/gmu) ?? [];
  process.stderr.write(`paste test timed out waiting for ${pending.size ? `helper ${[...pending.keys()].map((key) => `${methods.get(key)} #${key}`).join(", ")}` : "no helper reply"}${readers.length ? `, fixture ${fixtureCommand}` : ""}; last paste stages: ${stages.slice(-4).join(" / ")}\n`);
  helper.kill(); fixture.kill(); process.exitCode = 1;
}, 20_000);
try {
  const { window } = await next();
  const params = (extra = {}) => ({ window, text: "Synthetic inserted text", deadline: Date.now() + 2000, ...extra });
  const pastedClipboard = { command: "clipboard", text: "Synthetic inserted text", binary: "", excluded: true };
  const until = async (label, expected) => {
    const by = Date.now() + 4000;
    let value;
    while ((value = (await command("value")).text) !== expected) {
      assert.ok(Date.now() < by, `${label} (field holds ${JSON.stringify(value)})`);
      await pause(20);
    }
  };
  await command("seed");
  const original = await command("clipboard");
  assert.deepEqual(original, {
    command: "clipboard", text: "Synthetic clipboard original",
    binary: "synthetic binary format", excluded: false,
  }, "seeded clipboard contains both formats before insertion");
  const pasted = await request("insert", params()).result;
  assert.equal(pasted.error, undefined, "native insertion succeeds");
  // The helper answers once the paste keys are sent; the field takes the paste when it handles them.
  await until("the text is pasted", "Before Synthetic inserted text after.");
  // The clipboard is written, never put back: the text stays, kept out of history and the cloud.
  assert.deepEqual(await command("clipboard"), pastedClipboard, "the text stays on the clipboard, marked private");
  for (const mode of ["password"]) {
    await command(mode);
    await command("seed");
    assert.ok((await request("insert", params()).result).error, `${mode} insertion refused`);
    assert.equal((await command("value")).text, "Before selected after.");
    assert.deepEqual(await command("clipboard"), original, "refusal leaves the clipboard alone");
  }
  for (const mode of ["readOnly", "button"]) {
    await command(mode);
    await command("seed");
    assert.equal((await request("insert", params()).result).error, undefined,
      `${mode} receives a normal paste command without editable-field eligibility`);
    assert.equal((await command("value")).text, "Before selected after.", "non-editable target ignores paste");
    assert.deepEqual(await command("clipboard"), pastedClipboard, "an ignored paste still leaves the text on the clipboard");
  }
  await command("editable");
  await command("seed");
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
  // An app that hands its clipboard over late (a busy app, a VM's clipboard agent) never holds the
  // paste up: the helper never asks it for anything.
  await command("delayed");
  const late = await request("insert", params()).result;
  assert.equal(late.error, undefined, "a late clipboard owner does not block insertion");
  await until("late clipboard owner: the text is pasted", "Before Synthetic inserted text after.");
  assert.equal((await command("asked")).helper, false, "the helper never reads the clipboard");
  assert.deepEqual(await command("clipboard"), pastedClipboard);
  // A clipboard another program holds open can't be written: nothing is sent.
  await command("editable");
  await command("seed");
  await command("lock");
  const held = await request("insert", params()).result;
  assert.ok(held.error, "a clipboard held open past the wait is refused");
  await command("unlock");
  assert.equal((await command("value")).text, "Before selected after.", "a refused paste sends nothing");
  assert.deepEqual(await command("clipboard"), original, "a held clipboard is never written");
  // A deadline that ends while the clipboard is held sends nothing, though it is then let go.
  await command("lock");
  const expired = request("insert", params({ deadline: Date.now() + 300 }));
  await pause(400);
  await command("unlock");
  assert.ok((await expired.result).error, "the clipboard wait does not authorize insertion after its deadline");
  assert.equal((await command("value")).text, "Before selected after.", "expired request never sends input");
  assert.deepEqual(await command("clipboard"), original, "expired request leaves the clipboard intact");
  assert.equal((await request("frontmostApp").result).result.window, window, "helper remains available after a refused late insertion");
  const exits = [once(fixture, "exit"), once(helper, "exit")];
  fixture.stdin.end(); helper.stdin.end();
  for (const exit of exits) assert.deepEqual(await exit, [0, null]);
  assert.equal(pending.size, 0); assert.equal(errors.replaceAll("\r\n", "\n").replace(/^debug paste stage: (focus-check|clipboard-open|final-focus-check|clipboard-write|send-input|complete)\n/gmu, ""), "", "only categorical insertion diagnostics are emitted");
  process.stdout.write("Windows insertion, write-only clipboard, cancellation, privacy and refusal checks passed\n");
} finally {
  clearTimeout(timeout); helper.kill(); fixture.kill(); helperLines.close(); fixtureLines.close();
}
