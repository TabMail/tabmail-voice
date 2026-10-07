// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { app, BrowserWindow, screen, clipboard } from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { once } from "node:events";

// This exercises Chromium's actual UIA provider in a normal Windows desktop
// session, rather than a classic Win32 fixture or mocked accessibility API.
assert.equal(process.platform, "win32");
assert.ok(process.argv[2], "pass the Windows helper executable path");
const privacyOnly = process.argv.includes("--privacy-only");
const coldActivation = process.argv.includes("--cold-activation");
if (!coldActivation) app.commandLine.appendSwitch("force-renderer-accessibility");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pending = new Map();
let id = 0;
let helper;
// The screen is read by voice-screen-reader.exe, a program of its own beside the helper.
let reader;
let readerErrors = "";
let activator;
let activatorErrors = "";
let lines;
let window;
let stderr = "";
let stage = "initialization";
const startedAt = Date.now();
function request(method, params = {}) {
  if (method === "readScreen" || method === "focusedFieldValue") params = { excludedAppIDs: [], excludedHosts: [], ...params };
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
function answer(line) {
  const message = JSON.parse(line);
  if (message.event) return;
  const resolve = pending.get(message.id);
  assert.ok(resolve, "reply matches a pending request");
  pending.delete(message.id);
  resolve(message);
}
async function focus(element, start = null, end = start) {
  await window.webContents.executeJavaScript(`(() => {
    const field = document.getElementById(${JSON.stringify(element)});
    field.focus();
    if (${start !== null}) field.setSelectionRange(${start}, ${end});
  })()`);
  await delay(150);
}
async function anchor(target, field = "editor", fieldFallback = false) {
  const physical = await request("caretAnchor", { window: target });
  assert.ok(physical, "focused editor exposes an anchor");
  const rect = screen.screenToDipRect(null, physical);
  const frame = await window.webContents.executeJavaScript(`(() => {
    const r = document.getElementById(${JSON.stringify(field)}).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  const content = window.getContentBounds();
  assert.ok(rect.x >= content.x + frame.x - 2 && rect.x <= content.x + frame.x + frame.width + 2, "anchor stays in the focused field horizontally");
  assert.ok(rect.y >= content.y + frame.y - 2 && rect.y + rect.height <= content.y + frame.y + frame.height + 2, "anchor stays in the focused field vertically");
  assert.ok(rect.height > 0 && rect.height <= (fieldFallback ? frame.height + 2 : 32), `nonempty text exposes text-sized geometry: ${JSON.stringify(rect)}`);
  return rect;
}
// The full matrix makes hundreds of separately bounded UIA calls; x64 runs
// under emulation on ARM64 developer VMs. Keep each request capped at four
// seconds while allowing the complete matrix two minutes.
const timeout = setTimeout(() => {
  process.stderr.write(`Windows Electron integration timed out at ${stage}; ${id} requests in ${Date.now() - startedAt} ms\n`);
  activator?.kill(); helper?.kill(); reader?.kill(); app.exit(1);
}, privacyOnly ? 60_000 : 120_000);
async function main() {
  try {
    await app.whenReady();
    helper = spawn(process.argv[2], [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    helper.on("error", (error) => { process.stderr.write(`${error.message}\n`); app.exit(1); });
    helper.stderr.on("data", (chunk) => { stderr += chunk; });
    lines = createInterface({ input: helper.stdout });
    lines.on("line", answer);
    reader = spawn(join(dirname(process.argv[2]), "voice-screen-reader.exe"), [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    reader.on("error", (error) => { process.stderr.write(`${error.message}\n`); app.exit(1); });
    reader.stderr.on("data", (chunk) => { readerErrors += chunk; });
    createInterface({ input: reader.stdout }).on("line", answer);
    if (coldActivation) {
      activator = spawn(process.argv[2], ["--accessibility-activator"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      activator.on("error", (error) => { process.stderr.write(`${error.message}\n`); app.exit(1); });
      activator.stderr.on("data", (chunk) => { activatorErrors += chunk; });
    }
    window = new BrowserWindow({ width: 800, height: 600, title: "Native editor integration test", webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <style>textarea,input,[contenteditable]{font:16px monospace}textarea{width:90%;height:80px}[contenteditable]{border:1px solid;padding:3px}</style>
      <h1>Unrelated heading outside focused field</h1>
      <textarea id="editor">Before selected after. 🙂</textarea>
      <div id="rich" contenteditable="true">Rich selected text.</div>
      <div id="paragraphs" contenteditable="true"><div>Hi All,</div><div><br></div><div>Why does it move?</div><div><br></div><div>--</div></div>
      <div id="wrapped" contenteditable="true" style="width:120px;word-break:break-all"><div>Hi,</div><div>https://example.com/a/link/longer/than/its/line</div></div>
      <div id="guarded" contenteditable="true">Guarded text <input type="password" value="synthetic-secret"></div>
      <input id="secret" type="password" value="synthetic-secret">
      <input id="readonly" readonly value="synthetic-readonly">
      <button id="button" aria-label="undrawn-button-secret">Non-text</button>
      <button aria-label="undrawn-icon-secret"><span aria-hidden="true">+</span></button>
      <p>Unrelated footer outside focused field</p>
      <div style="display:none">hidden-display-secret</div>
      <div style="position:fixed;top:-5000px">offscreen-secret</div>
      <div style="position:absolute;width:1px;height:1px;overflow:hidden">Screen-reader-only label</div>
      <a href="https://example.com">Visible link</a>
      <!-- Pieces of one line (a run of bold, a link), in the window's corner so nothing above moves. -->
      <div style="position:fixed;right:10px;bottom:10px;background:#fff"><p>Key sk-Review<b>Fixture1234567890</b> here</p><p>Visit <a href="#v">example</a> now</p><p>Read <a href="#r">more </a>now</p><p>Paste<a href="#k"> sk-ReviewLink1234567890abcd</a></p><p>Code sk-ReviewCode<code>Snippet1234567890</code> end</p></div>
      <!-- Below the window's height, so the checks of what the window shows above are not moved. -->
      <div id="plain" contenteditable="true">Synthetic first line<br>Synthetic second line<br><br><br>Synthetic fifth line<br>Synthetic sixth line</div>
      <div id="richParagraphs" contenteditable="true"><div>Synthetic first paragraph</div><div><br></div><div>Synthetic third paragraph</div><div>Synthetic fourth paragraph</div><div><br></div><div><br></div><div>Synthetic seventh paragraph</div></div>
      <div id="gmail" contenteditable="true">Synthetic opening line<div><br></div><div>Synthetic <b>line</b> to <i>dictate</i> under.</div><div><br><br>--<br>Synthetic signature</div></div>
    `)}`);
    window.show(); window.focus();
    const fixtureHandle = window.getNativeWindowHandle().readBigUInt64LE();
    // Consecutive GUI fixtures can briefly inherit the preceding process's
    // foreground transition. Establish our own window before testing providers;
    // frontmostApp reads only Win32 window metadata and does not warm UIA.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (BigInt((await request("frontmostApp")).window) === fixtureHandle) break;
      window.focus();
      await delay(50);
    }
    stage = "field and privacy checks";
    await focus("editor", 7, 15);
    // No accessibility override or preliminary caret/context request: the foreground
    // observer must initiate activation before the first dictation's native lookup.
    const { window: target } = await request("frontmostApp");
    assert.equal(BigInt(target), window.getNativeWindowHandle().readBigUInt64LE(), "fixture owns foreground focus before the accessibility assertions");
    // Dictation starts its context read while the overlay looks up the caret.
    // Both requests must complete; a busy rejection silently puts the overlay at the mouse.
    const [concurrentContext, concurrentCaret] = await Promise.all([
      request("readScreen"), request("caretAnchor", { window: target }),
    ]);
    assert.ok(concurrentContext?.renderedText.includes("Before"), "concurrent context read completes");
    assert.ok(concurrentCaret?.height > 0, "concurrent caret lookup completes");
    assert.deepEqual(await request("focusedFieldValue", { window: target, maxLength: 20_000 }), { value: "Before selected after. 🙂" });
    assert.deepEqual(await request("readScreen", { excludedHosts: ["data"] }), { hidden: true }, "page address excludes the whole screen before text is returned, and says only that it is hidden");
    assert.deepEqual(await request("focusedFieldValue", { window: target, maxLength: 20_000, excludedHosts: ["data"] }), { value: null }, "excluded page refuses correction learning");
    const context = await request("readScreen");
    assert.equal(context.host, "data", "nearest page host follows the Mac contract");
    assert.equal(context.textBeforeCaret, "Before ", "moving context backward does not escape into the page heading");
    assert.equal(context.selectedText, "selected");
    assert.equal(context.textAfterCaret, " after. 🙂", "context excludes adjacent fields and footer");
    assert.ok(context.renderedText.includes("Unrelated heading outside focused field"), "visible window heading is available outside the caret field");
    assert.ok(context.renderedText.includes("Unrelated footer outside focused field"), "visible window footer is available");
    assert.ok(context.renderedText.includes("» Before ‸selected‸ after. 🙂"), "focused field is marked at its position in the window");
    assert.ok(context.renderedText.includes("Non-text"), "a labeled web control retains its visible caption");
    // Pieces of one line on screen (a run of bold, a link) are read as that one line, with the
    // screen's spaces and none where they abut: a key split by bold is redacted whole.
    for (const line of ["Key [redacted] here", "Visit [example] now", "Read [more] now", "Paste [[redacted]]", "Code [redacted] end"])
      assert.ok(context.renderedText.split("\n").includes(line), `inline pieces are read as one line: ${line}`);
    assert.ok(!context.renderedText.includes("sk-Review") && !context.renderedText.includes("Fixture1234567890") && !context.renderedText.includes("Link1234567890abcd") && !context.renderedText.includes("Snippet1234567890"), "a key split by bold or code, or in a link, is redacted whole");
    // A box that shows nothing is walked into on every platform (owner, 2026-10-05; ADR-DESK-054), and
    // Chromium gives the text in it its own unclipped frame here, so a screen-reader-only label is read.
    assert.ok(context.renderedText.includes("Screen-reader-only label"), "a screen-reader-only label is read, as decided");
    for (const secret of ["synthetic-secret", "hidden-display-secret", "offscreen-secret", "undrawn-button-secret", "undrawn-icon-secret"]) {
      assert.ok(!context.renderedText.includes(secret), `password and hidden text never enter screen context: ${secret}`);
    }
    assert.ok(!context.summary.includes("Before") && !context.summary.includes("Unrelated"), "summary contains only sizes and timing");
    await anchor(target);
    await focus("editor", 0);
    const first = await anchor(target);
    await focus("editor", 15);
    const middle = await anchor(target);
    await focus("editor", 25);
    const endContext = await request("readScreen");
    assert.equal(endContext.textBeforeCaret, "Before selected after. 🙂");
    assert.equal(endContext.selectedText, "");
    assert.equal(endContext.textAfterCaret, "", "end selection does not include the following page node");
    const last = await anchor(target);
    assert.ok(first.x < middle.x && middle.x <= last.x, "collapsed caret follows insertion position");
    await focus("editor", 0, 25);
    const entire = await request("readScreen");
    assert.equal(entire.textBeforeCaret, "");
    assert.equal(entire.selectedText, "Before selected after. 🙂");
    assert.equal(entire.textAfterCaret, "", "full selection remains inside the focused field");
    await window.webContents.executeJavaScript('document.getElementById("editor").value = ""');
    await focus("editor", 0);
    assert.deepEqual(await request("focusedFieldValue", { window: target, maxLength: 20_000 }), { value: "" });
    const emptyContext = await request("readScreen");
    assert.equal(emptyContext.textBeforeCaret, "");
    assert.equal(emptyContext.selectedText, "");
    assert.equal(emptyContext.textAfterCaret, "");
    await anchor(target, "editor", true);
    // A real object replacement character must not be confused with an empty field.
    await window.webContents.executeJavaScript('document.getElementById("editor").value = "\\uFFFC"');
    await focus("editor", 0);
    assert.deepEqual(await request("focusedFieldValue", { window: target, maxLength: 20_000 }), { value: "\uFFFC" });
    await window.webContents.executeJavaScript('document.getElementById("editor").value = "First line\\nSecond 🙂"');
    await focus("editor", 0);
    const firstLine = await anchor(target);
    await focus("editor", 20);
    const secondLine = await anchor(target);
    assert.ok(secondLine.y > firstLine.y, "caret follows the focused line in a multiline field");
    assert.equal((await request("readScreen")).textAfterCaret, "");
    for (const field of ["secret", "readonly", "button"]) {
      await focus(field);
      assert.deepEqual(await request("focusedFieldValue", { window: target, maxLength: 20_000 }), field === "secret" ? { value: null } : null);
      const refusedContext = await request("readScreen");
      assert.ok(refusedContext && !refusedContext.renderedText.includes("synthetic-secret"), "noneditable focus retains safe visible window context");
      if (field === "secret") {
        assert.deepEqual([refusedContext.textBeforeCaret, refusedContext.selectedText, refusedContext.textAfterCaret], ["", "", ""]);
        assert.ok(refusedContext.renderedText.includes("» ‸"));
      }
      assert.equal(await request("caretAnchor", { window: target }), null);
    }
    // A page that has the focus itself is walked like any page; only what is selected in it is kept.
    await window.webContents.executeJavaScript(`(() => {
      document.activeElement.blur();
      getSelection().selectAllChildren(document.querySelector("h1"));
    })()`);
    await delay(150);
    const selectedPage = await request("readScreen");
    assert.equal(selectedPage.focusedRole, "control", "a page in focus is no field");
    assert.equal(selectedPage.host, "data", "a page in focus reports its host");
    assert.deepEqual([selectedPage.textBeforeCaret, selectedPage.selectedText, selectedPage.textAfterCaret],
      ["", "Unrelated heading outside focused field", ""], "a page in focus keeps its selection and no text around a caret");
    assert.ok(selectedPage.renderedText.includes("‸Unrelated heading outside focused field‸"), "the selection is marked in the read");
    assert.ok(selectedPage.renderedText.includes("Unrelated footer outside focused field") && !selectedPage.renderedText.includes("synthetic-secret"),
      "a page in focus is still walked, without its password field");
    await window.webContents.executeJavaScript("getSelection().removeAllRanges()");
    await delay(150);
    const plainPage = await request("readScreen");
    assert.equal(plainPage.selectedText, "");
    assert.ok(plainPage.renderedText.includes("Unrelated heading outside focused field") && !plainPage.renderedText.includes("‸"),
      "a page in focus with nothing selected is read without a caret block");
    // A selection that takes in the password field is not kept: a range that holds one is asked for no text.
    await window.webContents.executeJavaScript("getSelection().selectAllChildren(document.body)");
    await delay(150);
    const guardedPage = await request("readScreen");
    assert.equal(guardedPage.selectedText, "", "a selection over a password field is not kept");
    assert.ok(!guardedPage.renderedText.includes("‸") && guardedPage.renderedText.includes("Unrelated footer outside focused field") &&
      !JSON.stringify(guardedPage).includes("synthetic-secret"), "the page is still read, without that selection or the password");
    await window.webContents.executeJavaScript("getSelection().removeAllRanges()");
    // A field that can't be shown safe (it holds a password field) gives no caret text; the window is still read.
    await focus("guarded");
    const guarded = await request("readScreen");
    assert.ok(guarded, "a field that can't be shown safe still leaves the window read");
    assert.deepEqual([guarded.textBeforeCaret, guarded.selectedText, guarded.textAfterCaret], ["", "", ""], "no caret text is read from it");
    assert.ok(guarded.renderedText.includes("Unrelated heading outside focused field") &&
      !JSON.stringify(guarded).includes("synthetic-secret"), "the window around it is read, the password not");
    await focus("rich");
    assert.deepEqual(await request("focusedFieldValue", { window: target, maxLength: 20_000 }), { value: "Rich selected text." });
    const rich = await request("readScreen");
    assert.ok(rich && rich.renderedText.includes("Unrelated") && !rich.renderedText.includes("synthetic-secret"), "rich editor retains safe visible window context");
    assert.ok(!rich.textBeforeCaret.includes("Unrelated") && !rich.textAfterCaret.includes("Unrelated"), "rich caret text remains scoped to its field");
    await anchor(target, "rich");
    // A rich editor's paragraphs: IA2 gives each as an embedded object, not its text, so the field is
    // read through UI Automation. Its text leaves out the break before each paragraph that follows
    // text; the paragraphs say where they start, so each is a line of its own, as on the Mac.
    for (const [line, end, before] of [[3, false, "Hi All,\n\nWhy does it move?\n"], [1, false, "Hi All,\n"], [2, true, "Hi All,\n\nWhy does it move?"]]) {
      await window.webContents.executeJavaScript(`(() => {
        const field = document.getElementById("paragraphs"), line = field.children[${line}], range = document.createRange();
        field.focus();
        if (${end}) range.setStart(line.firstChild, line.firstChild.length); else range.setStart(line, 0);
        range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range);
      })()`);
      await delay(150);
      assert.deepEqual(await request("focusedFieldValue", { window: target, maxLength: 20_000 }), { value: "Hi All,\nWhy does it move?\n--" },
        "a rich editor's value is its text, not embedded objects");
      const paragraphs = await request("readScreen");
      assert.equal(paragraphs?.textBeforeCaret, before, `the text before a caret on line ${line} of a rich editor`);
      assert.ok(!JSON.stringify(paragraphs).includes("\uFFFC"), "no embedded-object placeholder is read");
    }
    // A word longer than its line wraps inside itself: the caret at the wrapped line's start starts no
    // paragraph, so no break is added.
    const wrap = await window.webContents.executeJavaScript(`(() => {
      const field = document.getElementById("wrapped"), text = field.children[1].firstChild, range = document.createRange();
      const top = (at) => { range.setStart(text, at); range.setEnd(text, at + 1); return range.getBoundingClientRect().top; };
      let at = 1;
      while (at < text.length && top(at) === top(0)) ++at;
      field.focus(); range.setStart(text, at); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range);
      return { at, text: text.data };
    })()`);
    assert.ok(wrap.at > 1 && wrap.at < wrap.text.length, "the fixture's word wraps");
    await delay(150);
    assert.equal((await request("readScreen"))?.textBeforeCaret, `Hi,\n${wrap.text.slice(0, wrap.at)}`, "a caret starting a soft-wrapped line gets no break");
    // The editors macos/Tests/electron.mjs reads around a caret: a plain-text body with empty lines,
    // a rich one with empty paragraphs and a Gmail-shaped draft (a line in several runs of text, then
    // a signature block that starts with two empty lines). Each paragraph is a line of its own.
    stage = "the Mac's caret reads";
    const lineFailures = [];
    for (const [name, field, script, before, after] of [
      ["plain text, second empty line", "plain", "getSelection().collapse(field, 5);",
        "Synthetic first line\nSynthetic second line\n\n", "\nSynthetic fifth line\nSynthetic sixth line"],
      ["rich text, second of two empty paragraphs", "richParagraphs", "getSelection().collapse(field.children[5], 0);",
        "Synthetic first paragraph\n\nSynthetic third paragraph\nSynthetic fourth paragraph\n\n", "\nSynthetic seventh paragraph"],
      ["rich text, start of a paragraph after another", "richParagraphs", "getSelection().collapse(field.children[3], 0);",
        "Synthetic first paragraph\n\nSynthetic third paragraph\n", "Synthetic fourth paragraph\n\n\nSynthetic seventh paragraph"],
      ["Gmail-shaped, empty line starting the signature block", "gmail", "getSelection().collapse(field.children[2], 0);",
        "Synthetic opening line\n\nSynthetic line to dictate under.\n", "\n\n--\nSynthetic signature"],
      ["Gmail-shaped, second empty line of the signature block", "gmail", "getSelection().collapse(field.children[2], 1);",
        "Synthetic opening line\n\nSynthetic line to dictate under.\n\n", "\n--\nSynthetic signature"],
      ["Gmail-shaped, end of the line dictated under", "gmail", "getSelection().collapse(field.children[1], field.children[1].childNodes.length);",
        "Synthetic opening line\n\nSynthetic line to dictate under.", "\n\n\n--\nSynthetic signature"],
      ["Gmail-shaped, before a bold word", "gmail", "getSelection().collapse(field.children[1].children[0].firstChild, 0);",
        "Synthetic opening line\n\nSynthetic ", "line to dictate under.\n\n\n--\nSynthetic signature"],
    ]) {
      await window.webContents.executeJavaScript(`(() => {
        const field = document.getElementById(${JSON.stringify(field)});
        field.focus();
        ${script}
      })()`);
      await delay(200);
      const read = await request("readScreen");
      if (read?.textBeforeCaret !== before || read?.textAfterCaret !== after)
        lineFailures.push(`${name}: read ${JSON.stringify({ before: read?.textBeforeCaret, after: read?.textAfterCaret })}, not ${JSON.stringify({ before, after })}`);
    }
    assert.deepEqual(lineFailures, [], "every paragraph is a line of its own around the caret");
    // Compare to the browser's rendered insertion point, not merely the field bounds.
    // A provider can report a plausible rectangle at the wrong end of the field.
    if (!privacyOnly) for (const [direction, text, width] of [
      ["ltr", "Synthetic caret", 300], ["rtl", "אבגד", 300],
      ["ltr", "abc אבגד xyz", 300], ["rtl", "אבגד abc הוז", 300],
      ["ltr", "Synthetic wrapped caret across several words", 160],
    ]) {
      await window.webContents.executeJavaScript(`(() => {
        const field = document.getElementById("rich");
        field.dir = ${JSON.stringify(direction)};
        field.style.width = ${JSON.stringify(width + "px")};
        field.textContent = ${JSON.stringify(text)};
        field.focus();
      })()`);
      await delay(500);
      for (const offset of Array.from({ length: text.length + 1 }, (_, index) => index)) {
        stage = `caret matrix ${direction}/${width}, offset ${offset}/${text.length}`;
        const expected = await window.webContents.executeJavaScript(`(() => {
          const field = document.getElementById("rich");
          const range = document.createRange();
          range.setStart(field.firstChild, ${offset}); range.collapse(true);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          return Array.from(range.getClientRects(), rect => ({
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          }));
        })()`);
        await delay(150);
        {
          assert.deepEqual(await request("focusedFieldValue", { window: target, maxLength: 20_000 }),
            { value: text }, `${direction} complete field value preserves logical text order`);
          const positionContext = await request("readScreen");
          assert.equal(positionContext?.textBeforeCaret, text.slice(0, offset),
            `${direction} provider selection begins at the DOM insertion point`);
          assert.equal(positionContext?.textAfterCaret, text.slice(offset),
            `${direction} provider selection belongs to the current field contents`);
        }
        const actual = await anchor(target, "rich");
        const content = window.getContentBounds();
        // A bidi boundary can expose two valid insertion positions. The union
        // returned by getBoundingClientRect loses that affinity information.
        assert.ok(expected.some(rect => rect.width <= 2 &&
          Math.abs(actual.x - content.x - rect.x) <= 3 &&
          Math.abs(actual.y - content.y - rect.y) <= 3),
          `${direction} caret at ${offset} matches a rendered insertion position: ${JSON.stringify({actual, expected, content})}`);
      }
    }
    stage = "insertion and shutdown";
    process.stdout.write(`Windows Electron field/context/caret/refusal/recovery checks passed after ${id} requests in ${Date.now() - startedAt} ms\n`);
    await window.webContents.executeJavaScript('document.getElementById("editor").value = "Before selected after. 🙂"');
    await focus("editor", 7, 15);
    await clipboard.writeText("Synthetic clipboard before insertion");
    assert.deepEqual(await request("insert", { window: target, text: "inserted", deadline: Date.now() + 2000 }), {});
    // The helper answers once the paste keys are sent; Chromium takes the paste when it handles them.
    const editorValue = () => window.webContents.executeJavaScript('document.getElementById("editor").value');
    for (const by = Date.now() + 4000; await editorValue() !== "Before inserted after. 🙂" && Date.now() < by;) await delay(20);
    assert.equal(await editorValue(), "Before inserted after. 🙂", "native paste replaces the actual Chromium selection");
    assert.equal(await clipboard.readText(), "inserted", "the text stays on the clipboard");
    const exited = [once(helper, "exit"), once(reader, "exit")]; helper.stdin.end(); reader.stdin.end();
    for (const exit of exited) assert.deepEqual(await exit, [0, null]);
    assert.equal(pending.size, 0);
    const logged = (text) => text.replaceAll("\r\n", "\n").replace(/^debug caret source: (text-pattern-caret|win32-edit-caret|accessible-caret|text-selection|focused-field-frame)\n/gmu, "").replace(/^debug accessible text: (protected or incomplete subtree|embedded objects, read by UI Automation)\n/gmu, "").replace(/^debug caret start: (paragraph [01], line [01]|paragraphs or lines unavailable|(\d+|no) block starts near the caret; the caret (ends a line|starts its text))\n/gmu, "").replace(/^debug aggregate text refused: (protected descendant|time budget|incomplete census)\n/gmu, "").replace(/^debug paste stage: (focus-check|clipboard-open|final-focus-check|clipboard-write|send-input|complete)\n/gmu, "");
    assert.equal(logged(stderr), "debug screen access: excluded or unknown page not read\ndebug caret lookup: protected-field\ndebug caret lookup: ineligible-focused-element\ndebug caret lookup: no-caret-geometry\n", "refusals log categories without exposing focused content");
    assert.equal(logged(readerErrors), "debug screen access: excluded or unknown page not read\n", "the reader's refusals log categories without exposing focused content");
    process.stdout.write("Windows Electron field/context/caret/insertion/refusal/recovery checks passed\n");
    if (activator) {
      const stopped = once(activator, "exit"); activator.stdin.end();
      assert.deepEqual(await stopped, [0, null], "activator stops on parent EOF");
      assert.ok(!activatorErrors.includes("error "), "activator configured its UIA client and foreground hook");
      assert.ok(activatorErrors.split(/\r?\n/u).filter(Boolean).every((line) => /^debug accessibility warmup: (provider-unavailable|no-focused-element)$/u.test(line)), "activation logs contain only fixed categories");
    }
    app.quit();
  } catch (error) {
    process.stderr.write(stderr);
    process.stderr.write(readerErrors);
    process.stderr.write(`${error.stack}\n`);
    app.exit(1);
  } finally {
    clearTimeout(timeout); activator?.kill(); helper?.kill(); reader?.kill(); lines?.close();
  }

}
// Allow Electron to finish loading its entry module before waiting for ready.
void main();
