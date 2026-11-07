// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// What `run.mjs` checks of each read in a real browser, against the page's own document
// (`document.mjs`). Each check gives the ways a read is wrong, none when it is right.

/** How far, in screen pixels, a caret anchor may sit from where the page drew the caret, beyond
 * the page's own rounding: between two carets of one page, and (where the page knows its place on
 * the screen) from the page's place. A browser's frame is not exactly half its width either side. */
export const anchorTolerance = { between: 3, onScreen: 24 };
/** How much taller or shorter than the page's caret its anchor may be. */
export const anchorHeightRatio = { min: 0.5, max: 2 };

/** Reads known to fail where a recorded issue is open, by system, then "browser page case read" (as
 * `"firefox codemirror long-empty-line readScreen"`), to the issue's number. The change fixing one removes
 * it here: a read listed here that passes fails the run until it is. */
export const knownFailures = {
  // Ubuntu 26.04 ARM64, Firefox 157 and Chromium 156 snaps (2026-11-06, 2026-11-07). #390: the field read
  // of the long compose page runs out its time limit in some runs and not others (`sometimesFailing`).
  linux: {
    "firefox compose long-empty-line focusedFieldValue": 390,
    "firefox compose long-mid-line focusedFieldValue": 390,
    "chrome compose long-empty-line focusedFieldValue": 390,
    "chrome compose long-mid-line focusedFieldValue": 390,
  },
  // Windows 11 ARM64, Edge, Chrome and Firefox (three runs on 2026-11-06 and one on 2026-11-07). #379: Firefox's rich editors read
  // through UI Automation lose their line breaks, in the screen read and the field read. #391: a field read
  // in Edge and Chrome gives an empty line as one line break. #380: in Firefox's CodeMirror page the anchor is a line above
  // the caret. #403: the screen read of the long compose page can take longer than the
  // driver's request time (Edge, Chrome), or its field's census runs out and the read has no caret context
  // (Firefox), so its reads fail in some runs and not others (`sometimesFailing`). A page that fails as a whole is
  // never recorded: whatever stopped it (a page not loaded, not in front, a wrong selection) fails the run.
  win32: {
    "edge codemirror empty-line focusedFieldValue": 391,
    "edge codemirror long-empty-line focusedFieldValue": 391,
    "edge compose empty-line focusedFieldValue": 391,
    "edge compose long-empty-line focusedFieldValue": 391,
    "chrome codemirror empty-line focusedFieldValue": 391,
    "chrome codemirror long-empty-line focusedFieldValue": 391,
    "chrome compose empty-line focusedFieldValue": 391,
    "chrome compose long-empty-line focusedFieldValue": 391,
    "firefox codemirror empty-line focusedFieldValue": 379,
    "firefox codemirror line-start focusedFieldValue": 379,
    "firefox codemirror mid-line focusedFieldValue": 379,
    "firefox codemirror line-end focusedFieldValue": 379,
    "firefox codemirror selection focusedFieldValue": 379,
    "firefox codemirror long-empty-line focusedFieldValue": 379,
    "firefox codemirror long-mid-line focusedFieldValue": 379,
    "firefox compose empty-line focusedFieldValue": 379,
    "firefox compose line-start focusedFieldValue": 379,
    "firefox compose mid-line focusedFieldValue": 379,
    "firefox compose line-end focusedFieldValue": 379,
    "firefox compose selection focusedFieldValue": 379,
    "firefox compose long-empty-line focusedFieldValue": 379,
    "firefox compose long-mid-line focusedFieldValue": 379,
    "firefox codemirror empty-line readScreen": 379,
    "firefox codemirror line-start readScreen": 379,
    "firefox codemirror mid-line readScreen": 379,
    "firefox codemirror line-end readScreen": 379,
    "firefox codemirror selection readScreen": 379,
    "firefox codemirror long-empty-line readScreen": 379,
    "firefox codemirror long-mid-line readScreen": 379,
    "firefox compose long-mid-line readScreen": 379,
    "firefox codemirror empty-line caretAnchor": 380,
    "firefox codemirror line-start caretAnchor": 380,
    "firefox codemirror mid-line caretAnchor": 380,
    "firefox codemirror line-end caretAnchor": 380,
    "firefox codemirror selection caretAnchor": 380,
    "firefox codemirror long-empty-line caretAnchor": 380,
    "firefox codemirror long-mid-line caretAnchor": 380,
    "edge compose long-empty-line readScreen": 403,
    "edge compose long-mid-line readScreen": 403,
    "chrome compose long-empty-line readScreen": 403,
    "chrome compose long-mid-line readScreen": 403,
    "firefox compose long-empty-line readScreen": 403,
  },
};

/** Issues whose reads fail in some runs and not in others, as the machine's load makes a read take
 * longer than it may: a read recorded under one passes the run when it passes, and the change fixing
 * the issue removes its records. */
export const sometimesFailing = new Set([390, 403]);

/** The text around a case's caret: the lines before and after it, the line's text either side,
 * and what is selected. */
function around(lines, { line, from, to }) {
  const text = lines[line];
  return { before: `${lines[line - 1]}\n${text.slice(0, from)}`, selected: text.slice(from, to), after: `${text.slice(to)}\n${lines[line + 1]}` };
}

