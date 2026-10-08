// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const directory = await mkdtemp(join(tmpdir(), "voice-linux-fixture-"));
const desktopFile = join(directory, "ai.tabmail.voice.fixture.desktop");
await writeFile(desktopFile, "[Desktop Entry]\nType=Application\nName=Synthetic fixture\nExec=python3\n");
let diagnostic = "";
const pending = new Map();
let id = 0;
function start(executable) {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => { diagnostic += chunk; });
  const replies = createInterface({ input: child.stdout });
  replies.on("line", (line) => {
    const reply = JSON.parse(line);
    assert.ok(pending.has(reply.id));
    pending.get(reply.id)(reply);
    pending.delete(reply.id);
  });
  return { child, replies };
}
const helper = start(process.argv[2]);
// The screen is read by voice-screen-reader and the focused field by voice-field-reader, programs of
// their own beside the helper.
const reader = start(join(dirname(process.argv[2]), "voice-screen-reader"));
const fieldReader = start(join(dirname(process.argv[2]), "voice-field-reader"));
function send(target, method, params) {
  const next = ++id;
  const reply = new Promise((resolve) => pending.set(next, resolve));
  target.child.stdin.write(`${JSON.stringify({ id: next, method, params })}\n`);
  return reply;
}
const request = (method, params = {}) => send(method === "readScreen" ? reader : method === "focusedFieldValue" ? fieldReader : helper, method, params);
// A field is read by the field reader's own token for the window in front: tokens are per process.
const fieldTarget = async () => (await send(fieldReader, "frontmostApp", {})).result.window;
const fixture = spawn("/usr/bin/python3", [process.argv[3]], {
  env: { ...process.env, GDK_BACKEND: "wayland", GIO_LAUNCHED_DESKTOP_FILE: desktopFile },
  stdio: ["pipe", "pipe", "pipe"],
});
const fixtureOutput = createInterface({ input: fixture.stdout });
let fixtureError = "";
fixture.stderr.on("data", (chunk) => { fixtureError += chunk; });
const timeout = setTimeout(() => { helper.child.kill(); reader.child.kill(); fieldReader.child.kill(); fixture.kill(); process.exitCode = 1; }, 25_000);
const policy = { excludedAppIDs: [], excludedHosts: [] };
async function command(value) {
  const done = once(fixtureOutput, "line");
  fixture.stdin.write(`${JSON.stringify(value)}\n`);
  assert.equal(JSON.parse((await done)[0]).done, value.kind);
  await delay(150); // Let the fixture's own accessibility events reach the helper.
}
async function context() {
  let lastKind = "none";
  for (let i = 0; i < 20; ++i) {
    const reply = await request("readScreen", policy);
    if (reply.result?.bundleID === "ai.tabmail.voice.fixture.desktop") return reply.result;
    lastKind = reply.error ? "error" : reply.result === null ? "refused" : "other app";
    await delay(100);
  }
  const target = await request("frontmostApp");
  throw new Error(`fixture context unavailable (${lastKind}, target=${Boolean(target.result)}); native diagnostics: ${diagnostic}`);
}
try {
  assert.equal(JSON.parse((await once(fixtureOutput, "line"))[0]).ready, true);
  assert.equal((await request("appInfo", { path: desktopFile })).result?.bundleIdentifier, "ai.tabmail.voice.fixture.desktop");
  let read = await context();
  assert.equal(read.appName, "Synthetic fixture");
  assert.equal(read.textBeforeCaret, "Synthetic field content");
  assert.ok(read.renderedText.includes("Synthetic visible heading"));
  assert.ok(!JSON.stringify(read).includes("synthetic-password-must-not-be-read"));
  const helperTarget = (await request("frontmostApp")).result.window;
  assert.ok(Number.isSafeInteger(helperTarget) && helperTarget > 0);
  const target = await fieldTarget();
  assert.ok(Number.isSafeInteger(target) && target > 0);
  assert.equal((await request("focusedFieldValue", { ...policy, window: target, maxLength: 20000 })).result.value, "Synthetic field content");
  // The shared core's bound: 1 to 20,000 UTF-16 units, a longer field sent as null.
  for (const maxLength of [0, 20001, undefined]) assert.ok((await request("focusedFieldValue", { ...policy, window: target, maxLength })).error);
  assert.equal((await request("focusedFieldValue", { ...policy, window: target, maxLength: 23 })).result.value, "Synthetic field content");
  assert.deepEqual((await request("focusedFieldValue", { ...policy, window: target, maxLength: 22 })).result, { value: null });
  assert.deepEqual((await request("readScreen", { ...policy, excludedAppIDs: ["AI.TABMAIL.VOICE.FIXTURE.DESKTOP"] })).result, { hidden: true });
  // The bound is checked before anything else, so an excluded app does not hide a bad request.
  assert.ok((await request("focusedFieldValue", { ...policy, excludedAppIDs: ["AI.TABMAIL.VOICE.FIXTURE.DESKTOP"], window: target, maxLength: 0 })).error);
  assert.ok((await request("readScreen", { excludedAppIDs: [] })).error);
  assert.equal((await request("readScreen", { ...policy, excludedHosts: Array(1001).fill("synthetic.example") })).result?.bundleID, "ai.tabmail.voice.fixture.desktop");
  await command({ kind: "select", from: 10, to: 15 });
  read = await context();
  assert.equal(read.selectedText, "field");
  assert.equal(read.selectionRedacted, false);
  await command({ kind: "password" });
  read = await context();
  assert.equal(read.textBeforeCaret, "");
  assert.equal(read.selectedText, "");
  assert.ok(!JSON.stringify(read).includes("synthetic-password-must-not-be-read"));
  const passwordTarget = await fieldTarget();
  assert.equal(passwordTarget, target, "changing fields keeps the original window target");
  assert.deepEqual((await request("focusedFieldValue", { ...policy, window: passwordTarget, maxLength: 20000 })).result, { value: null });
  await command({ kind: "entry", text: "password: syntheticvalue123" });
  read = await context();
  assert.equal(read.textBeforeCaret, "password: [redacted]");
  assert.ok(!JSON.stringify(read).includes("syntheticvalue123"));
  const redactedTarget = await fieldTarget();
  assert.equal((await request("focusedFieldValue", { ...policy, window: redactedTarget, maxLength: 20000 })).result.value, "password: [redacted]");
  // An emoji is two UTF-16 units: "a😀" fits in 3, not in 2.
  await command({ kind: "entry", text: "a😀" });
  await context();
  const emojiTarget = await fieldTarget();
  assert.equal((await request("focusedFieldValue", { ...policy, window: emojiTarget, maxLength: 3 })).result.value, "a😀");
  assert.deepEqual((await request("focusedFieldValue", { ...policy, window: emojiTarget, maxLength: 2 })).result, { value: null });
  // The main helper reads neither the screen nor the field, and each reader nothing else.
  assert.equal((await send(helper, "readScreen", policy)).error?.message, "native request failed", "the main helper reads no screen");
  assert.equal((await send(helper, "focusedFieldValue", { ...policy, window: helperTarget, maxLength: 20000 })).error?.message, "native request failed", "the main helper reads no field");
  for (const method of ["caretAnchor", "insert", "focusedFieldValue", "frontmostApp", "microphoneStart", "appInfo"])
    assert.equal((await send(reader, method, {})).error?.message, "native request failed", `the screen reader does no ${method}`);
  for (const method of ["caretAnchor", "insert", "readScreen", "microphoneStart", "appInfo"])
    assert.equal((await send(fieldReader, method, {})).error?.message, "native request failed", `the field reader does no ${method}`);
  const exits = [once(helper.child, "exit"), once(reader.child, "exit"), once(fieldReader.child, "exit")];
  helper.child.stdin.end(); reader.child.stdin.end(); fieldReader.child.stdin.end();
  for (const exit of exits) assert.deepEqual(await exit, [0, null], "EOF ends every process");
  process.stdout.write("native Wayland focus, selection, password exclusion and redacted screen context passed" + "\n");
} finally {
  clearTimeout(timeout);
  helper.child.stdin.end(); reader.child.stdin.end(); fieldReader.child.stdin.end(); fixture.stdin.end();
  helper.child.kill(); reader.child.kill(); fieldReader.child.kill(); fixture.kill();
  helper.replies.close(); reader.replies.close(); fieldReader.replies.close(); fixtureOutput.close();
  await rm(directory, { recursive: true, force: true });
  if (fixture.exitCode && fixtureError) process.stderr.write("synthetic fixture failed\n");
}
