// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { pdfMaxPages } from "../../config.js";
import { Arguments, ToolArgumentError, type ConnectorTool } from "./contract.js";
export interface PDFRange { startPage: number; pageCount: number }
export interface PDFText {
  totalPages: number;
  pages: { number: number; text: string }[];
  nextPage: number | null;
  /** Remaining text in the last returned page was omitted. */
  truncated: boolean;
  /** The text just before and after the pages returned, read only for the redactor and never
   * returned: empty at the document's start and end. */
  before: string;
  after: string;
}
export interface PreparedPDF {
  readonly path: string;
  read(range: PDFRange, signal: AbortSignal): Promise<string>;
}
export interface PDFReader {
  prepare(path: string, signal: AbortSignal): Promise<PreparedPDF>;
}

/** Explicit document reads are separately authorized; screen exclusions do not
 * grant or deny this scoped file request. Preparation never extracts content. */
export class PDFReadTool implements ConnectorTool {
  readonly name = "file_read_pdf";
  readonly connector = "files";
  readonly progressLabel = "Reading the PDF";
  private readonly prepared = new WeakMap<Record<string, unknown>, { document: PreparedPDF; range: PDFRange }>();
  constructor(private readonly reader: PDFReader) {}

  async confirmation(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    this.prepared.delete(args);
    const path = Arguments.text(args, "path");
    if (path === null) throw ToolArgumentError.missing("path");
    const startPage = args.start_page ?? 1;
    const pageCount = args.page_count ?? pdfMaxPages;
    if (typeof startPage !== "number" || !Number.isSafeInteger(startPage) || startPage < 1 ||
      typeof pageCount !== "number" || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > pdfMaxPages ||
      !Number.isSafeInteger(startPage + pageCount)) throw new ToolArgumentError(`start_page must be positive and page_count must be between 1 and ${pdfMaxPages}.`);
    const document = await this.reader.prepare(path, signal);
    if (signal.aborted) throw new Error("PDF reading was canceled.");
    this.prepared.set(args, { document, range: { startPage, pageCount } });
    return `Read this PDF and share its text with the agent?\n${document.path}\nPages ${startPage}–${startPage + pageCount - 1} (up to ${pageCount} pages). Secrets are redacted; image-only pages need OCR, which is not available.`;
  }

  async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const prepared = this.prepared.get(args);
    this.prepared.delete(args);
    if (prepared === undefined || signal.aborted) throw new Error("This PDF read needs a new confirmation.");
    return prepared.document.read(prepared.range, signal);
  }
}
