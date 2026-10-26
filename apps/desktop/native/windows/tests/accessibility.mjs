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
// The screen is read by voice-screen-reader.exe and the focused field by voice-field-reader.exe,
// programs of their own beside the helper.
const reader = client(join(dirname(process.argv[2]), "voice-screen-reader.exe"));
const fieldReader = client(join(dirname(process.argv[2]), "voice-field-reader.exe"));
let id = 0;
let stage = "fixture startup";
async function request(method, params = {}, expectError = false) {
  if (method === "readScreen" || method === "focusedFieldValue") params = { excludedAppIDs: [], excludedHosts: [], ...params };
  stage = method;
  id += 1;
  const target = method === "readScreen" ? reader : method === "focusedFieldValue" ? fieldReader : helper;
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
  fixture.child.kill(); helper.child.kill(); reader.child.kill(); fieldReader.child.kill();
  process.stderr.write(`Windows UI Automation integration timed out at ${stage}; ${fixture.errors()}${helper.errors()}${reader.errors()}${fieldReader.errors()}\n`);
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
  const protectedWhole = await request("readScreen", { wholeWindow: true });
  assert.ok(protectedWhole.renderedText.includes("» ‸"), "reading the whole window, a protected focus is still only the caret marker");
  assert.ok(!JSON.stringify(protectedWhole).includes("Before selected after."), "reading the whole window, the password value never enters the reply");
  assert.equal(await request("caretAnchor", { window }), null, "password caret is refused");
  await mode("readOnly");
  assert.equal(await request("focusedFieldValue", fieldParams), null, "read-only learning is refused");
  assert.ok(await request("readScreen"), "read-only focus still permits visible window context");
  await mode("button");
  assert.equal(await request("focusedFieldValue", fieldParams), null, "non-text learning is refused");
  // A classic edit control has no text pattern: out of focus, it is read by its value, whole as
  // it is short, in both scopes.
  const unfocused = await request("readScreen");
  assert.ok(unfocused.renderedText.includes("> Before selected after."), "non-text focus still permits visible window context, its field read by value");
  assert.ok((await request("readScreen", { wholeWindow: true })).renderedText.includes("> Before selected after."), "the whole window reads a field out of focus by value");
  await mode("editable");
  assert.equal((await request("readScreen")).selectedText, "selected", "refusal does not poison subsequent reads");
  // Reading the whole window, the focused field is read whole like any field, just after the caret
  // block that marks it; none of the caret's text is sent apart from it, the selection included.
  const whole = await request("readScreen", { wholeWindow: true });
  assert.deepEqual([whole.textBeforeCaret, whole.selectedText, whole.textAfterCaret], ["", "", ""], "the whole window keeps none of the caret's text");
  assert.ok(whole.renderedText.includes("> Before selected after."), "the whole window reads the focused field whole");
  assert.ok(whole.renderedText.indexOf("» ‸") >= 0 && whole.renderedText.indexOf("» ‸") < whole.renderedText.indexOf("> Before selected after."), "the caret block marks the field just before it");
  // A whole-window read bound to an earlier read (`sameWindowAs`) reads that read's window only
  // while that read is the last one numbered and its window is in front; else null.
  const restarted = client(join(dirname(process.argv[2]), "voice-screen-reader.exe"));
  const unbound = await rawRequest(restarted, "readScreen", { excludedAppIDs: [], excludedHosts: [], read: 1, wholeWindow: true, sameWindowAs: 1 });
  assert.deepEqual(unbound, { id, result: null }, "a reader that has read nothing yet (a restarted one) reads no bound window");
  const restartedExit = once(restarted.child, "exit");
  restarted.child.stdin.end();
  assert.deepEqual(await restartedExit, [0, null]);
  assert.equal(restarted.errors(), "", "a bound read refused reads nothing, so logs nothing");
  assert.ok(await request("readScreen", { read: 1 }), "the first read");
  assert.ok((await request("readScreen", { read: 2, wholeWindow: true, sameWindowAs: 1 })).renderedText.includes("> Before selected after."), "the same window, still in front, is read");
  assert.equal(await request("readScreen", { read: 3, wholeWindow: true, sameWindowAs: 1 }), null, "a read bound to one that is no longer the last numbered is not read");
  assert.ok(await request("readScreen", { read: 4 }), "a newer first read");
  const captured = await request("captureTarget");
  assert.equal(captured.window, window, "capture retains the exact original HWND");
  await mode("second");
  const background = await request("readScreen", { target: captured, read: 40 });
  assert.ok(background?.renderedText.includes("Before selected after."), "a captured background window is read");
  assert.ok((await request("readScreen", { target: captured, read: 41, wholeWindow: true, sameWindowAs: 40 }))?.renderedText.includes("Before selected after."), "the whole read stays on the captured background window");
  // Restore the legacy binding independently of the explicitly targeted reads above.
  await mode("editable");
  assert.ok(await request("readScreen", { read: 4 }));
  await mode("second");
  assert.equal(await request("readScreen", { read: 5, wholeWindow: true, sameWindowAs: 4 }), null, "another window of the app in front is not read in its place");
  await mode("editable");
  assert.ok(await request("readScreen", { read: 6, wholeWindow: true, sameWindowAs: 4 }), "the read's window back in front is read; the refused read did not become the last");
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
  // The field reader reads the window the main helper names, the paste's own target, by its handle.
  const front = await request("frontmostApp");
  assert.deepEqual(await request("focusedFieldValue", { ...fieldParams, window: front.window }), { value: "password: [redacted]" }, "the field reader reads the main helper's window");
  // The main helper reads neither the screen nor the field, and each reader nothing else.
  assert.equal((await rawRequest(helper, "readScreen", { excludedAppIDs: [], excludedHosts: [] })).error?.message, "Windows native request failed", "the main helper reads no screen");
  assert.equal((await rawRequest(helper, "focusedFieldValue", { ...fieldParams, excludedAppIDs: [], excludedHosts: [] })).error?.message, "Windows native request failed", "the main helper reads no field");
  for (const method of ["caretAnchor", "insert", "focusedFieldValue", "frontmostApp", "microphoneStart"])
    assert.equal((await rawRequest(reader, method, {})).error?.message, "Windows native request failed", `the screen reader does no ${method}`);
  for (const method of ["caretAnchor", "insert", "readScreen", "frontmostApp", "microphoneStart"])
    assert.equal((await rawRequest(fieldReader, method, {})).error?.message, "Windows native request failed", `the field reader does no ${method}`);
  const exits = [once(fixture.child, "exit"), once(helper.child, "exit"), once(reader.child, "exit"), once(fieldReader.child, "exit")];
  fixture.child.stdin.end(); helper.child.stdin.end(); reader.child.stdin.end(); fieldReader.child.stdin.end();
  for (const exit of exits) assert.deepEqual(await exit, [0, null]);
  assert.equal(fixture.errors(), "");
  // Debug-only failure reasons are fixed phrases; anything else in the log fails these checks.
  const logged = (client) => client.errors().replaceAll("\r\n", "\n").replace(/^debug caret source: (text-pattern-caret|win32-edit-caret|accessible-caret|text-selection|focused-field-frame)\n/gmu, "")
    .replace(/^debug focusedFieldValue failed after \d+ms: shared core refused\n/gmu, "");
  assert.equal(logged(helper), "debug caret lookup: protected-field\n", "privacy refusals log only fixed categories");
  assert.equal(logged(reader), "debug screen access: excluded app not read\n", "the reader's privacy refusals log only fixed categories");
  assert.equal(logged(fieldReader), "debug screen access: excluded app not read\n", "the field reader's privacy refusals log only fixed categories");
  process.stdout.write("Windows editable context, password, read-only, non-text and recovery checks passed\n");
} finally {
  clearTimeout(timeout);
  fixture.child.kill(); helper.child.kill(); reader.child.kill(); fieldReader.child.kill();
  fixture.lines.close(); helper.lines.close(); reader.lines.close(); fieldReader.lines.close();
}
