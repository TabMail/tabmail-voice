// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Run interactively inside Windows Terminal. This deliberately tests its real
// UIA provider; redirected CTest output cannot establish an interactive caret.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

assert.equal(process.platform, "win32", "requires the native Windows runtime");
assert.ok(process.stdout.isTTY, "run directly in a focused Windows Terminal tab, without output redirection");
assert.ok(process.argv[2], "pass the built voice-windows.exe path");
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
  fail(new Error("terminal caret validation timed out"));
  helper.child.kill(); reader.child.kill();
}, 15_000);
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
try {
  process.stdout.write("\nSynthetic terminal caret: ");
  await settle();
  const target = await request("frontmostApp");
  assert.ok(target?.window, "terminal must be foreground");
  const first = await request("caretAnchor", target);
  assert.ok(first && first.height > 0, "Terminal's collapsed selection exposes a caret");
  process.stdout.write("ABCDEF");
  await settle();
  const second = await request("caretAnchor");
  assert.ok(second, "caret remains available after terminal output");
  assert.ok(second.x > first.x, "caret tracks new characters independently of mouse position");
  assert.equal(second.y, first.y, "short output stays on the same line");
  assert.equal(second.height, first.height, "font metrics remain stable");
  process.stdout.write("\nSynthetic next line: ");
  await settle();
  const third = await request("caretAnchor", target);
  assert.ok(third && third.x < second.x, "new-line caret returns toward the left margin");
  // At the viewport bottom Terminal scrolls instead of increasing screen Y.
  assert.ok(third.y >= second.y, "new line advances or scrolls at the viewport edge");
  assert.equal(await request("focusedFieldValue", { ...target, maxLength: 20_000, excludedAppIDs: [], excludedHosts: [] }), null,
    "geometry support does not opt terminal output into correction learning");
  assert.deepEqual(await request("frontmostApp"), target, "helper never activates a different window");
  // Fill the display with synthetic rows before requesting screen text. The
  // historical sentinel must be in scrollback, never in the shared viewport.
  assert.ok(Number.isInteger(process.stdout.rows) && process.stdout.rows > 3 && process.stdout.rows < 500,
    "requires a bounded terminal viewport");
  for (const [probe, blankRows] of [
    ["ASCII reference > hello", 0],
    ["Unicode reference 界😀 é > hello", 0],
    ["Trailing blank rows > hello", Math.min(6, process.stdout.rows - 2)],
  ]) {
    process.stdout.write("\r\nSYNTHETIC_OLD_SCROLLBACK_SENTINEL\r\n");
    for (let row = 0; row < process.stdout.rows + 3; row++) process.stdout.write(`synthetic row ${row}\r\n`);
    // Leave blank rows below the cursor, where Windows Terminal's visible range
    // extends beyond its shorter DocumentRange. Move only this fixture's cursor.
    if (blankRows) process.stdout.write("\r\n".repeat(blankRows) + `\x1b[${blankRows}A\r`);
    process.stdout.write(probe);
    await settle();
    assert.deepEqual(await request("frontmostApp"), target, "terminal retains focus before viewport read");
    const screen = await request("readScreen", { excludedAppIDs: [], excludedHosts: [] });
    assert.ok(screen?.terminalViewport, "production dispatch returns the shared terminal viewport");
    const viewport = screen.terminalViewport;
    assert.equal(viewport.complete, true, "all displayed terminal surfaces were acquired");
    assert.equal(viewport.caret.status, "exact", "native provider establishes exact text insertion offset");
    const surface = viewport.surfaces.find((item) => item.id === viewport.caret.surface);
    const run = surface?.runs.find((item) => item.id === viewport.caret.run);
    assert.ok(run, "caret identifies a captured visible run");
    assert.ok(run.text.slice(0, viewport.caret.offset).endsWith(probe),
      "UTF-16 caret is exactly after the synthetic ASCII or Unicode prompt");
    assert.ok(screen.renderedText.slice(0, viewport.caret.renderedOffset).endsWith(probe),
      "rendered insertion offset preserves the same prompt boundary");
    assert.equal(screen.renderedText.includes("SYNTHETIC_OLD_SCROLLBACK_SENTINEL"), false,
      "capture excludes older scrollback");
    if (blankRows) {
      const after = run.text.slice(viewport.caret.offset);
      assert.ok((after.match(/\n/gu) ?? []).length >= blankRows, "visible blank rows below the caret are retained");
      assert.match(after, /^[ \r\n]*$/u, "only the fixture's trailing blank viewport remains after the caret");
    }
    assert.equal(screen.selectedText, "", "collapsed caret does not invent a selection");
    assert.equal(viewport.selectionComplete, true, "empty native selection is established");
    assert.deepEqual(await request("frontmostApp"), target, "viewport acquisition never activates another window");
  }
  process.stdout.write("\nTERMINAL_CARET_AND_VIEWPORT_PASS\n");
} finally {
  clearTimeout(timeout);
  for (const { child, lines } of [helper, reader]) {
    child.stdin.end();
    child.kill();
    lines.close();
  }
}
