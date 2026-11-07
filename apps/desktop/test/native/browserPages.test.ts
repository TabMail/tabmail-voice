// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { anchorTolerance, browserNames, checkAnchors, checkField, checkIdentity, checkScreen, knownFailures, sometimesFailing, verdict, type PageReport } from "../../native/shared/browser-pages/checks.mjs";
import { cases, lines, pageLines, type Case } from "../../native/shared/browser-pages/document.mjs";

const pages = join(__dirname, "../../native/shared/browser-pages");
const read = (name: string) => readFileSync(join(pages, name), "utf8");

/** The real browser-page tests (`native/shared/browser-pages/run.mjs`) run in the Linux and Windows
 * test machines; these check, here, the documents and carets they use and how they judge a read. */
describe("the browser test pages", () => {
  test("each page's carets sit where their names say, between two lines, on a long page past 300 lines", () => {
    expect(pageLines.long).toBeGreaterThan(300);
    for (const page of ["codemirror", "compose"] as const) {
      const all = cases(page);
      expect(all.map(({ name }) => name)).toEqual(["empty-line", "line-start", "mid-line", "line-end", "selection", "long-empty-line", "long-mid-line"]);
      for (const { name, size, line, from, to } of all) {
        const text = lines(page, size);
        expect(line, name).toBeGreaterThan(0);
        expect(line, name).toBeLessThan(text.length - 1);
        // A long page's carets are far down it, past the first 300 lines; a short page's within it.
        if (size === "long") expect(line, name).toBeGreaterThanOrEqual(300);
        else expect(line, name).toBeLessThan(pageLines.short);
        const here = text[line] ?? "";
        if (name.endsWith("empty-line")) expect(here, name).toBe("");
        if (name === "line-start") expect([from, to]).toEqual([0, 0]);
        if (name === "line-end") expect([from, to]).toEqual([here.length, here.length]);
        if (name.endsWith("mid-line")) expect(from > 0 && from === to && from < here.length, name).toBe(true);
        if (name === "selection") expect(here.slice(from, to)).toBe("bold words");
      }
    }
  });

  test("lines have no spaces a read could fold, and a long mail page is a field the reader answers whole", () => {
    for (const page of ["codemirror", "compose"] as const) {
      for (const line of lines(page, "long")) expect(line).toBe(line.trim().replace(/ {2,}/g, " "));
    }
    // focusedFieldValue answers at most 20,000 UTF-16 units, as the app asks it.
    expect(lines("compose", "long").join("\n").length).toBeLessThan(20_000);
  });

  const text = ["Line 10", "Line 11 has bold words here.", "Line 12"];
  const at = (from: number, to = from): Case => ({ name: "case", size: "short", line: 1, from, to });

  test("a caret context is right only with the line before, the line's text to the caret, the selection and the rest", () => {
    const right = { textBeforeCaret: "Line 9\nLine 10\nLine 11 has ", selectedText: "", textAfterCaret: "bold words here.\nLine 12" };
    expect(checkScreen(text, at(12), right)).toEqual([]);
    expect(checkScreen(text, at(12, 22), { ...right, selectedText: "bold words", textAfterCaret: " here.\nLine 12" })).toEqual([]);
    expect(checkScreen(text, at(0), { textBeforeCaret: "Line 10\n", selectedText: "", textAfterCaret: "Line 11 has bold words here.\nLine 12" })).toEqual([]);
    // A caret at a line's start read as following the line before (#355's stray space), or after a space.
    expect(checkScreen(text, at(0), { textBeforeCaret: "Line 10", selectedText: "", textAfterCaret: "Line 11 has bold words here.\nLine 12" })).toHaveLength(1);
    expect(checkScreen(text, at(0), { textBeforeCaret: "Line 10\n ", selectedText: "", textAfterCaret: "Line 11 has bold words here.\nLine 12" })).toHaveLength(1);
    expect(checkScreen(text, at(12), { ...right, selectedText: "b" })).toHaveLength(1);
    expect(checkScreen(text, at(12), { ...right, textAfterCaret: "bold words here. Line 12" })).toHaveLength(1);
    expect(checkScreen(text, at(12), { ...right, textAfterCaret: undefined })).toHaveLength(1);
    expect(checkScreen(text, at(12), null)).toEqual(["no caret context"]);
  });

  test("a field's value is right when it holds the caret's line between its neighbours", () => {
    expect(checkField(text, at(0), { value: `Line 9\n${text.join("\n")}\nLine 13` })).toEqual([]);
    expect(checkField(text, at(0), { value: text.join(" ") })).toHaveLength(1);
    expect(checkField(text, at(0), { value: null })).toEqual(["no field value"]);
    expect(checkField(text, at(0), null)).toEqual(["no field value"]);
  });

  const report = (x: number, y: number, scale = 1): PageReport => ({ selected: "", caret: { x, y, height: 16 }, scale, screen: { x: 100, y: 50, frameX: 0, frameY: 80 } });

  test("caret anchors are right when each sits where the page drew its caret, as far from it as the others", () => {
    // Content at (100, 130) on the screen; at scale 2 every screen pixel is two.
    const anchors = [
      { name: "a", report: report(10, 20), anchor: { x: 110, y: 150, height: 16 } },
      { name: "b", report: report(200, 400), anchor: { x: 300, y: 530, height: 18 } },
    ];
    expect(checkAnchors(anchors, { onScreen: true })).toEqual([]);
    expect(checkAnchors([{ name: "a", report: report(10, 20, 2), anchor: { x: 220, y: 300, height: 32 } }], { onScreen: true })).toEqual([]);
    const off = anchorTolerance.between + 1;
    expect(checkAnchors([...anchors, { name: "c", report: report(0, 0), anchor: { x: 100, y: 130 + off, height: 16 } }], { onScreen: false }).map(({ name }) => name)).toEqual(["c"]);
    // Off the screen place, but consistent: wrong only where the page knows its place.
    const shifted = anchors.map((each) => ({ ...each, anchor: { ...each.anchor, y: each.anchor.y + anchorTolerance.onScreen + 1 } }));
    expect(checkAnchors(shifted, { onScreen: false })).toEqual([]);
    expect(checkAnchors(shifted, { onScreen: true }).map(({ name }) => name)).toEqual(["a", "b"]);
    expect(checkAnchors([{ name: "a", report: report(10, 20), anchor: null }], { onScreen: false })).toEqual([{ name: "a", why: "no caret anchor" }]);
    expect(checkAnchors([{ name: "a", report: report(10, 20), anchor: { x: 110, y: 150, height: 40 } }], { onScreen: false })).toHaveLength(1);
    expect(checkAnchors([{ name: "a", report: report(10, 20), anchor: { x: 110, y: 150, height: 7 } }], { onScreen: false })).toHaveLength(1);
  });

  test("an anchor off only sideways is wrong, and a scaled page's anchors are judged in screen pixels", () => {
    const right = { name: "a", report: report(10, 20), anchor: { x: 110, y: 150, height: 16 } };
    expect(checkAnchors([{ ...right, anchor: { ...right.anchor, x: 110 + anchorTolerance.onScreen + 1 } }], { onScreen: true })).toHaveLength(1);
    expect(checkAnchors([{ ...right, anchor: { ...right.anchor, x: 110 + anchorTolerance.onScreen } }], { onScreen: true })).toEqual([]);
    const sideways = { name: "c", report: report(200, 20), anchor: { x: 300 + anchorTolerance.between + 1, y: 150, height: 16 } };
    expect(checkAnchors([right, sideways], { onScreen: false }).map(({ name }) => name)).toEqual(["c"]);
    expect(checkAnchors([right, { ...sideways, anchor: { ...sideways.anchor, x: 300 + anchorTolerance.between } }], { onScreen: false })).toEqual([]);
    // At scale 2 the content is at (200, 260) on the screen and a caret at (300, 400) at (800, 1060), twice as high;
    // at scale 3 a caret 16 high is 48 on the screen.
    const scaled = [
      { name: "a", report: report(300, 400, 2), anchor: { x: 800, y: 1060, height: 32 } },
      { name: "b", report: report(10, 20, 2), anchor: { x: 220, y: 300, height: 32 } },
    ];
    expect(checkAnchors(scaled, { onScreen: true })).toEqual([]);
    expect(checkAnchors(scaled, { onScreen: false })).toEqual([]);
    expect(checkAnchors([{ ...scaled[0]!, anchor: { x: 800, y: 1060 - 400, height: 32 } }], { onScreen: true })).toHaveLength(1);
    expect(checkAnchors([{ name: "a", report: report(10, 20, 3), anchor: { x: 330, y: 450, height: 72 } }], { onScreen: true })).toEqual([]);
    expect(checkAnchors([{ name: "a", report: report(10, 20, 3), anchor: { x: 330, y: 450, height: 150 } }], { onScreen: true })).toHaveLength(1);
    // A window's side border (Windows) puts its content further right: at scale 2, 20 pixels each side are 40 on the screen.
    const framed = { ...report(10, 20, 2), screen: { x: 100, y: 50, frameX: 20, frameY: 80 } };
    expect(checkAnchors([{ name: "a", report: framed, anchor: { x: 260, y: 300, height: 32 } }], { onScreen: true })).toEqual([]);
    expect(checkAnchors([{ name: "a", report: framed, anchor: { x: 220, y: 300, height: 32 } }], { onScreen: true })).toHaveLength(1);
  });

  test("a selection's anchor is right at either of its ends, on its line, and wrong between them", () => {
    const caret = { name: "a", report: report(10, 20), anchor: { x: 110, y: 150, height: 16 } };
    // The bold words selected from x 100 to x 200 of the line at y 20.
    const selection = (x: number, y = 150) => ({ name: "s", report: { ...report(200, 20), start: { x: 100, y: 20, height: 16 } }, anchor: { x, y, height: 16 } });
    for (const onScreen of [false, true]) {
      expect(checkAnchors([caret, selection(300)], { onScreen }), "at its end").toEqual([]);
      expect(checkAnchors([caret, selection(200)], { onScreen }), "at its start").toEqual([]);
      const wrong = (x: number, y?: number) => [...new Set(checkAnchors([caret, selection(x, y)], { onScreen }).map(({ name }) => name))];
      expect(wrong(250), "between").toEqual(["s"]);
      expect(wrong(300, 170), "on the next line").toEqual(["s"]);
    }
    // Read first, with nothing yet to place the page, a selection's anchor is judged at its end.
    expect(checkAnchors([selection(300), { ...caret, anchor: { ...caret.anchor, x: 110 } }], { onScreen: false })).toEqual([]);
    expect(checkAnchors([selection(200), caret], { onScreen: false }).map(({ name }) => name)).toEqual(["a"]);
  });

  test("a read recorded as failing is known while it fails, and fails the run once it passes", () => {
    // A read no table lists, recorded on Linux only for the test.
    const unlisted = "testbrowser compose long-mid-line readScreen";
    expect(knownFailures.linux?.[unlisted]).toBeUndefined();
    expect(knownFailures.win32?.[unlisted]).toBeUndefined();
    const linux = knownFailures.linux ?? {};
    linux[unlisted] = 361;
    try {
      expect(verdict("linux", unlisted, ["wrong"])).toBe("known");
      expect(verdict("linux", unlisted, [])).toBe("fixed");
      expect(verdict("win32", unlisted, ["wrong"])).toBe("fail");
      expect(verdict("win32", unlisted, [])).toBe("pass");
      // Under an issue whose reads fail in some runs only, a read that passes passes the run.
      const [sometimes] = [...sometimesFailing];
      linux[unlisted] = sometimes ?? 0;
      expect(verdict("linux", unlisted, ["timed out"])).toBe("known");
      expect(verdict("linux", unlisted, [])).toBe("pass");
    } finally {
      delete linux[unlisted];
    }
  });

  /** A recorded read with a misspelt name would never be matched, so it would neither be known nor
   * fail the run once fixed: every one names a read the driver makes, of a browser, page and case.
   * A page that fails whole is not a read: it is never recorded, so it always fails the run. */
  test("every read recorded as failing is one the driver makes", () => {
    const reads = new Set(Object.keys(browserNames).flatMap((browser) => (["codemirror", "compose"] as const).flatMap((page) => [
      ...(["short", "long"] as const).map((size) => `${browser} ${page} ${size}-document identity`),
      ...cases(page).flatMap(({ name }) => ["readScreen", "focusedFieldValue", "caretAnchor"].map((kind) => `${browser} ${page} ${name} ${kind}`)),
    ])));
    expect(Object.keys(knownFailures).sort()).toEqual(["linux", "win32"]);
    for (const [system, recorded] of Object.entries(knownFailures)) {
      expect(Object.keys(recorded).length, system).toBeGreaterThan(0);
      for (const [name, issue] of Object.entries(recorded)) {
        expect(reads.has(name), `${system}: ${name}`).toBe(true);
        expect(Number.isInteger(issue) && issue > 0, `${system}: ${name}`).toBe(true);
      }
    }
    // The issues whose reads fail in some runs only are #381 and #390, reads that run out their time; each
    // has reads recorded under it. Another issue's read that passes is a fix, and fails the run.
    const recorded = new Set(Object.values(knownFailures).flatMap((each) => Object.values(each)));
    expect([...sometimesFailing]).toEqual([381, 390]);
    for (const issue of sometimesFailing) expect(recorded.has(issue), `#${issue}`).toBe(true);
  });

  test("a screen read names the browser asked for, Chromium as chrome", () => {
    expect(checkIdentity("firefox", { bundleID: "firefox_firefox.desktop", appName: "Firefox" })).toEqual([]);
    expect(checkIdentity("chrome", { bundleID: "chromium_chromium.desktop", appName: "Chromium" })).toEqual([]);
    expect(checkIdentity("chrome", { bundleID: "chrome.exe", appName: "Google Chrome" })).toEqual([]);
    expect(checkIdentity("edge", { bundleID: "msedge.exe", appName: "Microsoft Edge" })).toEqual([]);
    expect(checkIdentity("chrome", { bundleID: "", appName: "Unknown" })).toHaveLength(1);
    expect(checkIdentity("firefox", { bundleID: "chromium_chromium.desktop", appName: "Chromium" })).toHaveLength(1);
    expect(checkIdentity("firefox", null)).toEqual(["no screen read"]);
  });

  test("the driver serves every file the pages load, and nothing else", () => {
    const served = /const files = new Set\((\[[^\]]*\])\)/.exec(read("run.mjs"))?.[1];
    const files = new Set(JSON.parse(served ?? "[]") as string[]);
    const loaded = new Set<string>();
    const pending = ["codemirror.html", "compose.html"];
    for (let name = pending.pop(); name; name = pending.pop()) {
      loaded.add(name);
      for (const [, next] of read(name).matchAll(/(?:src="|from ")\.?\/?([\w.-]+)"/g)) if (next && !loaded.has(next)) pending.push(next);
    }
    expect(files).toEqual(loaded);
  });

  test("the code editor's bundle is built from the CodeMirror packages installed, with their licences", () => {
    const bundle = read("codemirror.js");
    const packages = JSON.parse(/^\/\/ packages: (\{.*\})$/m.exec(bundle)?.[1] ?? "{}") as Record<string, string>;
    const lock = JSON.parse(readFileSync(join(__dirname, "../../package-lock.json"), "utf8")) as { packages: Record<string, { version: string }> };
    const direct = (JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies;
    expect(Object.keys(direct).filter((name) => name.startsWith("@codemirror/")).every((name) => name in packages)).toBe(true);
    expect(Object.keys(packages).length).toBeGreaterThan(4);
    for (const [name, version] of Object.entries(packages)) {
      expect(lock.packages[`node_modules/${name}`]?.version, `${name}: run node scripts/browser-pages.mts`).toBe(version);
      expect(bundle).toContain(`${name}:\n\n`);
    }
  });
});
