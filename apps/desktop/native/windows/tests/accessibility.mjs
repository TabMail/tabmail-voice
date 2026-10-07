// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { once } from "node:events";

function client(executable, args = []) {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
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
const fixture = client(process.argv[3], ["--read-only"]);
const helper = client(process.argv[2]);
// The screen is read by voice-screen-reader.exe, a program of its own beside the helper.
const reader = client(join(dirname(process.argv[2]), "voice-screen-reader.exe"));
let id = 0;
let stage = "fixture startup";
async function request(method, params = {}, expectError = false) {
  if (method === "readScreen" || method === "focusedFieldValue") params = { excludedAppIDs: [], excludedHosts: [], ...params };
  stage = method;
  id += 1;
  const target = method === "readScreen" ? reader : helper;
  target.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  const reply = await target.next();
  assert.equal(reply.id, id);
  if (expectError) {
    assert.equal(reply.error?.message, "Windows accessibility request failed", "invalid field bounds are refused");
    return;
  }
  assert.equal(reply.error, undefined, "native read succeeds rather than hiding a provider failure");
  return reply.result;
}
// A request as sent, its reply whole (an error included).
async function rawRequest(target, method, params) {
  id += 1;
  target.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  const reply = await target.next();
  assert.equal(reply.id, id);
  return reply;
}
async function mode(value) {
  stage = `fixture mode ${value}`;
  fixture.child.stdin.write(`${value}\n`);
  const reply = await fixture.next();
  assert.equal(reply.mode, value);
  assert.deepEqual(await request("frontmostApp"), { window: reply.window }, "synthetic target is foreground");
  return reply.window;
}
const timeout = setTimeout(() => {
  fixture.child.kill(); helper.child.kill(); reader.child.kill();
  process.stderr.write(`Windows UI Automation integration timed out at ${stage}; ${fixture.errors()}${helper.errors()}${reader.errors()}\n`);
  process.exitCode = 1;
}, 20_000);
try {
  const initial = await fixture.next();
  assert.equal(initial.mode, "editable");
  const window = await mode("editable");
  const caret = await request("caretAnchor", { window });
  assert.ok(caret && caret.height > 0 && caret.width >= 0, "editable field exposes its native caret");
  const context = await request("readScreen");
  assert.ok(context, "editable field exposes a text context");
  assert.equal(context.textBeforeCaret, "Before ");
  assert.equal(context.selectedText, "selected");
  assert.equal(context.textAfterCaret, " after.");
  assert.ok(context.renderedText.includes("‸selected‸"));
  const fieldParams = { window, maxLength: 20_000 };
  assert.deepEqual(await request("focusedFieldValue", fieldParams), { value: "Before selected after." }, "complete field is available for local correction learning");
  for (const maxLength of [0, -1, 20_001, 2 ** 32 + 20_000, "20000", null]) {
    await request("focusedFieldValue", { ...fieldParams, maxLength }, true);
  }
  assert.equal(await request("focusedFieldValue", { ...fieldParams, window: 0 }), null, "ambiguous target is refused");
  assert.equal(await request("focusedFieldValue", { ...fieldParams, window: window + 1 }), null, "other target is refused");
  assert.equal(await request("focusedFieldValue", { ...fieldParams, maxLength: 10 }), null, "long field is refused rather than truncated");
  await mode("long");
  assert.equal(await request("focusedFieldValue", fieldParams), null, "field beyond the hard limit is refused");
  await mode("limit");
  assert.equal((await request("focusedFieldValue", fieldParams)).value.length, 20_000, "exact-limit field is complete");
  await mode("unicode");
  assert.deepEqual(await request("focusedFieldValue", fieldParams), { value: "Before Xyvora 🙂 after." }, "Unicode field is preserved");
  await mode("empty");
  assert.deepEqual(await request("focusedFieldValue", fieldParams), { value: "" }, "empty editable field is distinguished from a refused field");
  await mode("password");
  assert.deepEqual(await request("focusedFieldValue", fieldParams), { value: null }, "password learning is refused");
  const protectedContext = await request("readScreen");
  assert.ok(protectedContext, "a protected focus retains the safe window context");
  assert.deepEqual([protectedContext.textBeforeCaret, protectedContext.selectedText, protectedContext.textAfterCaret], ["", "", ""]);
  assert.ok(protectedContext.renderedText.includes("» ‸"), "protected focus contributes only the caret marker");
  assert.ok(!JSON.stringify(protectedContext).includes("Before selected after."), "password value never enters the reply");
  assert.equal(await request("caretAnchor", { window }), null, "password caret is refused");
  await mode("readOnly");
  assert.equal(await request("focusedFieldValue", fieldParams), null, "read-only learning is refused");
  assert.ok(await request("readScreen"), "read-only focus still permits visible window context");
  await mode("button");
  assert.equal(await request("focusedFieldValue", fieldParams), null, "non-text learning is refused");
  assert.ok(await request("readScreen"), "non-text focus still permits visible window context");
  await mode("editable");
  assert.equal((await request("readScreen")).selectedText, "selected", "refusal does not poison subsequent reads");
  // A classic multi-line edit (Notepad, Win32, WinForms and MFC dialogs) is anchored, read whole and
  // refused like the single-line one.
  await mode("multiline");
  const multilineCaret = await request("caretAnchor", { window });
  assert.ok(multilineCaret && multilineCaret.height > 0, "a multi-line edit exposes its caret");
  assert.deepEqual(await request("focusedFieldValue", fieldParams), { value: "First line\r\nSecond selected line." }, "a multi-line edit is read whole, its line break included");
  assert.equal(await request("focusedFieldValue", { ...fieldParams, maxLength: 10 }), null, "a long multi-line edit is refused rather than truncated");
  await mode("multilineReadOnly");
  assert.equal(await request("focusedFieldValue", fieldParams), null, "a read-only multi-line edit is refused");
  await mode("secret");
  const privateContext = await request("readScreen");
  assert.equal(privateContext.windowTitle, "password: [redacted]", "window title is filtered before the reply");
  assert.equal(privateContext.selectionRedacted, true, "selection crossing a secret prevents Edit");
  assert.ok(privateContext.renderedText.includes("[redacted]"));
  assert.ok(!JSON.stringify(privateContext).includes("synthetic" + "value123"), "screen reply contains no raw secret");
  assert.deepEqual(await request("focusedFieldValue", fieldParams), { value: "password: [redacted]" }, "correction learning reply is filtered too");
  assert.deepEqual(await request("readScreen", { excludedAppIDs: ["VOICE-UI-FIXTURE.EXE"] }), { hidden: true }, "exclusion is exact and case insensitive, and says only that the screen is hidden");
  assert.deepEqual(await request("focusedFieldValue", { ...fieldParams, excludedAppIDs: ["voice-ui-fixture.exe"] }), { value: null });
  assert.ok(await request("readScreen", { excludedAppIDs: ["voice-ui-fixture"] }), "prefix does not exclude a different ID");
  // The main helper serves no screen reads, and the reader nothing else.
  assert.equal((await rawRequest(helper, "readScreen", { excludedAppIDs: [], excludedHosts: [] })).error?.message, "Windows native request failed", "the main helper reads no screen");
  for (const method of ["caretAnchor", "insert", "focusedFieldValue", "frontmostApp", "microphoneStart"])
    assert.equal((await rawRequest(reader, method, {})).error?.message, "Windows native request failed", `the screen reader does no ${method}`);
  const exits = [once(fixture.child, "exit"), once(helper.child, "exit"), once(reader.child, "exit")];
  fixture.child.stdin.end(); helper.child.stdin.end(); reader.child.stdin.end();
  for (const exit of exits) assert.deepEqual(await exit, [0, null]);
  assert.equal(fixture.errors(), "");
  const logged = (client) => client.errors().replaceAll("\r\n", "\n").replace(/^debug caret source: (text-pattern-caret|win32-edit-caret|accessible-caret|text-selection|focused-field-frame)\n/gmu, "");
  assert.equal(logged(helper), "debug caret lookup: protected-field\ndebug screen access: excluded app not read\n", "privacy refusals log only fixed categories");
  assert.equal(logged(reader), "debug screen access: excluded app not read\n", "the reader's privacy refusals log only fixed categories");
  process.stdout.write("Windows editable context, password, read-only, non-text and recovery checks passed\n");
} finally {
  clearTimeout(timeout);
  fixture.child.kill(); helper.child.kill(); reader.child.kill();
  fixture.lines.close(); helper.lines.close(); reader.lines.close();
}
