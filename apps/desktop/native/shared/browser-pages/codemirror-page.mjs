// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defaultHighlightStyle, EditorSelection, EditorView, highlightActiveLine, lineNumbers, StreamLanguage, stex, syntaxHighlighting } from "./codemirror.js";
import { latexLine, pageLines } from "./document.mjs";
import { serve } from "./harness.mjs";

const count = pageLines[new URLSearchParams(location.search).get("size") ?? "short"];
const view = new EditorView({
  doc: Array.from({ length: count }, (_, index) => latexLine(index)).join("\n"),
  extensions: [lineNumbers(), highlightActiveLine(), StreamLanguage.define(stex), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping],
  parent: document.body,
});

/** The caret's rectangle at a position. */
function at(position) {
  const rect = view.coordsAtPos(position);
  return { x: rect.left, y: rect.top, height: rect.bottom - rect.top };
}

await serve({
  select(line, from, to) {
    const start = view.state.doc.line(line + 1).from;
    view.focus();
    view.dispatch({ selection: EditorSelection.single(start + from, start + to), effects: EditorView.scrollIntoView(start + to, { y: "center" }) });
  },
  caret: () => at(view.state.selection.main.head),
  start: () => at(view.state.selection.main.from),
  selected: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
});
