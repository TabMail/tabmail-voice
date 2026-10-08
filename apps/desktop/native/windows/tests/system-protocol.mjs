// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "voice-app-info-"));
const picked = join(temporary, "Synthetic 앱.EXE");
copyFileSync(process.argv[2], picked);
const invalidApp = join(temporary, "invalid.exe");
writeFileSync(invalidApp, "synthetic non-executable");
const pending = new Map();
let id = 0;
function start(executable) {
  const started = { child: spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] }), stderr: "" };
  started.child.stderr.on("data", (chunk) => { started.stderr += chunk; });
  started.child.on("error", (error) => { throw error; });
  started.lines = createInterface({ input: started.child.stdout });
  started.lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (typeof message.event === "string") return;
    const completion = pending.get(message.id);
    assert.ok(completion, "every reply matches its request");
    pending.delete(message.id);
    completion(message);
  });
  return started;
}
const helper = start(process.argv[2]);
const child = helper.child;
// The screen is read by voice-screen-reader.exe and the focused field by voice-field-reader.exe,
// programs of their own beside the helper.
const reader = start(join(dirname(process.argv[2]), "voice-screen-reader.exe"));
const fieldReader = start(join(dirname(process.argv[2]), "voice-field-reader.exe"));
function request(method, params = {}) {
  id += 1;
  const requestID = id;
  return new Promise((resolve) => {
    pending.set(requestID, resolve);
    (method === "readScreen" ? reader : method === "focusedFieldValue" ? fieldReader : helper).child.stdin.write(`${JSON.stringify({ id: requestID, method, params })}\n`);
  });
}
const timeout = setTimeout(() => {
  child.kill(); reader.child.kill(); fieldReader.child.kill();
  process.stderr.write("system protocol timed out\n");
  process.exitCode = 1;
}, 10_000);
try {
  child.stdin.write("not JSON\n[]\n{\"method\":\"configure\"}\n");
  fieldReader.child.stdin.write("not JSON\n[]\n{\"method\":\"focusedFieldValue\"}\n");
  assert.deepEqual((await request("appInfo", { path: picked })).result,
    { bundleIdentifier: "Synthetic 앱.EXE", name: "Synthetic 앱", path: picked }, "picked executable gets the same file identity used by screen exclusions");
  for (const path of [invalidApp, temporary, join(temporary, "missing.exe")]) {
    assert.equal((await request("appInfo", { path })).result, null, "non-app selection is refused without running it");
  }
  assert.ok((await request("appInfo", { path: 42 })).error);
  assert.deepEqual((await request("redactText", { text: "token=syntheticPrivate123" })).result, { text: "token=[redacted]" });
  assert.deepEqual((await request("redactText", { text: "" })).result, { text: "" });
  for (const [before, text, after, expected] of [
    ["token=", "syntheticPrivate123. Public.", "", "[redacted] Public."],
    ["", "Public. token=synthetic", "Private123 later.", "Public. token=[redacted]"],
    ["Earlier.", "会議は金曜日です。", "次のページ", "会議は金曜日です。"],
  ]) assert.deepEqual((await request("redactText", { before, text, after })).result, { text: expected });
  for (const params of [{}, { text: null }, { text: "😀".repeat(32769) }, { text: "Public.", before: null }]) {
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
  for (const window of [undefined, "not a window", -1, 1.5]) {
    assert.ok((await request("focusedFieldValue", { window, maxLength: 20_000, excludedAppIDs: [], excludedHosts: [] })).error, "a field read names its window");
  }
  const language = (await request("keyboardLanguage")).result;
  assert.ok(language.code === null || typeof language.code === "string");
  assert.equal(typeof (await request("fullUserName")).result.name, "string");
  // The microphone is voice-microphone.exe's, a process of its own.
  for (const [method, params] of [["microphonePrepare", {}], ["microphoneStart", { session: 1, sampleRate: 16000 }], ["microphoneStop", { session: 1 }]]) {
    assert.ok((await request(method, params)).error, `voice-windows does no ${method}`);
  }
  assert.ok((await request("unknown")).error);
  assert.ok((await request("insert", { text: "synthetic test" })).error, "unsupported paste fails closed");
  assert.equal(typeof (await request("fullUserName")).result.name, "string", "refusal leaves helper usable");
  const exits = [once(child, "exit"), once(reader.child, "exit"), once(fieldReader.child, "exit")];
  child.stdin.end(); reader.child.stdin.end(); fieldReader.child.stdin.end();
  for (const exit of exits) assert.deepEqual(await exit, [0, null], "EOF ends the helper");
  assert.equal(pending.size, 0);
  assert.equal(reader.stderr, "", "refused screen policies log nothing");
  assert.equal(fieldReader.stderr, "", "refused field policies log nothing");
  assert.equal(helper.stderr.replaceAll("\r\n", "\n"), "debug caret lookup: foreground-changed\ndebug caret lookup: provider-call-failed\n", "invalid caret requests log only fixed categories");
  process.stdout.write("system identity, refusal, malformed input, recovery and EOF checks passed\n");
} finally {
  clearTimeout(timeout);
  child.kill(); reader.child.kill(); fieldReader.child.kill();
  helper.lines.close(); reader.lines.close(); fieldReader.lines.close();
  rmSync(temporary, { recursive: true, force: true });
}
