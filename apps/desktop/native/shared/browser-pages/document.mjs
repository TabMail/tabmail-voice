// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The test pages' documents and the carets the driver puts in them. The pages build their editors
// from these lines, and the driver checks each read against them, so both sides share one source.
// Every line is synthetic: plain words, with no leading, trailing or doubled spaces a read could
// fold, and nothing that looks like a secret.

/** A short page's lines (within every read's budget), and a long page's: more than 300 lines, as
 * an Overleaf document or a long mail thread is. */
export const pageLines = { short: 40, long: 330 };

/** Every ninth line from the fifth is empty. */
const empty = (index) => index % 9 === 4;

/** One line of the code editor's LaTeX document, which its highlighter splits into many pieces. */
export function latexLine(index) {
  if (empty(index)) return "";
  if (index % 9 === 0) return `\\section{Synthetic part ${index}}`;
  return `Line ${index} has \\textbf{bold words} and $x_${index}$ \\cite{key${index}} here.`;
}

/** One line of the mail editor, as the runs it is written in: a bold run inside plain text. */
export function composeRuns(index) {
  if (empty(index)) return [];
  return [{ text: `Synthetic note ${index} with ` }, { text: "bold words", bold: true }, { text: " and plain text." }];
}

const composeLine = (index) => composeRuns(index).map(({ text }) => text).join("");

/** The page's lines, as text. */
export function lines(page, size) {
  const count = pageLines[size];
  return Array.from({ length: count }, (_, index) => (page === "codemirror" ? latexLine(index) : composeLine(index)));
}

/** Where the bold words start and end on a line. */
function bold(line) {
  const from = line.indexOf("bold words");
  return { from, to: from + "bold words".length };
}

/** The carets each page is read at: on a short page, the caret on an empty line, at a line's start,
 * at a piece's start inside it, at its end, and a selection of the bold words; on a long page, an
 * empty line and a piece's start far down the document. `line` counts from 0; `from` and `to` are
 * UTF-16 offsets in it, equal for a caret. */
export function cases(page) {
  const short = lines(page, "short");
  const long = lines(page, "long");
  const text = 11;
  const blank = 13;
  const deepText = 317;
  const deepBlank = 319;
  if (short[text] === "" || short[blank] !== "" || long[deepText] === "" || long[deepBlank] !== "") throw new Error("the cases' lines moved");
  return [
    { name: "empty-line", size: "short", line: blank, from: 0, to: 0 },
    { name: "line-start", size: "short", line: text, from: 0, to: 0 },
    { name: "mid-line", size: "short", line: text, from: bold(short[text]).from, to: bold(short[text]).from },
    { name: "line-end", size: "short", line: text, from: short[text].length, to: short[text].length },
    { name: "selection", size: "short", line: text, ...bold(short[text]) },
    { name: "long-empty-line", size: "long", line: deepBlank, from: 0, to: 0 },
    { name: "long-mid-line", size: "long", line: deepText, from: bold(long[deepText]).from, to: bold(long[deepText]).from },
  ];
}
