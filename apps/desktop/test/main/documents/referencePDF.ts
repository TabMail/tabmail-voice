// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extractPDFDocument } from "../../../src/main/documents/pdfExtraction.js";

import type { PDFRange, PDFText } from "../../../src/core/agent/connectors/pdf.js";
import { documentMaxBytes, pdfMaxPages, pdfMaxTextBytes, pdfRedactionContext } from "../../../src/core/config.js";
export { pdfMaxTextBytes } from "../../../src/core/config.js";

/** Test-only pre-consolidation parser for behavior comparisons and mocked stream
 * contracts. Production must use the bounded interpreter in pdfRealm.ts. */
export async function extractPDF(bytes: Uint8Array, range: PDFRange): Promise<PDFText> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > documentMaxBytes || bytes.byteLength === 0 ||
    !Number.isSafeInteger(range.startPage) || range.startPage < 1 ||
    !Number.isSafeInteger(range.pageCount) || range.pageCount < 1 || range.pageCount > pdfMaxPages) throw new Error("Invalid PDF request.");
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Electron utility processes are not classified as Node by PDF.js. Supply
  // the bundled worker explicitly; its fallback runs within this disposable process.
  GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const cMaps = join(dirname(require.resolve("pdfjs-dist/package.json")), "cmaps");
  const readCMap = (name: string) => /^[A-Za-z0-9-]+\.bcmap$/u.test(name) ? new Uint8Array(readFileSync(join(cMaps, name))) : null;
  return extractPDFDocument(getDocument, bytes, range, pdfMaxTextBytes, pdfRedactionContext, readCMap);
}
