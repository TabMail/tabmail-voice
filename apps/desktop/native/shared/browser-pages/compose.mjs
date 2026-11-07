// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { composeRuns, pageLines } from "./document.mjs";
import { serve } from "./harness.mjs";

const body = document.getElementById("body");
const count = pageLines[new URLSearchParams(location.search).get("size") ?? "short"];
for (let index = 0; index < count; ++index) {
  const line = document.createElement("div");
  const runs = composeRuns(index);
  if (runs.length === 0) line.append(document.createElement("br"));
  for (const { text, bold } of runs) {
    if (!bold) line.append(text);
    else {
      const run = document.createElement("b");
      run.textContent = text;
      line.append(run);
    }
  }
  body.append(line);
}
const signature = document.createElement("div");
signature.className = "gmail_signature";
signature.innerHTML = "<div>--</div><div>Synthetic sender</div>";
body.append(signature);

/** The text node and offset at a UTF-16 offset of a line; an empty line's is the line itself. */
function point(line, offset) {
  const walker = document.createTreeWalker(body.children[line], NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (left <= node.data.length) return [node, left];
    left -= node.data.length;
  }
  return [body.children[line], 0];
}

/** The caret's rectangle at the selection's start or its end. */
function at(start) {
  const range = getSelection().getRangeAt(0).cloneRange();
  range.collapse(start);
  // A caret in a line's text has a rectangle of its own; one on an empty line takes the line's.
  const rect = range.getClientRects()[0] ?? (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement).getBoundingClientRect();
  return { x: rect.x, y: rect.y, height: rect.height };
}

await serve({
  select(line, from, to) {
    body.focus();
    const range = document.createRange();
    range.setStart(...point(line, from));
    range.setEnd(...point(line, to));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    body.children[line].scrollIntoView({ block: "center" });
  },
  caret: () => at(false),
  start: () => at(true),
  selected: () => getSelection().toString(),
});
