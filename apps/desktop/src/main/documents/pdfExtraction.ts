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
  contextLimit: number,
  readCMap: (name: string) => Uint8Array | null,
): Promise<PDFText> {
  const task = getDocument({
    data: bytes,
    // Fonts that name a predefined CJK encoding instead of embedding one read it from the bundled
    // CMaps (packed, `<name>.bcmap`), through `readCMap` only; nothing is fetched.
    BinaryDataFactory: class {
      fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
        const data = kind === "cMapUrl" ? readCMap(filename) : null;
        return data ? Promise.resolve(data) : Promise.reject(new Error("Unavailable."));
      }
    },
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    useWasm: false,
    enableXfa: false,
    // A damaged part (a stream that doesn't decode, an object that isn't there) refuses the read
    // rather than being skipped: text with pieces silently missing would be returned as the
    // whole page. (Thunderbird's reader recovers instead.) A font that is missing or can't be
    // read is the exception: PDF.js draws nothing for its text and the page reads without it,
    // so a private key's header in such a font goes missing; the shared redaction still finds
    // the key by its body and end line (`private-key-end`).
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const result: PDFText = { totalPages: document.numPages, pages: [], nextPage: null, truncated: false, before: "", after: "" };
    // Past the last page: no pages, and the page count so the caller can say where the PDF ends.
    if (range.startPage > document.numPages) return result;
    // Streams one page's text to `take` until it returns false. Consume chunks instead of
    // aggregating the whole page: this bounds retained output. Production decoding allocations
    // are separately bounded by the fixed interpreter arena and the disposable process watchdog.
    const read = async (number: number, take: (part: string) => boolean): Promise<void> => {
      const page = await document.getPage(number);
      try {
        const reader = (page.streamTextContent() as ReadableStream<TextContent>).getReader();
        try {
          for (let more = true; more;) {
            const chunk = await reader.read();
            if (chunk.done) return;
            for (const item of chunk.value.items) {
              if (!("str" in item)) continue;
              more = take(item.str + (item.hasEOL ? "\n" : ""));
              if (!more) break;
            }
          }
          await reader.cancel(new Error("PDF text budget reached."));
        } finally {
          reader.releaseLock();
        }
      } finally {
        page.cleanup();
      }
    };
    if (range.startPage > 1) {
      let tail = "";
      await read(range.startPage - 1, (part) => { tail = (tail + part).slice(-contextLimit); return true; });
      tail = tail.trimEnd();
      // Pages are joined with a blank line, as the text returned is.
      if (tail !== "") result.before = `${tail}\n\n`;
    }
    let remaining = textLimit, after = "";
    const end = Math.min(document.numPages, range.startPage + range.pageCount - 1);
    for (let number = range.startPage; number <= end; number += 1) {
      let text = "";
      await read(number, (part) => {
        // Past the budget, the rest of this page is only the redactor's context.
        if (result.truncated) { after += part; return after.length < contextLimit; }
        const size = new TextEncoder().encode(part).byteLength;
        if (size > remaining) { result.truncated = true; after = part; return after.length < contextLimit; }
        text += part;
        remaining -= size;
        return true;
      });
      result.pages.push({ number, text: text.trim() });
      result.nextPage = number < document.numPages ? number + 1 : null;
      // The whitespace trimmed off the cut keeps the context from joining onto the last word.
      if (result.truncated) { after = text.slice(text.trimEnd().length) + after; break; }
    }
    if (!result.truncated && result.nextPage !== null) {
      await read(result.nextPage, (part) => { after += part; return after.length < contextLimit; });
      after = after.trimStart();
      if (after !== "") after = `\n\n${after}`;
    }
    result.after = after.slice(0, contextLimit);
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
