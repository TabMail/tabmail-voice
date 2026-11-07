# Real browser-page tests

Voice's caret and screen reads are unit-tested on modelled accessibility trees. These pages put real
browser editors under the Linux and Windows helpers instead, so a read that only a real browser gets
wrong (an Overleaf caret on an empty line read as following the line above, #355) fails a test.

- `codemirror.html`: a code editor shaped like Overleaf's: CodeMirror 6 with line numbers and LaTeX
  highlighting, which gives every highlighted piece of a line an element of its own.
- `compose.html`: a mail editor shaped like Gmail's compose body: a `contenteditable` of one block a
  line, an empty line a block holding only a `<br>`, a bold run inside a line, and a signature.

Each page is loaded short (40 lines) and long (330 lines, past the 300 elements the Linux rich read
walks). `document.mjs` writes both documents and names the carets the pages are read at: on an empty
line, at a line's start, at a piece's start inside a line, at its end, a selection, and an empty line
and a piece's start far down the long page.

`run.mjs` serves the pages on 127.0.0.1, opens them in each browser named (a new profile each time,
deleted after) and starts the helpers; `driver.mjs` puts each caret in the page and reads it as the
app does:

- `readScreen` (voice-screen-reader): the caret context ends with the line before and the line's text
  up to the caret (so a caret at a line's start reads a line break before it, never a space), selects
  exactly the selection, and goes on with the rest of the line and the line after;
- `focusedFieldValue` (voice-field-reader): the editor's text holds the caret's line between its
  neighbours;
- `caretAnchor` (the main helper; on Linux, the Shell's caret where it has none or its request fails): each anchor sits
  where the page drew its caret, as far from it as every other caret on the page; on Windows, where
  the page knows its place on the screen, at that place too. A selection's anchor may be at either of
  its ends. Wayland tells a page nothing of its place,
  so there only the carets' places relative to each other are checked.

`checks.mjs` judges each read; `knownFailures` there lists the reads that fail while a recorded issue
is open. A listed read that passes fails the run until the change fixing it removes it. A page that
can't be read on (not loaded, not in front, a wrong selection) fails the run, never listed. Each read,
an anchor too, is tried again a few times while it is wrong, as the browser may not have caught up.

## Running

In a signed-in desktop session (GNOME with accessibility on, or Windows), with the helpers built and
nothing else in front:

```sh
node run.mjs --helpers <folder of the built helpers> --browser firefox=<path> --browser chrome=<path>
```

A browser is `firefox`, `chrome` or `edge`, with its program's path (Chromium runs as `chrome`: Google
Chrome has no Linux ARM64 build). On Linux, also name each browser's launcher with
`--desktop-file firefox=<file>` (a snap's is `/var/lib/snapd/desktop/applications/firefox_firefox.desktop`):
the desktop tells a program it starts which launcher it is, the helpers know the app by that, and a snap's
program is not the one its launcher names, so without it, and without the GNOME extension (whose Shell
names the app), the browser is an unknown app. It prints one line a read and exits 1 when a read fails. These run in
the Ubuntu and Windows test machines, not in CI: the build machines have no desktop session or browser.

`codemirror.js` is CodeMirror, bundled by `scripts/browser-pages.mts` (run it after a CodeMirror
update; a test fails until it is) with each package's version and licence at its top.
`test/native/browserPages.test.ts` checks the documents, the checks and the bundle here;
`test/native/browserPagesDriver.test.ts` the driver with stand-in helpers, browsers and pages, and
`run.mjs` with stand-in helper and browser programs; `test/renderer/browserTestPages.test.ts` the
pages' side (the harness and both editors) in happy-dom.
