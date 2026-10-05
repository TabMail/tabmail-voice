// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "voice-app-info-"));
const picked = join(temporary, "Synthetic 앱.EXE");
copyFileSync(process.argv[2], picked);
const invalidApp = join(temporary, "invalid.exe");
writeFileSync(invalidApp, "synthetic non-executable");
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
  process.stderr.write("system protocol timed out\n");
  process.exitCode = 1;
}, 10_000);
try {
  child.stdin.write("not JSON\n[]\n{\"method\":\"configure\"}\n");
  assert.deepEqual((await request("appInfo", { path: picked })).result,
    { bundleIdentifier: "Synthetic 앱.EXE", name: "Synthetic 앱", path: picked }, "picked executable gets the same file identity used by screen exclusions");
  for (const path of [invalidApp, temporary, join(temporary, "missing.exe")]) {
    assert.equal((await request("appInfo", { path })).result, null, "non-app selection is refused without running it");
  }
  assert.ok((await request("appInfo", { path: 42 })).error);
  assert.deepEqual((await request("redactText", { text: "token=syntheticPrivate123" })).result, { text: "token=[redacted]", withheld: false });
  assert.deepEqual((await request("redactText", { text: "" })).result, { text: "", withheld: false });
  for (const [text, startKnown, endKnown, expected, withheld] of [
    ["syntheticPrivate123. Public.", false, true, ". Public.", true],
    ["Public. syntheticPrivate123", true, false, "Public. ", true],
    ["syntheticPrivate123", false, false, "", true],
    ["Public. Visible.", true, true, "Public. Visible.", false],
  ]) assert.deepEqual((await request("redactText", { text, startKnown, endKnown })).result, { text: expected, withheld });
  for (const params of [{}, { text: null }, { text: "😀".repeat(32769) }, { text: "Public.", startKnown: null }]) {
    assert.ok((await request("redactText", params)).error, "invalid explicit text redaction refuses");
  }
  const front = (await request("frontmostApp")).result;
  assert.ok(front === null || (Number.isSafeInteger(front.window) && front.window > 0));
  assert.deepEqual((await request("caretAnchor", { window: 0 })).result, null);
  assert.ok((await request("caretAnchor", { window: "not a window" })).error);
  for (const policy of [{}, { excludedAppIDs: [] }, { excludedHosts: [] }, { excludedAppIDs: null, excludedHosts: [] }, { excludedAppIDs: "app.exe", excludedHosts: [] }, { excludedAppIDs: ["app.exe", 2], excludedHosts: [] }, { excludedAppIDs: [], excludedHosts: ["example.com", 2] }]) {
    assert.ok((await request("readScreen", policy)).error, "screen policy must be explicit and entirely valid");
    assert.ok((await request("focusedFieldValue", { window: 0, maxLength: 20_000, ...policy })).error, "field policy must be explicit and entirely valid");
  }
  const language = (await request("keyboardLanguage")).result;
  assert.ok(language.code === null || typeof language.code === "string");
  assert.equal(typeof (await request("fullUserName")).result.name, "string");
  for (const params of [{}, { session: 0 }, { session: -1 }, { session: "1" }]) {
    assert.ok((await request("microphoneStop", params)).error);
  }
  for (const sampleRate of [0, -1, 192001, "16000"]) {
    assert.ok((await request("microphoneStart", { session: 1, sampleRate })).error);
  }
  assert.deepEqual((await request("microphoneStop", { session: 1 })).result, {});
  assert.ok((await request("unknown")).error);
  assert.ok((await request("insert", { text: "synthetic test" })).error, "unsupported paste fails closed");
  assert.equal(typeof (await request("fullUserName")).result.name, "string", "refusal leaves helper usable");
  const exit = once(child, "exit");
  child.stdin.end();
  assert.deepEqual(await exit, [0, null], "EOF ends the helper");
  assert.equal(pending.size, 0);
  assert.equal(stderr.replaceAll("\r\n", "\n"), "debug caret lookup: foreground-changed\ndebug caret lookup: provider-call-failed\n", "invalid caret requests log only fixed categories");
  process.stdout.write("system identity, refusal, malformed input, recovery and EOF checks passed\n");
} finally {
  clearTimeout(timeout);
  child.kill();
  lines.close();
  rmSync(temporary, { recursive: true, force: true });
}
