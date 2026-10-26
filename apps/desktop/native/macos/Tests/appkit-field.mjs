// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The screen reader's two scopes on AppKit's actual Accessibility provider, through the reader's
// own field source (`LiveScreenTree.fieldSource`, `ScreenContextReader.visibleSource`): a long text
// view out of focus gives what the window shows nothing scrolled out of view, and the whole window
// all of it (ADR-DESK-016, fields by scope). AppKit's provider gives a text view's whole text;
// Chromium's caps a text field's at 10,000 characters, so its two scopes can't differ there. Run from a session with Accessibility access:
// `node macos/Tests/appkit-field.mjs <voice-screen-reader>`. The fixture's window takes the focus
// for a few seconds: don't run it while the Mac is in use. Prints which parts each read holds, never
// the text.
assert.equal(process.platform, "darwin");
assert.ok(process.argv[2], "pass the voice-screen-reader executable path");
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(mkdtempSync(join(tmpdir(), "voice-appkit-field-")), "appkit-field");
const built = spawnSync("swiftc", ["-O", join(here, "appkit-field.swift"), "-o", fixture], { stdio: "inherit" });
assert.equal(built.status, 0, "the fixture builds");

const lines = (child) => {
  const queue = [];
  const waiting = [];
  createInterface({ input: child.stdout }).on("line", (line) => (waiting.shift() ?? ((value) => queue.push(value)))(line));
  return () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve)));
};
const window = spawn(fixture, [], { stdio: ["pipe", "pipe", "inherit"] });
const reader = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
let readerErrors = "";
reader.stderr.on("data", (chunk) => { readerErrors += chunk; });
const timeout = setTimeout(() => { window.kill(); reader.kill(); process.stderr.write("AppKit field test timed out\n"); process.exit(1); }, 60_000);
try {
  assert.equal(await lines(window)(), "ready", "the fixture's window is in front");
  const next = lines(reader);
  let id = 0;
  const read = async (params) => {
    reader.stdin.write(`${JSON.stringify({ id: ++id, method: "readScreen", params: { excludedAppIDs: [], excludedHosts: [], ...params } })}\n`);
    const reply = JSON.parse(await next());
    assert.ok(!reply.error, `readScreen: ${reply.error?.message}`);
    return reply.result?.renderedText ?? "";
  };
  const parts = (text) => ({ focus: text.includes("Synthetic focus"), start: text.includes("Synthetic visible start"), filler: text.includes("Synthetic filler words"), tail: text.includes("Synthetic hidden tail") });
  const shown = parts(await read({}));
  const whole = parts(await read({ wholeWindow: true }));
  process.stdout.write(`${JSON.stringify({ shown, whole })}\n`);
  // What the window shows never takes the tail scrolled out of view. (It leaves this AppKit field
  // out altogether: its part-in-view read fails here, as on main before the two scopes, #266.)
  assert.ok(shown.focus && !shown.tail, "what the window shows takes nothing scrolled out of view");
  assert.deepEqual(whole, { focus: true, start: true, filler: true, tail: true }, "the whole window takes the long field whole");
  process.stdout.write("macOS AppKit field scopes passed\n");
} catch (error) {
  process.stderr.write(`${error.stack}\n${readerErrors.slice(-2000)}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  window.stdin.end(); reader.stdin.end(); reader.kill();
}
