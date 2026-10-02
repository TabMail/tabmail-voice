// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

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
let id = 0;
async function request(method, params = {}) {
  helper.child.stdin.write(`${JSON.stringify({ id: ++id, method, params })}\n`);
  const reply = await helper.next();
  assert.equal(reply.id, id);
  assert.equal(reply.error, undefined, `${method} must succeed`);
  return reply.result;
}
const exclusions = { excludedAppIDs: [], excludedHosts: ["blocked.example"] };
let fixture;
const timeout = setTimeout(() => { fixture?.child.kill(); helper.child.kill(); process.exitCode = 1; }, 40_000);
let checks = 0;
try {
  for (const mode of ["password-window", "password-row", "password-link", "password-web-control", "password-focus",
    "page-focus", "page-focus-child", "page-in-focus", "page-outside-focus", "page-frame", "page-row", "page-unknown", "page-no-address", "page-address-bar"]) {
    fixture = client(process.argv[3], [mode]);
    const initial = await fixture.next();
    assert.deepEqual(await request("frontmostApp"), { window: initial.window }, `${mode}: fixture owns foreground`);
    fixture.child.stdin.write("reset\n"); await fixture.next();
    const context = await request("readScreen", exclusions);
    const refused = mode.startsWith("page-") && mode !== "page-no-address";
    if (refused && (context === null || context.hidden !== true)) {
      fixture.child.stdin.write("stats\n");
      process.stderr.write(`${mode}: ${JSON.stringify(await fixture.next())}\n${helper.errors()}`);
    }
    if (refused) assert.deepEqual(context, { hidden: true }, `${mode}: entire reply refused, and reported as hidden`);
    else {
      assert.ok(context, `${mode}: safe context remains available`);
      assert.ok(!JSON.stringify(context).includes("DO_NOT_READ"), `${mode}: password absent from reply`);
      if (mode === "password-focus") {
        assert.deepEqual([context.textBeforeCaret, context.selectedText, context.textAfterCaret], ["", "", ""]);
        assert.ok(context.renderedText.includes("» ‸"), "protected focus is marker only");
      } else assert.ok(context.renderedText.includes("Synthetic safe label"), `${mode}: safe siblings retained`);
    }
    fixture.child.stdin.write("stats\n");
    const stats = await fixture.next();
    assert.equal(stats.forbiddenReads, 0, `${mode}: screen must not request protected content`);
    if (["page-focus", "page-focus-child", "page-in-focus", "page-unknown"].includes(mode)) {
      assert.equal(stats.textReads, 0, `${mode}: preflight must precede all text reads`);
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
  const exit = once(helper.child, "exit"); helper.child.stdin.end();
  assert.deepEqual(await exit, [0, null]);
  process.stdout.write(`${checks} synthetic provider privacy cases passed through the actual helper\n`);
} finally {
  clearTimeout(timeout); fixture?.child.kill(); fixture?.lines.close(); helper.child.kill(); helper.lines.close();
}
