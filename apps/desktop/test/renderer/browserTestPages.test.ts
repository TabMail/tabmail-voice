// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cases, lines, pageLines, type Size } from "../../native/shared/browser-pages/document.mjs";
import type { Editor } from "../../native/shared/browser-pages/harness.mjs";

afterEach(() => {
  vi.doUnmock("../../native/shared/browser-pages/harness.mjs");
  vi.resetModules();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

/** The page opened at its size, as the driver names it in the page's address. */
function open(size: Size) {
  history.replaceState(null, "", `/page.html?size=${size}`);
}

/** Loads a page's script with `serve` stood in for, and gives the editor it serves. */
async function load(script: string): Promise<Editor> {
  let served: Editor | null = null;
  vi.doMock("../../native/shared/browser-pages/harness.mjs", () => ({ serve: (editor: Editor) => { served = editor; return Promise.resolve(); } }));
  await import(/* @vite-ignore */ `../../native/shared/browser-pages/${script}`);
  if (!served) throw new Error(`${script} served no editor`);
  return served;
}

describe("the page's side of the driver", () => {
  test("says it is ready, then for each caret takes the focus from the editor, puts the caret, and reports where it drew it", async () => {
    const events: string[] = [];
    const commands = [{ kind: "select", line: 3, from: 2, to: 6 }, { kind: "done" }];
    const reports: unknown[] = [];
    // Each frame the page waits for is recorded where it waits.
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(() => { events.push("frame"); callback(); }, 0));
    // A scaled screen, the window off its corner, with a border each side and a title bar.
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("screenX", 300);
    vi.stubGlobal("screenY", 40);
    vi.stubGlobal("outerWidth", 1016);
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("outerHeight", 900);
    vi.stubGlobal("innerHeight", 820);
    vi.stubGlobal("fetch", (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/report" && init?.method === "POST") {
        events.push("report");
        reports.push(JSON.parse(init.body ?? "null"));
        return Promise.resolve({});
      }
      if (url === "/command") return Promise.resolve({ json: () => Promise.resolve(commands.shift()) });
      throw new Error(`asked ${url}`);
    });
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    field.addEventListener("blur", () => events.push("blur"));
    const { serve } = await import("../../native/shared/browser-pages/harness.mjs");
    await serve({
      select: (line: number, from: number, to: number) => { events.push(`select ${line} ${from} ${to}`); },
      caret: () => { events.push("caret"); return { x: 40, y: 60, height: 16, width: 1 }; },
      start: () => ({ x: 8, y: 60, height: 16 }),
      selected: () => "text",
    });
    // Two frames after the focus goes, so the editor takes it afresh, and two after the caret is put, so it is drawn.
    expect(events).toEqual(["report", "blur", "frame", "frame", "select 3 2 6", "frame", "frame", "caret", "report"]);
    expect(reports[0]).toEqual({ ready: true });
    expect(reports[1]).toEqual({
      selected: "text",
      caret: { x: 40, y: 60, height: 16 },
      start: { x: 8, y: 60, height: 16 },
      scale: 2,
      screen: { x: 300, y: 40, frameX: 8, frameY: 80 },
    });
  });
});

