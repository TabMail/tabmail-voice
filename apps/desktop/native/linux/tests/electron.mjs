// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

// What voice-screen-reader reads around the caret, asked of Chromium's actual AT-SPI provider for
// the editors a mail page has: a plain-text body (one block of lines broken by <br>), a rich-text
// one (a block per paragraph, an empty paragraph holding only a <br>) and a Gmail-shaped one (a
// line in several runs of text, then a signature block that starts with empty lines). The same
// cases as macos/Tests/electron.mjs. Run in a GNOME session with accessibility on:
// `electron linux/tests/electron.mjs <voice-linux>` (voice-screen-reader beside it).
assert.equal(process.platform, "linux");
assert.ok(process.argv[2], "pass the voice-linux executable path");
// The reader names the app in front by its desktop file, as GNOME launches it.
if (!process.env.GIO_LAUNCHED_DESKTOP_FILE) {
  const desktopFile = join(mkdtempSync(join(tmpdir(), "voice-electron-")), "ai.tabmail.voice.electron-fixture.desktop");
  writeFileSync(desktopFile, "[Desktop Entry]\nType=Application\nName=Synthetic Electron fixture\nExec=electron\n");
  const child = spawn(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, ACCESSIBILITY_ENABLED: "1", GIO_LAUNCHED_DESKTOP_FILE: desktopFile } });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  app.commandLine.appendSwitch("force-renderer-accessibility");
  // GNOME activates a new Wayland window, not a new X11 one, and reads only the active window.
  app.commandLine.appendSwitch("ozone-platform", "wayland");
  main();
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pending = new Map();
let id = 0;
let reader;
let window;
let readerErrors = "";
function request(method, params = {}) {
  const requestID = ++id;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(requestID); reject(new Error(`${method} timed out`)); }, 6000);
    pending.set(requestID, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    reader.stdin.write(`${JSON.stringify({ id: requestID, method, params })}\n`);
  });
}
const page = `
  <style>
    body { margin: 20px; font: 14px Arial; }
    [contenteditable] { font: 14px/20px Arial; width: 500px; min-height: 240px; padding: 0; border: 0; margin: 0 0 30px; outline: 1px solid #ccc; }
    [contenteditable] div { margin: 0; }
    p { font: 14px/20px Arial; margin: 0 0 10px; }
  </style>
  <p>Key sk-Review<b>Fixture1234567890</b> here</p>
  <p>Visit <a href="#v">example</a> now</p>
  <p>Read <a href="#r">more </a>now</p>
  <p>Paste<a href="#k"> sk-ReviewLink1234567890abcd</a></p>
  <div id="plain" contenteditable="true">Synthetic first line<br>Synthetic second line<br><br><br>Synthetic fifth line<br>Synthetic sixth line</div>
  <div id="rich" contenteditable="true"><div>Synthetic first paragraph</div><div><br></div><div>Synthetic third paragraph</div><div>Synthetic fourth paragraph</div><div><br></div><div><br></div><div>Synthetic seventh paragraph</div></div>
  <div id="gmail" contenteditable="true">Synthetic opening line<div><br></div><div>Synthetic <b>line</b> to <i>dictate</i> under.</div><div><br><br>--<br>Synthetic signature</div></div>
`;
// Puts the caret in `field`, where `script` places it.
async function place(field, script) {
  await window.webContents.executeJavaScript(`(() => {
    const field = document.getElementById(${JSON.stringify(field)});
    field.focus();
    ${script}
  })()`);
}
const failures = [];
// The text the screen read gives around the caret, as the page lays it out.
async function expectRead(name, before, after) {
  await delay(300);
  const read = await request("readScreen", { excludedAppIDs: [], excludedHosts: [] });
  if (read?.textBeforeCaret !== before || read?.textAfterCaret !== after)
    failures.push(`${name}: read ${JSON.stringify({ before: read?.textBeforeCaret, after: read?.textAfterCaret })}, not ${JSON.stringify({ before, after })}`);
}
// Pieces of one line on screen (a run of bold, a link) are read as that one line, with the screen's
// spaces and none where they abut: a key split by bold is redacted whole.
async function expectInlineLines() {
  await delay(300);
  const rendered = (await request("readScreen", { excludedAppIDs: [], excludedHosts: [] }))?.renderedText ?? "";
  for (const line of ["Key [redacted] here", "Visit [example] now", "Read [more] now", "Paste [[redacted]]"])
    if (!rendered.split("\n").includes(line)) failures.push(`inline pieces: no line ${JSON.stringify(line)} in the read`);
  for (const piece of ["sk-Review", "Fixture1234567890", "Link1234567890abcd"])
    if (rendered.includes(piece)) failures.push(`inline pieces: a piece of the key split by bold is in the read`);
}
async function main() {
  const timeout = setTimeout(() => {
    process.stderr.write(`Linux Electron caret test timed out after ${id} requests\n`);
    reader?.kill(); app.exit(1);
  }, 60_000);
  try {
    await app.whenReady();
    app.setAccessibilitySupportEnabled(true);
    reader = spawn(join(dirname(process.argv[2]), "voice-screen-reader"), [], { stdio: ["pipe", "pipe", "pipe"] });
    reader.on("error", (error) => { process.stderr.write(`${error.message}\n`); app.exit(1); });
    reader.stderr.on("data", (chunk) => { readerErrors += chunk; });
    createInterface({ input: reader.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.event) return;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    window = new BrowserWindow({ width: 640, height: 900, title: "Caret read integration test" });
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    await delay(1000);

    // Plain text: lines 0-1 and 4-5 hold text, 2-3 are empty (a <br> each). Children: text, br,
    // text, br, br, br, text, br, text; before the 3rd <br> of the run is line 3.
    await place("plain", "getSelection().collapse(field, 5);");
    await expectInlineLines();
    await expectRead("plain text, second empty line", "Synthetic first line\nSynthetic second line\n\n",
                     "\nSynthetic fifth line\nSynthetic sixth line");

    // Rich text: paragraphs 1, 4 and 5 are empty. Each paragraph is a line of its own in the read.
    const richCaret = (paragraph) => `getSelection().collapse(field.children[${paragraph}], 0);`;
    await place("rich", richCaret(5));
    await expectRead("rich text, second of two empty paragraphs",
                     "Synthetic first paragraph\n\nSynthetic third paragraph\nSynthetic fourth paragraph\n\n", "\nSynthetic seventh paragraph");
    await place("rich", richCaret(3));
    await expectRead("rich text, start of a paragraph after another",
                     "Synthetic first paragraph\n\nSynthetic third paragraph\n", "Synthetic fourth paragraph\n\n\nSynthetic seventh paragraph");

    // Gmail: a line, an empty one, the line dictated under (in several runs of text, which must not
    // read as paragraphs), then the signature block, which starts with two empty lines.
    await place("gmail", "getSelection().collapse(field.children[2], 0);");
    await expectRead("Gmail-shaped, empty line starting the signature block",
                     "Synthetic opening line\n\nSynthetic line to dictate under.\n", "\n\n--\nSynthetic signature");
    await place("gmail", "getSelection().collapse(field.children[2], 1);");
    await expectRead("Gmail-shaped, second empty line of the signature block",
                     "Synthetic opening line\n\nSynthetic line to dictate under.\n\n", "\n--\nSynthetic signature");
    // The end of the line dictated under, and a caret before a bold word, inside a line.
    await place("gmail", "getSelection().collapse(field.children[1], field.children[1].childNodes.length);");
    await expectRead("Gmail-shaped, end of the line dictated under",
                     "Synthetic opening line\n\nSynthetic line to dictate under.", "\n\n\n--\nSynthetic signature");
    await place("gmail", "getSelection().collapse(field.children[1].children[0].firstChild, 0);");
    await expectRead("Gmail-shaped, before a bold word", "Synthetic opening line\n\nSynthetic ",
                     "line to dictate under.\n\n\n--\nSynthetic signature");

    if (failures.length) {
      process.stderr.write(`${failures.join("\n")}\n${readerErrors.slice(-1500)}\n`);
      process.exitCode = 1;
    } else process.stdout.write("Linux Electron caret reads passed\n");
  } catch (error) {
    process.stderr.write(`${error.stack}\n${readerErrors.slice(-2000)}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    reader?.stdin.end(); reader?.kill();
    app.exit(process.exitCode ?? 0);
  }
}
