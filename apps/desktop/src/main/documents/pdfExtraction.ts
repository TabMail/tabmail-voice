// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { TextContent } from "pdfjs-dist/types/src/display/api.js";
import type { PDFRange, PDFText } from "../../core/agent/connectors/pdf.js";

/** Shared extraction body for the isolated realm and the streaming contract tests.
 * Keep runtime dependencies explicit: this function is also evaluated in the
 * bounded interpreter, where Node and app globals are deliberately absent. */
export async function extractPDFDocument(
  getDocument: typeof import("pdfjs-dist/types/src/display/api.js").getDocument,
  bytes: Uint8Array,
  range: PDFRange,
  textLimit: number,
): Promise<PDFText> {
  const task = getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    useWasm: false,
    enableXfa: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const result: PDFText = { totalPages: document.numPages, pages: [], nextPage: null, truncated: false };
    // Past the last page: no pages, and the page count so the caller can say where the PDF ends.
    if (range.startPage > document.numPages) return result;
    let remaining = textLimit;
    const end = Math.min(document.numPages, range.startPage + range.pageCount - 1);
    for (let number = range.startPage; number <= end; number += 1) {
      const page = await document.getPage(number);
      let text = "";
      try {
        // Consume chunks instead of aggregating the whole page. This bounds
        // retained output. Production decoding allocations are separately bounded
        // by the fixed interpreter arena and the disposable process watchdog.
        const reader = (page.streamTextContent() as ReadableStream<TextContent>).getReader();
        try {
          while (!result.truncated) {
            const chunk = await reader.read();
            if (chunk.done) break;
            for (const item of chunk.value.items) {
              if (!("str" in item)) continue;
              const part = item.str + (item.hasEOL ? "\n" : "");
              const size = new TextEncoder().encode(part).byteLength;
              if (size > remaining) {
                result.truncated = true;
                break;
              }
              text += part;
              remaining -= size;
            }
          }
          if (result.truncated) await reader.cancel(new Error("PDF text budget reached."));
        } finally {
          reader.releaseLock();
        }
      } finally {
        page.cleanup();
      }
      result.pages.push({ number, text: text.trim() });
      result.nextPage = number < document.numPages ? number + 1 : null;
      if (result.truncated) break;
    }
    return result;
  } catch (error) {
    // Parser errors may contain document contents. Only known classifications
    // leave this process; never forward the original message or stack.
    // eslint-disable-next-line preserve-caught-error -- Never retain private parser messages in a cause.
    if (error instanceof Error && error.name === "PasswordException") throw new Error("This PDF requires a password.");
    // eslint-disable-next-line preserve-caught-error -- Only the sanitized classification crosses the process boundary.
    throw new Error("This PDF could not be read, or the requested page is unavailable.");
  } finally {
    await task.destroy();
  }
}