describe("the mail page", () => {
  test.each(["short", "long"] as const)("selects each case's text in its line of the %s page, with the editor focused and the line scrolled to the middle", async (size) => {
    open(size);
    document.body.innerHTML = '<div id="body" contenteditable="true"></div>';
    const scrolled: [string, unknown][] = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) { scrolled.push([this.textContent ?? "", options]); });
    const editor = await load("compose.mjs");
    const body = document.getElementById("body");
    expect(body?.children).toHaveLength(pageLines[size] + 1);
    // A line of text holds its bold words in a run of their own, an empty line only a line break.
    expect(body?.children[11]?.querySelector("b")?.textContent).toBe("bold words");
    expect(body?.children[13]?.innerHTML).toBe("<br>");
    const text = lines("compose", size);
    for (const { name, line, from, to } of cases("compose").filter((each) => each.size === size)) {
      scrolled.length = 0;
      editor.select(line, from, to);
      expect(editor.selected(), name).toBe((text[line] ?? "").slice(from, to));
      const range = getSelection()?.getRangeAt(0);
      expect(range && body?.children[line]?.contains(range.startContainer), name).toBe(true);
      expect(range?.toString(), name).toBe((text[line] ?? "").slice(from, to));
      expect(document.activeElement, name).toBe(body);
      expect(scrolled, name).toEqual([[text[line], { block: "center" }]]);
    }
  });

  test("gives the caret's rectangle at the selection's end, and its start's", async () => {
    document.body.innerHTML = '<div id="body" contenteditable="true"></div>';
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    // happy-dom lays nothing out: a collapsed range's rectangle stands for its text and offset.
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
      return [{ x: this.startOffset, y: this.startContainer.textContent?.length ?? 0, height: 16 }] as unknown as DOMRectList;
    });
    const editor = await load("compose.mjs");
    const selection = cases("compose").find(({ name }) => name === "selection");
    editor.select(selection?.line ?? 0, selection?.from ?? 0, selection?.to ?? 0);
    // The selection is the bold run whole: it ends ten characters into that run, and starts at the end of the text before it.
    const before = "Synthetic note 11 with ";
    expect(editor.caret()).toEqual({ x: "bold words".length, y: "bold words".length, height: 16 });
    expect(editor.start()).toEqual({ x: before.length, y: before.length, height: 16 });
  });

  test("gives a caret on an empty line, which has no rectangle of its own, its line's", async () => {
    document.body.innerHTML = '<div id="body" contenteditable="true"></div>';
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [] as unknown as DOMRectList);
    const editor = await load("compose.mjs");
    const body = document.getElementById("body");
    const empty = cases("compose").find(({ name }) => name === "empty-line");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return (this === body?.children[empty?.line ?? -1] ? { x: 5, y: 7, height: 20 } : { x: -1, y: -1, height: 0 }) as DOMRect;
    });
    editor.select(empty?.line ?? 0, empty?.from ?? 0, empty?.to ?? 0);
    expect(editor.caret()).toEqual({ x: 5, y: 7, height: 20 });
    expect(editor.start()).toEqual({ x: 5, y: 7, height: 20 });
  });
});

describe("the code editor page", () => {
  test.each(["short", "long"] as const)("selects each case's text in its line of the %s page, with the editor focused and the selection's end scrolled to the middle", async (size) => {
    open(size);
    // A browser tells the page of a selection's change after the change, as a queued event; happy-dom
    // tells it at once, inside CodeMirror's own update, which CodeMirror refuses.
    const dispatch = document.dispatchEvent.bind(document);
    vi.spyOn(document, "dispatchEvent").mockImplementation((event: Event) => {
      if (event.type !== "selectionchange") return dispatch(event);
      setTimeout(() => dispatch(event), 0);
      return true;
    });
    // The bundle is generated JavaScript, with no types of its own: CodeMirror's.
    const bundle: string = "../../native/shared/browser-pages/codemirror.js";
    const { EditorView } = (await import(/* @vite-ignore */ bundle)) as typeof import("@codemirror/view");
    const scrolls = vi.spyOn(EditorView, "scrollIntoView");
    const editor = await load("codemirror-page.mjs");
    // The text is LaTeX, drawn highlighted: its commands in runs of a highlighting style's own class.
    expect([...document.querySelectorAll(".cm-line span")].some((run) => /ͼ/.test(run.className))).toBe(true);
    const text = lines("codemirror", size);
    for (const { name, line, from, to } of cases("codemirror").filter((each) => each.size === size)) {
      scrolls.mockClear();
      editor.select(line, from, to);
      expect(editor.selected(), name).toBe((text[line] ?? "").slice(from, to));
      // The selection's end, as an offset in the document: every line before it and its break.
      const start = text.slice(0, line).reduce((sum, each) => sum + each.length + 1, 0);
      expect(scrolls.mock.calls, name).toEqual([[start + to, { y: "center" }]]);
      expect(document.activeElement?.closest(".cm-editor"), name).not.toBeNull();
      // happy-dom lays nothing out: a position's rectangle stands for the position.
      vi.spyOn(EditorView.prototype, "coordsAtPos").mockImplementation((position: number) => ({ left: position, right: position, top: 2 * position, bottom: 2 * position + 16 }));
      expect(editor.caret(), name).toEqual({ x: start + to, y: 2 * (start + to), height: 16 });
      expect(editor.start(), name).toEqual({ x: start + from, y: 2 * (start + from), height: 16 });
    }
  });
});
