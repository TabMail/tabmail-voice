// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// What the code editor page takes from CodeMirror, bundled into `codemirror.js` by
// `scripts/browser-pages.mts` so the page loads with no package server.
export { EditorSelection } from "@codemirror/state";
export { EditorView, highlightActiveLine, lineNumbers } from "@codemirror/view";
export { defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
export { stex } from "@codemirror/legacy-modes/mode/stex";
