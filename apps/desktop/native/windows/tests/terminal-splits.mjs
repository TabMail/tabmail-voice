// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Run in a disposable Windows Terminal tab with two vertical split panes.
// See README.md for the left-pane command and interactive selection steps.
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

assert.equal(process.platform, "win32", "requires the native Windows runtime");
assert.ok(process.stdout.isTTY, "run directly in a focused Windows Terminal tab, without output redirection");
const duplicate = "duplicate terminal 界😀 é > hello";
const selectedPrompt = "selected terminal 界😀 é > hello";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.argv[2] === "--left") {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H" + duplicate);
  await pause(120_000);
  process.exit(0);
}
assert.ok(process.argv[2] && process.argv[3], "pass helper and synthetic evidence output paths");
const evidence = { pid: process.pid, stages: [], passed: false };
const persist = () => writeFileSync(process.argv[3], JSON.stringify(evidence, null, 2));
const rows = process.stdout.rows, columns = process.stdout.columns;
assert.ok(Number.isInteger(rows) && rows > 3 && rows < 500);
assert.ok(Number.isInteger(columns) && columns >= duplicate.length && columns < 500);
const pending = new Map();
let nextID = 0;
let helperFailed = false;
function fail(error) {
  helperFailed = true;
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}
function start(executable) {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  child.on("error", fail);
  child.on("exit", () => fail(new Error("helper exited before the request completed")));
  child.stderr.on("data", () => {});
  lines.on("line", (line) => {
    try {
      const reply = JSON.parse(line);
      const waiter = pending.get(reply.id);
      if (!waiter) return;
      pending.delete(reply.id);
      if (reply.error) waiter.reject(new Error("native caret request failed"));
      else waiter.resolve(reply.result);
    } catch (error) { fail(error); }
  });
  return { child, lines };
}
const helper = start(process.argv[2]);
// The screen is read by voice-screen-reader.exe, a program of its own beside the helper.
const reader = start(join(dirname(process.argv[2]), "voice-screen-reader.exe"));
function request(method, params = {}) {
  assert.equal(helperFailed, false, "helper remains alive");
  const id = ++nextID;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    (method === "readScreen" ? reader : helper).child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
const timeout = setTimeout(() => {
  fail(new Error("terminal split validation timed out"));
  helper.child.kill(); reader.child.kill();
}, 90_000);
const read = () => request("readScreen", { excludedAppIDs: [], excludedHosts: [] });
const caretTarget = screen => {
  const v = screen.terminalViewport;
  assert.equal(v.caret.status, "exact");
  const surface = v.surfaces.find(item => item.id === v.caret.surface);
  const run = surface?.runs.find(item => item.id === v.caret.run);
  assert.ok(run, "caret identifies a captured run");
  assert.equal(v.caret.renderedOffset, run.renderedOffset + v.caret.offset);
  assert.equal(screen.renderedText.slice(run.renderedOffset, v.caret.renderedOffset), run.text.slice(0, v.caret.offset));
  return { surface, before: run.text.slice(0, v.caret.offset) };
};
// These fixture strings have equal cell and UTF-16 widths: the extra CJK cell
// balances the combining mark, and the emoji occupies two of each.
const paneText = (prompt, width) => prompt + " ".repeat(width - prompt.length) + "\r\n" +
  (" ".repeat(width) + "\r\n").repeat(rows - 1);
function assertPane(screen, surface, prompt, width) {
  assert.equal(surface.runs.length, 1, "unobscured fixture pane is contiguous");
  const run = surface.runs[0];
  // The other pane can differ by one column after Terminal splits an odd grid.
  width ??= run.text.split("\r\n")[0].length;
  assert.ok(width >= prompt.length && width < 500);
  const expected = paneText(prompt, width);
  assert.equal(run.text, expected, "retain the full prompt, padding and every visible blank row");
  assert.equal(screen.renderedText.slice(run.renderedOffset, run.renderedOffset + expected.length), expected);
  return expected;
}
async function waitFor(predicate, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await pause(250);
    const screen = await read();
    if (screen?.terminalViewport && predicate(screen)) return screen;
  }
  throw new Error(`Timed out waiting for ${description}`);
}
function record(stage, screen) {
  assert.equal(screen.terminalViewport.complete, true, "all visible surfaces captured");
  evidence.stages.push({ stage, screen });
  persist();
}
try {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H" + duplicate);
  await pause(500);
  const target = await request("frontmostApp");
  const initial = await read();
  assert.ok(initial?.terminalViewport, "focus the right Windows Terminal pane before starting");
  record("duplicate-splits", initial);
  assert.equal(initial.renderedText.split(duplicate).length - 1, 2, "identical split text is not deduplicated");
  const right = caretTarget(initial);
  assert.ok(right.before.endsWith(duplicate), "exact Unicode caret after the right prompt");
  const leftSurface = initial.terminalViewport.surfaces.find(item =>
    item.frame[0] < right.surface.frame[0] && item.runs.some(run => run.text.includes(duplicate)));
  assert.ok(leftSurface, "the other matching prompt belongs to the left pane");
  assertPane(initial, right.surface, duplicate, columns);
  assertPane(initial, leftSurface, duplicate);
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H" + selectedPrompt);
  await pause(250);
  const ready = await read();
  assert.ok(caretTarget(ready).before.endsWith(selectedPrompt));
  const expectedRight = assertPane(ready, caretTarget(ready).surface, selectedPrompt, columns);
  record("ready-for-selection", ready);
  // Press Ctrl+Shift+A in this pane. Selection must not become a guessed caret.
  const selected = await waitFor(screen => Boolean(screen.selectedText), "Ctrl+Shift+A selection");
  record("explicit-selection", selected);
  assert.ok(selected.selectedText.includes(selectedPrompt));
  assert.equal(selected.selectedText.includes(duplicate), false, "selection excludes the unfocused pane");
  assert.equal(selected.terminalViewport.selectionComplete, true);
  assert.equal(selected.selectionRedacted, false);
  // Terminal's Select All ends before the final blank cell and its CRLF.
  const expectedSelection = expectedRight.slice(0, -3);
  assert.equal(selected.selectedText, expectedSelection);
  assert.equal(selected.terminalViewport.selectedText, expectedSelection);
  const selectedSurface = selected.terminalViewport.surfaces.find(item => item.id === right.surface.id);
  assertPane(selected, selectedSurface, selectedPrompt, columns);
  assert.equal(selectedSurface.selection.ranges.length, 1);
  const span = selectedSurface.selection.ranges[0], selectedRun = selectedSurface.runs[0];
  assert.equal(span.run, selectedRun.id);
  assert.equal(span.start, 0);
  assert.equal(span.end, expectedSelection.length);
  assert.equal(span.renderedStart, selectedRun.renderedOffset);
  assert.equal(span.renderedEnd, selectedRun.renderedOffset + span.end);
  assert.equal(selected.terminalViewport.caret.status, "unavailable", "TextPattern selection does not prove an independent caret");
  // Then press Escape and Alt+Left. The left fixture must still be running.
  const left = await waitFor(screen => screen.terminalViewport.caret.status === "exact" &&
    caretTarget(screen).surface.frame[0] === leftSurface.frame[0], "focus returning left");
  record("focus-returned-left", left);
  assert.ok(caretTarget(left).before.endsWith(duplicate), "left provider preserves its own exact caret");
  assertPane(left, caretTarget(left).surface, duplicate);
  assert.equal(left.selectedText, "", "the old right selection is no longer actionable");
  assert.equal(left.terminalViewport.selectedText, "");
  assert.equal(left.terminalViewport.selectionComplete, true);
  assert.equal(left.selectionRedacted, false);
  assert.deepEqual(await request("frontmostApp"), target, "helper never changes foreground window");
  evidence.passed = true;
} catch (error) {
  evidence.error = error.stack;
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  for (const { child, lines } of [helper, reader]) {
    child.stdin.end();
    child.kill();
    lines.close();
  }
  evidence.finished = new Date().toISOString();
  persist();
}
