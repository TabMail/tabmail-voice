// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { once } from "node:events";

async function terminalCopy() {
  const copy = join(await mkdtemp(join(tmpdir(), "voice-terminal-")), "wsl.exe");
  await copyFile(process.argv[3], copy);
  return copy;
}
function client(executable, args = []) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = [];
  const messages = [];
  let errorText = "";
  let exited = false;
  child.stderr.on("data", (chunk) => { errorText += chunk; });
  child.on("error", (error) => {
    exited = true;
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });
  child.on("exit", (code) => {
    exited = true;
    for (const waiter of pending.splice(0)) waiter.reject(new Error(`Native fixture exited ${code}: ${errorText}`));
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const parsed = JSON.parse(line);
    if (pending.length) pending.shift().resolve(parsed);
    else messages.push(parsed);
  });
  return { child, lines, next: () => messages.length ? Promise.resolve(messages.shift()) : exited ?
    Promise.reject(new Error(`Native fixture already exited: ${errorText}`)) :
    new Promise((resolve, reject) => pending.push({ resolve, reject })), errors: () => errorText };
}
const helper = client(process.argv[2]);
// The screen is read by voice-screen-reader.exe, a program of its own beside the helper.
const reader = client(join(dirname(process.argv[2]), "voice-screen-reader.exe"));
let id = 0;
async function request(method, params = {}) {
  const target = method === "readScreen" ? reader : helper;
  target.child.stdin.write(`${JSON.stringify({ id: ++id, method, params })}\n`);
  const reply = await target.next();
  assert.equal(reply.id, id);
  assert.equal(reply.error, undefined, `${method} must succeed`);
  return reply.result;
}
const exclusions = { excludedAppIDs: [], excludedHosts: ["blocked.example"] };
let fixture;
const timeout = setTimeout(() => { fixture?.child.kill(); helper.child.kill(); reader.child.kill(); process.exitCode = 1; }, 80_000);
let checks = 0;
try {
  for (const mode of ["row-hidden", "hidden-box", "large-text", "large-row", "large-link", "large-field", "large-web-control", "large-focus", "large-window-field", "outside-window", "bare-page-control", "outside-page", "page-place-fails", "page-under-thin-row", "page-under-thin-part", "page-in-text", "page-in-control", "text-full", "password-window", "password-row", "password-link", "password-link-raw", "password-web-control", "password-focus",
    "page-focus", "page-focus-child", "page-in-focus", "page-outside-focus", "page-frame", "page-row", "page-link", "page-unknown", "page-no-address", "page-address-bar",
    "page-gecko", "page-ie", "page-no-framework", "page-framework-fails", "open-page", "open-page-focus", "text-document", "terminal-wide"]) {
    // The fixture's process is no known browser: a page is told by its web framework, whichever
    // app runs it. A terminal is told by its program's name, so that mode runs a copy named as one.
    fixture = client(mode === "terminal-wide" ? await terminalCopy() : process.argv[3], [mode]);
    const initial = await fixture.next();
    assert.deepEqual(await request("frontmostApp"), { window: initial.window }, `${mode}: fixture owns foreground`);
    fixture.child.stdin.write("reset\n"); await fixture.next();
    const context = await request("readScreen", exclusions);
    const refused = mode.startsWith("page-") && mode !== "page-no-address";
    if (refused && (context === null || context.hidden !== true)) {
      fixture.child.stdin.write("stats\n");
      process.stderr.write(`${mode}: ${JSON.stringify(await fixture.next())}\n${helper.errors()}${reader.errors()}`);
    }
    if (mode === "terminal-wide") assert.equal(context, null, "a terminal window not looked through whole is not read");
    else if (refused) assert.deepEqual(context, { hidden: true }, `${mode}: entire reply refused, and reported as hidden`);
    else {
      assert.ok(context, `${mode}: safe context remains available`);
      assert.ok(!JSON.stringify(context).includes("DO_NOT_READ"), `${mode}: password absent from reply`);
      if (mode === "password-focus") {
        assert.deepEqual([context.textBeforeCaret, context.selectedText, context.textAfterCaret], ["", "", ""]);
        assert.ok(context.renderedText.includes("» ‸"), "protected focus is marker only");
      } else if (mode !== "large-window-field" && mode !== "large-focus") assert.ok(context.renderedText.includes("Synthetic safe label"), `${mode}: safe siblings retained`);
      if (mode === "row-hidden") assert.ok(context.renderedText.includes("| Synthetic cell text") && !context.renderedText.includes("Synthetic hidden text"), "a row's block leaves out a cell in a box that shows nothing");
      if (mode === "hidden-box") {
        assert.ok(context.renderedText.includes("Synthetic hidden-box text"), "a container that shows nothing is walked into");
        assert.ok(!context.renderedText.includes("Synthetic thin box text") && !context.renderedText.includes("Synthetic under thin text"), "a text box that shows nothing is skipped with what it holds");
      }
      if (mode === "large-text") assert.ok(context.renderedText.includes("[hidden for privacy]") && !context.renderedText.includes("Synthetic large text"), "text too large to look through whole is withheld behind the marker");
      // A row is gathered from its parts, each looked through on its own; a link's name is read
      // whole, so one too large to look through is withheld behind the marker (ADR-DESK-054).
      if (mode === "large-row") assert.ok(context.renderedText.includes("| Synthetic cell text") && !context.renderedText.includes("Synthetic large name"),
        "a large row reads its cells, each looked through, and not its own name");
      if (mode === "large-link") assert.ok(context.renderedText.includes("[[hidden for privacy]]") && !context.renderedText.includes("Synthetic large name") &&
        !context.renderedText.includes("Synthetic cell text"), "a link too large to look through whole is withheld behind the marker");
      if (mode === "large-field" || mode === "large-web-control") {
        const marker = mode === "large-field" ? "> [hidden for privacy]" : "[hidden for privacy]";
        assert.ok(context.renderedText.includes(marker) && !context.renderedText.includes("Synthetic large name"),
          `${mode}: a part too large to look through whole is withheld behind the marker`);
      }
      if (mode === "large-focus") assert.ok(context.hidden !== true && !context.renderedText.includes("Synthetic large text"),
        "a focus too large to look through whole lets the read go on, and is not read");
      if (mode === "bare-page-control") assert.ok(context.renderedText.includes("Synthetic nested option") && !context.renderedText.includes("Synthetic undrawn label"),
        "what a page's control with no caption holds is in the page: its text read, a control's Name not");
      if (mode === "outside-page") assert.ok(context.hidden !== true, "an excluded page wholly outside the window is skipped with what it holds");
      if (mode === "text-full") {
        const nodes = Number(/(\d+) nodes/.exec(context.summary ?? "")?.[1] ?? -1);
        assert.ok(context.summary.includes("stopped: text budget") && nodes >= 0 && nodes < 100, "a read stops when its text budget is full");
      }
      if (mode === "outside-window") assert.ok(context.renderedText.includes("Synthetic visible text") && !(context.summary ?? "").includes("node budget"),
        "a box outside the window is skipped with what it holds");
      if (mode === "password-row") assert.ok(context.renderedText.includes("| Synthetic cell text"), "a row is one block of its cells, without its password field");
      if (mode.startsWith("password-link")) assert.ok(context.renderedText.includes("[Synthetic cell text]"), "a link that can't give its name is the text under it, without its password field");
      if (mode.startsWith("open-page")) {
        assert.equal(context.host, "open.example", `${mode}: the page's host is reported, in focus or reached by the walk`);
        assert.ok(context.renderedText.includes("Synthetic page text"), `${mode}: the page is walked into`);
      }
      if (mode === "text-document") assert.ok(context.renderedText.includes("Synthetic page text"), "a text document is no web page: it is read");
      if (mode === "open-page-focus") {
        assert.equal(context.focusedRole, "control", "a page that can't be edited is no field");
        assert.deepEqual([context.textBeforeCaret, context.selectedText, context.textAfterCaret], ["", "", ""]);
        assert.ok(!context.renderedText.includes("‸"), "a page in focus with nothing selected has no caret block");
      }
    }
    fixture.child.stdin.write("stats\n");
    const stats = await fixture.next();
    assert.equal(stats.forbiddenReads, 0, `${mode}: screen must not request protected content`);
    if (["page-focus", "page-focus-child", "page-in-focus", "page-unknown", "terminal-wide"].includes(mode)) {
      assert.equal(stats.textReads, 0, `${mode}: preflight must precede all text reads`);
    }
    if (mode === "large-window-field") {
      // A refusal answers { value: null }; the fixture's field has no text to give past the looks
      // (no text pattern, no Win32 edit), so going on answers null.
      assert.equal(await request("focusedFieldValue", { ...exclusions, window: initial.window, maxLength: 20000 }), null,
        "a field in a window too large to look through whole is not refused for corrections");
    }
    if (mode === "password-focus" || mode === "page-address-bar") {
      assert.deepEqual(await request("focusedFieldValue", { ...exclusions, window: initial.window, maxLength: 20000 }), { value: null });
      fixture.child.stdin.write("stats\n");
      assert.equal((await fixture.next()).forbiddenReads, 0, `${mode}: correction must not request protected content`);
    }
    const exit = once(fixture.child, "exit"); fixture.child.stdin.end();
    assert.deepEqual(await exit, [0, null]); fixture.lines.close(); fixture = undefined;
    ++checks;
  }
  const exits = [once(helper.child, "exit"), once(reader.child, "exit")]; helper.child.stdin.end(); reader.child.stdin.end();
  for (const exit of exits) assert.deepEqual(await exit, [0, null]);
  process.stdout.write(`${checks} synthetic provider privacy cases passed through the actual helper\n`);
} finally {
  clearTimeout(timeout); fixture?.child.kill(); fixture?.lines.close(); helper.child.kill(); helper.lines.close(); reader.child.kill(); reader.lines.close();
}