/** `readScreen`'s caret context: it ends with the line before and the line's text up to the caret
 * (so a caret at a line's start reads a line break before it, never a space), selects exactly the
 * selection, and goes on with the rest of the line and the line after. */
export function checkScreen(lines, testCase, read) {
  if (!read || typeof read.textBeforeCaret !== "string") return ["no caret context"];
  const want = around(lines, testCase);
  const wrong = [];
  if (!read.textBeforeCaret.endsWith(want.before)) wrong.push(`text before the caret ends ${JSON.stringify(read.textBeforeCaret.slice(-want.before.length - 8))}, not ${JSON.stringify(want.before)}`);
  if (read.selectedText !== want.selected) wrong.push(`selected ${JSON.stringify(read.selectedText)}, not ${JSON.stringify(want.selected)}`);
  if (typeof read.textAfterCaret !== "string" || !read.textAfterCaret.startsWith(want.after)) wrong.push(`text after the caret starts ${JSON.stringify(String(read.textAfterCaret).slice(0, want.after.length + 8))}, not ${JSON.stringify(want.after)}`);
  return wrong;
}

/** `focusedFieldValue`: the editor's text, holding the caret's line between its neighbours. */
export function checkField(lines, { line }, reply) {
  const value = reply?.value;
  if (typeof value !== "string") return ["no field value"];
  const want = `${lines[line - 1]}\n${lines[line]}\n${lines[line + 1]}`;
  if (value.includes(want)) return [];
  // The page's text is synthetic: what the value holds after the line before the case's shows how it differs.
  const at = value.indexOf(lines[line - 1]);
  const held = at < 0 ? "not even the line before" : JSON.stringify(value.slice(at, at + want.length + 8));
  return [`the field's value does not hold ${JSON.stringify(want)}; it holds ${held}`];
}

/** `caretAnchor` for the carets of one page: each one where the page drew its caret, in screen
 * pixels (`scale` of the page's CSS pixels). Between carets, every anchor sits the same distance
 * from the page's caret; with `onScreen`, that distance is where the page's content starts on the
 * screen. A selection's anchor may be at either of its ends (the page's `caret` is its end, `start`
 * its start): it is judged at the one it is nearer. Each entry is `{ name, report, anchor }`; gives
 * each wrong anchor's case and why. */
export function checkAnchors(entries, { onScreen }) {
  const wrong = [];
  let first = null;
  for (const { name, report, anchor } of entries) {
    if (!anchor || !(anchor.height > 0)) {
      wrong.push({ name, why: "no caret anchor" });
      continue;
    }
    const { scale } = report;
    const page = onScreen ? { x: (report.screen.x + report.screen.frameX) * scale, y: (report.screen.y + report.screen.frameY) * scale } : null;
    // The offset of the anchor from the page's caret, at the end nearer where the page (or the first caret) places it.
    const reference = page ?? first?.offset;
    const [{ caret, offset }] = [report.caret, report.start ?? report.caret]
      .map((end) => ({ caret: end, offset: { x: anchor.x - end.x * scale, y: anchor.y - end.y * scale } }))
      .sort((one, other) => (reference ? distance(one.offset, reference) - distance(other.offset, reference) : 0));
    const height = anchor.height / (caret.height * scale);
    if (height < anchorHeightRatio.min || height > anchorHeightRatio.max) wrong.push({ name, why: `anchor ${anchor.height} high for a caret of ${caret.height * scale}` });
    if (page && (Math.abs(offset.x - page.x) > anchorTolerance.onScreen || Math.abs(offset.y - page.y) > anchorTolerance.onScreen))
      wrong.push({ name, why: `anchor at ${anchor.x},${anchor.y}, but the caret is at ${page.x + caret.x * scale},${page.y + caret.y * scale}` });
    if (!first) first = { name, offset };
    else if (Math.abs(offset.x - first.offset.x) > anchorTolerance.between || Math.abs(offset.y - first.offset.y) > anchorTolerance.between)
      wrong.push({ name, why: `anchor ${Math.round(offset.x - first.offset.x)},${Math.round(offset.y - first.offset.y)} off from where ${first.name}'s places the page` });
  }
  return wrong;
}

/** How far apart two offsets are, the farther of their two directions. */
const distance = (one, other) => Math.max(Math.abs(one.x - other.x), Math.abs(one.y - other.y));

/** Whether a screen read names the browser asked for (`firefox`, `chrome` or `edge`; Chromium is
 * `chrome`): an app the helpers could not name is an empty bundle ID. */
export const browserNames = { firefox: /firefox/i, chrome: /chrom/i, edge: /edge/i };
export function checkIdentity(browser, read) {
  if (!read) return ["no screen read"];
  return browserNames[browser].test(`${read.bundleID} ${read.appName}`) ? [] : [`the screen read names the app ${JSON.stringify(read.appName)} (${JSON.stringify(read.bundleID)})`];
}

/** A read's outcome: "pass", "fail", "known" (it fails as an open issue records) or "fixed" (it
 * passes, but is still recorded as failing, so the record must go; not for an issue in
 * `sometimesFailing`). */
export function verdict(platform, read, wrong) {
  const issue = knownFailures[platform]?.[read];
  if (wrong.length === 0) return issue && !sometimesFailing.has(issue) ? "fixed" : "pass";
  return issue ? "known" : "fail";
}
