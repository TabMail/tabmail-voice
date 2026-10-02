// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const directory = await mkdtemp(join(tmpdir(), "voice-linux-fixture-"));
const desktopFile = join(directory, "ai.tabmail.voice.fixture.desktop");
await writeFile(desktopFile, "[Desktop Entry]\nType=Application\nName=Synthetic fixture\nExec=python3\n");
const helper = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
let diagnostic = "";
helper.stderr.on("data", (chunk) => { diagnostic += chunk; });
const replies = createInterface({ input: helper.stdout });
const pending = new Map();
let id = 0;
replies.on("line", (line) => {
  const reply = JSON.parse(line);
  assert.ok(pending.has(reply.id));
  pending.get(reply.id)(reply);
  pending.delete(reply.id);
});
function request(method, params = {}) {
  const next = ++id;
  const reply = new Promise((resolve) => pending.set(next, resolve));
  helper.stdin.write(`${JSON.stringify({ id: next, method, params })}\n`);
  return reply;
}
const fixture = spawn("/usr/bin/python3", [process.argv[3]], {
  env: { ...process.env, GDK_BACKEND: "wayland", GIO_LAUNCHED_DESKTOP_FILE: desktopFile },
  stdio: ["pipe", "pipe", "pipe"],
});
const fixtureOutput = createInterface({ input: fixture.stdout });
let fixtureError = "";
fixture.stderr.on("data", (chunk) => { fixtureError += chunk; });
const timeout = setTimeout(() => { helper.kill(); fixture.kill(); process.exitCode = 1; }, 25_000);
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
  const target = (await request("frontmostApp")).result.window;
  assert.ok(Number.isSafeInteger(target) && target > 0);
  assert.equal((await request("focusedFieldValue", { ...policy, window: target, maxLength: 20000 })).result.value, "Synthetic field content");
  assert.deepEqual((await request("readScreen", { ...policy, excludedAppIDs: ["AI.TABMAIL.VOICE.FIXTURE.DESKTOP"] })).result, { hidden: true });
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
  const passwordTarget = (await request("frontmostApp")).result.window;
  assert.equal(passwordTarget, target, "changing fields keeps the original window target");
  assert.deepEqual((await request("focusedFieldValue", { ...policy, window: passwordTarget, maxLength: 20000 })).result, { value: null });
  await command({ kind: "entry", text: "password: syntheticvalue123" });
  read = await context();
  assert.equal(read.textBeforeCaret, "password: [redacted]");
  assert.ok(!JSON.stringify(read).includes("syntheticvalue123"));
  const redactedTarget = (await request("frontmostApp")).result.window;
  assert.equal((await request("focusedFieldValue", { ...policy, window: redactedTarget, maxLength: 20000 })).result.value, "password: [redacted]");
  process.stdout.write("native Wayland focus, selection, password exclusion and redacted screen context passed" + "\n");
} finally {
  clearTimeout(timeout);
  helper.stdin.end(); fixture.stdin.end();
  helper.kill(); fixture.kill();
  replies.close(); fixtureOutput.close();
  await rm(directory, { recursive: true, force: true });
  if (fixture.exitCode && fixtureError) process.stderr.write("synthetic fixture failed\n");
}
