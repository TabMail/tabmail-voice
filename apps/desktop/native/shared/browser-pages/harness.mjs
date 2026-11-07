// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The page's side of the driver (`run.mjs`): it asks the page's own server for the next caret,
// puts it in the editor, and reports where it drew it. Only that server is ever asked.

const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function post(body) {
  await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Runs the driver's commands against an editor: `select(line, from, to)` puts the selection and
 * focuses the editor, `caret()` gives the caret's rectangle in the page (CSS pixels, at the
 * selection's end), `start()` the selection's start's (the caret's, with nothing selected), and
 * `selected()` the text the editor has selected. */
export async function serve(editor) {
  await post({ ready: true });
  for (;;) {
    const command = await (await fetch("/command")).json();
    if (command.kind === "done") return;
    // Each caret comes with the editor taking the focus afresh, as a click into it would: a browser
    // whose accessibility started after the editor took the focus never says the editor has it.
    document.activeElement?.blur();
    await frames();
    editor.select(command.line, command.from, command.to);
    await frames();
    const [caret, start] = [editor.caret(), editor.start()];
    await post({
      selected: editor.selected(),
      caret: { x: caret.x, y: caret.y, height: caret.height },
      start: { x: start.x, y: start.y, height: start.height },
      scale: devicePixelRatio,
      // Where the page sits on the screen, where the system tells it (not on Wayland).
      screen: { x: screenX, y: screenY, frameX: (outerWidth - innerWidth) / 2, frameY: outerHeight - innerHeight },
    });
  }
}
