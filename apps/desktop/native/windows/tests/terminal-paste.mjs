// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Run in a focused, disposable Windows Terminal tab. This process consumes the
// synthetic paste itself in raw mode; nothing is submitted to a command shell.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

assert.equal(process.platform, "win32");
assert.ok(process.stdin.isTTY && process.stdout.isTTY, "requires a disposable focused terminal tab");
assert.ok(process.argv[2], "pass the native helper executable");
const pending = new Map();
let nextID = 0;
let received = "";
let stage = "starting";
const result = { passed: false, stages: [] };
function fail(error) {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}
function start(executable) {
  const child = spawn(executable, { stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", () => fail(new Error("helper start failed")));
  child.on("exit", () => fail(new Error("helper exited")));
  child.stderr.on("data", () => {});
  // One reply per line feed: the field's text holds U+2029 (the box's rows), which `node:readline`
  // would also end a line at.
  let unread = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = (unread + chunk).split("\n");
    unread = lines.pop();
    for (const line of lines) receive(line);
  });
  return child;
}
const helper = start(process.argv[2]);
// The focused field is read by voice-field-reader.exe, a program of its own beside the helper.
const fieldReader = start(join(dirname(process.argv[2]), "voice-field-reader.exe"));
function receive(line) {
  const reply = JSON.parse(line);
  const waiter = pending.get(reply.id);
  if (!waiter) return;
  pending.delete(reply.id);
  if (reply.error) waiter.reject(new Error("native insertion refused"));
  else waiter.resolve(reply.result);
}
function request(method, params = {}) {
  const id = ++nextID;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    (method === "focusedFieldValue" ? fieldReader : helper).stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
const wasRaw = process.stdin.isRaw;
const consume = (chunk) => { received += chunk; };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => { fail(new Error("fixture timed out")); helper.kill(); fieldReader.kill(); }, 15_000);
try {
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.on("data", consume);
  process.stdin.resume();
  process.stdout.write("\x1b[?2004lSynthetic terminal insertion test (no shell commands)\r\n");
  await pause(250);
  const expectedWindow = Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public class FixtureWindow { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }'; $h=[FixtureWindow]::GetForegroundWindow(); $s=New-Object System.Text.StringBuilder 512; [void][FixtureWindow]::GetWindowText($h,$s,512); if($s.ToString() -ceq \"TabMail Terminal Insertion Fixture\") { $h.ToInt64() } else { exit 1 }",
  ], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim());
  const target = await request("frontmostApp");
  assert.ok(expectedWindow > 0 && target?.window === expectedWindow,
    "only the dedicated terminal fixture may receive synthetic input");
  for (const [name, text] of [["ASCII", "Synthetic terminal insertion"], ["Unicode", "Synthetic 界😀 é"]]) {
    stage = name;
    received = "";
    assert.deepEqual(await request("frontmostApp"), target, "focus must not move");
    await request("insert", { ...target, text, deadline: Date.now() + 3000 });
    const until = Date.now() + 1000;
    while (received.length < text.length && Date.now() < until) await pause(10);
    assert.ok(received === text, "terminal receives exactly the synthetic payload");
    assert.deepEqual(await request("frontmostApp"), target, "insertion preserves focus");
    // A terminal's field for correction learning is the box around its cursor (its visible rows,
    // with no borders here), never its whole output.
    const field = await request("focusedFieldValue", { ...target, maxLength: 20_000, excludedAppIDs: [], excludedHosts: [] });
    assert.ok(typeof field?.value === "string" && field.value.includes("Synthetic terminal insertion test (no shell commands)"),
      "a terminal's field is the box around its cursor");
    result.stages.push(name);
  }
  result.passed = true;
  process.stdout.write("TERMINAL_INSERTION_PASS\r\n");
} catch {
  // Record only fixture-owned categories, never unexpected input or provider text.
  result.failedStage = stage;
  process.exitCode = 1;
  process.stdout.write("TERMINAL_INSERTION_FAILED\r\n");
} finally {
  clearTimeout(timeout);
  process.stdin.off("data", consume);
  process.stdin.setRawMode(wasRaw);
  process.stdin.pause();
  for (const child of [helper, fieldReader]) {
    child.stdin.end();
    child.kill();
  }
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result));
}
