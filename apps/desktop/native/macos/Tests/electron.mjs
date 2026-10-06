// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

// Where voice-macos puts the overlay, and what voice-screen-reader reads around the caret, asked
// of Chromium's actual macOS accessibility provider for the editors a mail page has: a plain-text
// body (one block of lines broken by <br>), a rich-text one (a block per paragraph, an empty
// paragraph holding only a <br>), a Gmail-shaped one (a signature block that starts with empty
// lines) and one-line fields. Run from a session with Accessibility access:
// `electron macos/Tests/electron.mjs <voice-macos>` (voice-screen-reader beside it).
// Chromium reports a focused element only in its active window, so the test takes the focus for
// its few seconds: don't run it while the Mac is in use.
assert.equal(process.platform, "darwin");
assert.ok(process.argv[2], "pass the voice-macos executable path");
app.commandLine.appendSwitch("force-renderer-accessibility");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lineHeight = 20;
const pending = new Map();
let id = 0;
let helper;
let reader;
let window;
let helperErrors = "";
function request(method, params = {}) {
  const requestID = ++id;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(requestID); reject(new Error(`${method} timed out`)); }, 4000);
    pending.set(requestID, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    (method === "readScreen" ? reader : helper).stdin.write(`${JSON.stringify({ id: requestID, method, params })}\n`);
  });
}
const page = `
  <style>
    body { margin: 20px; font: 14px Arial; }
    [contenteditable], input { font: 14px/${lineHeight}px Arial; width: 500px; padding: 0; border: 0; margin: 0 0 30px; outline: 1px solid #ccc; }
    [contenteditable] { min-height: ${12 * lineHeight}px; }
    [contenteditable] div { margin: 0; }
  </style>
  <input id="empty" placeholder="Subject">
  <input id="filled" value="Synthetic subject line">
  <div id="plain" contenteditable="true">Synthetic first line<br>Synthetic second line<br><br><br>Synthetic fifth line<br>Synthetic sixth line</div>
  <div id="rich" contenteditable="true"><div>Synthetic first paragraph</div><div><br></div><div>Synthetic third paragraph</div><div>Synthetic fourth paragraph</div><div><br></div><div><br></div><div>Synthetic seventh paragraph</div></div>
  <div id="gmail" contenteditable="true">Synthetic opening line<div><br></div><div>Synthetic <b>line</b> to <i>dictate</i> under.</div><div><br><br>--<br>Synthetic signature</div></div>
`;
// Puts the caret in `field` (`script` places it) and gives the field's box and the caret's line
// box on screen, as Chromium lays them out.
async function place(field, script) {
  return window.webContents.executeJavaScript(`(() => {
    const field = document.getElementById(${JSON.stringify(field)});
    field.focus();
    ${script}
    const box = field.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  })()`);
}
async function anchor(name, frame, line, column = 0) {
  await delay(200);
  const rect = await request("caretAnchor", { pid: process.pid });
  assert.ok(rect, `${name}: an anchor`);
  const content = window.getContentBounds();
  const top = content.y + frame.y + line * lineHeight;
  const result = { name, rect, expectedTop: top, expectedX: content.x + frame.x + column };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}
const failures = [];
// The text the screen read gives around the caret, as the page lays it out.
async function expectRead(name, before, after) {
  await delay(200);
  const read = await request("readScreen", { excludedAppIDs: [], excludedHosts: [] });
  if (read?.textBeforeCaret !== before || read?.textAfterCaret !== after)
    failures.push(`${name}: read ${JSON.stringify({ before: read?.textBeforeCaret, after: read?.textAfterCaret })}, not ${JSON.stringify({ before, after })}`);
}
function expectOnLine({ name, rect, expectedTop, expectedX }, xTolerance = 4) {
  // The caret sits in its line: no more than a few points above or below the line's box.
  if (!(rect.y >= expectedTop - 4 && rect.y + rect.height <= expectedTop + lineHeight + 4 && rect.height <= lineHeight + 4))
    failures.push(`${name}: anchor ${JSON.stringify(rect)} is not on the line at ${expectedTop}`);
  // A caret, not a box the overlay would centre on (voice-macos's caretMaxWidth).
  if (Math.abs(rect.x - expectedX) > xTolerance || rect.width > 4) failures.push(`${name}: anchor ${JSON.stringify(rect)} is not a caret at ${expectedX}`);
}
const timeout = setTimeout(() => {
  process.stderr.write(`macOS Electron caret test timed out after ${id} requests\n`);
  helper?.kill(); app.exit(1);
}, 60_000);
async function main() {
  try {
    await app.whenReady();
    app.setAccessibilitySupportEnabled(true);
    helper = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
    helper.on("error", (error) => { process.stderr.write(`${error.message}\n`); app.exit(1); });
    helper.stderr.on("data", (chunk) => { helperErrors += chunk; });
    reader = spawn(join(dirname(process.argv[2]), "voice-screen-reader"), [], { stdio: ["pipe", "pipe", "pipe"] });
    reader.stderr.on("data", (chunk) => { helperErrors += chunk; });
    for (const child of [helper, reader]) createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.event) return;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    window = new BrowserWindow({ x: 40, y: 80, width: 640, height: 900, show: false, title: "Caret anchor integration test" });
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    window.show(); app.focus({ steal: true }); window.focus();
    await delay(500);

    // One-line fields: an empty one's caret is at its start, a filled one's after its text.
    let frame = await place("empty", "");
    expectOnLine(await anchor("empty field", frame, 0));
    frame = await place("filled", "field.setSelectionRange(field.value.length, field.value.length);");
    const textWidth = await window.webContents.executeJavaScript(`(() => {
      const context = document.createElement("canvas").getContext("2d"); context.font = "14px Arial";
      return context.measureText(document.getElementById("filled").value).width;
    })()`);
    expectOnLine(await anchor("filled field, caret at the end", frame, 0, textWidth), 6);

    // Plain text: lines 0-1 and 4-5 hold text, 2-3 are empty (a <br> each).
    const plainCaret = (node) => `const s = getSelection(); s.collapse(field, ${node});`;
    frame = await place("plain", plainCaret(0));
    expectOnLine(await anchor("plain text, first line", frame, 0));
    // Children: text, br, text, br, br, br, text, br, text. Before the 2nd <br> of the run is line 2.
    frame = await place("plain", plainCaret(4));
    expectOnLine(await anchor("plain text, first empty line", frame, 2));
    frame = await place("plain", plainCaret(5));
    expectOnLine(await anchor("plain text, second empty line", frame, 3));
    frame = await place("plain", plainCaret(6));
    expectOnLine(await anchor("plain text, line after the empty ones", frame, 4));

    frame = await place("plain", plainCaret(5));
    await expectRead("plain text, second empty line", "Synthetic first line\nSynthetic second line\n\n",
                     "\nSynthetic fifth line\nSynthetic sixth line");

    // Rich text: paragraphs 1, 4 and 5 are empty. Each paragraph is a line of its own in the read.
    const richCaret = (paragraph) => `getSelection().collapse(field.children[${paragraph}], 0);`;
    for (const paragraph of [0, 1, 2, 4, 5, 6]) {
      frame = await place("rich", richCaret(paragraph));
      expectOnLine(await anchor(`rich text, paragraph ${paragraph}`, frame, paragraph));
    }
    frame = await place("rich", richCaret(5));
    await expectRead("rich text, second of two empty paragraphs",
                     "Synthetic first paragraph\n\nSynthetic third paragraph\nSynthetic fourth paragraph\n\n", "\nSynthetic seventh paragraph");
    frame = await place("rich", richCaret(3));
    await expectRead("rich text, start of a paragraph after another",
                     "Synthetic first paragraph\n\nSynthetic third paragraph\n", "Synthetic fourth paragraph\n\n\nSynthetic seventh paragraph");

    // Gmail: a line, an empty one, the line dictated under (in several runs of text, which must not
    // read as paragraphs), then the signature block, which starts
    // with two empty lines; the caret on the first of them (the block's start) is on line 3.
    frame = await place("gmail", "getSelection().collapse(field.children[2], 0);");
    expectOnLine(await anchor("Gmail-shaped, empty line starting the signature block", frame, 3));
    frame = await place("gmail", "getSelection().collapse(field.children[2], 1);");
    expectOnLine(await anchor("Gmail-shaped, second empty line of the signature block", frame, 4));
    frame = await place("gmail", "getSelection().collapse(field.children[2], 0);");
    await expectRead("Gmail-shaped, empty line starting the signature block",
                     "Synthetic opening line\n\nSynthetic line to dictate under.\n", "\n\n--\nSynthetic signature");
    // The end of the line dictated under has the signature block's start's offset, and the break
    // follows it; a caret before a bold word is inside a line.
    frame = await place("gmail", "getSelection().collapse(field.children[1], field.children[1].childNodes.length);");
    await expectRead("Gmail-shaped, end of the line dictated under",
                     "Synthetic opening line\n\nSynthetic line to dictate under.", "\n\n\n--\nSynthetic signature");
    frame = await place("gmail", "getSelection().collapse(field.children[1].children[0].firstChild, 0);");
    await expectRead("Gmail-shaped, before a bold word", "Synthetic opening line\n\nSynthetic ",
                     "line to dictate under.\n\n\n--\nSynthetic signature");

    if (failures.length) {
      process.stderr.write(`${failures.join("\n")}\n`);
      process.exitCode = 1;
    } else process.stdout.write("macOS Electron caret anchors passed\n");
  } catch (error) {
    process.stderr.write(`${error.stack}\n${helperErrors.slice(-2000)}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    helper?.stdin.end(); helper?.kill(); reader?.kill();
    app.exit(process.exitCode ?? 0);
  }
}
main();
