// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { PDFText } from "../../../src/core/agent/connectors/pdf.js";
import { LocalPDFReader } from "../../../src/main/documents/pdfReader.js";
import type { HelperClient } from "../../../src/main/native/helperClient.js";
import { NativeTextRedactor } from "../../../src/main/native/textRedactor.js";
import { CancellationError } from "../../../src/core/util/timeout.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(request: HelperClient["request"]) {
  const home = await mkdtemp(join(tmpdir(), "voice-pdf-pipeline-")); roots.push(home);
  const path = join(home, "example.pdf"); await writeFile(path, "%PDF-test");
  const parse = vi.fn(async (): Promise<PDFText> => ({ totalPages: 2, pages: [{ number: 1, text: "token=" }, { number: 2, text: "syntheticPrivate123" }], nextPage: null, truncated: false, before: "", after: "" }));
  const reader = new LocalPDFReader(home, parse, new NativeTextRedactor({ request }));
  return { path, parse, reader };
}

test("preparation reads no document text, then only redacted text leaves the pipeline", async () => {
  const request = vi.fn().mockResolvedValue({ text: "[redacted]" });
  const { path, parse, reader } = await setup(request);
  const signal = new AbortController().signal;
  const prepared = await reader.prepare(path, signal);
  expect(parse).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  const result = JSON.parse(await prepared.read({ startPage: 1, pageCount: 2 }, signal));
  expect(request.mock.calls[0]?.[1]).toEqual({ text: "token=\n\nsyntheticPrivate123", before: "", after: "" });
  expect(result.document_text).toBe("[redacted]");
  expect(JSON.stringify(result)).not.toContain("syntheticPrivate123");
});

test.each(["refusal", "timeout", "helper unavailable", "helper restarting", "malformed"])("redaction %s never returns extracted text", async (failure) => {
  const request = failure === "malformed" ? vi.fn().mockResolvedValue({ text: null }) : vi.fn().mockRejectedValue(new Error(`${failure}: syntheticPrivate123`));
  const { reader, path } = await setup(request);
  const signal = new AbortController().signal;
  const prepared = await reader.prepare(path, signal);
  let reply: string;
  try { reply = await prepared.read({ startPage: 1, pageCount: 2 }, signal); }
  catch (error) { reply = String(error); }
  expect(reply).toContain("No document text was shared");
  expect(reply).not.toContain("syntheticPrivate123");
});

/** The neighbouring text the parser read goes to the redactor only, never into the reply. */
test("passes the parser's context to native redaction and returns only the range", async () => {
  const request = vi.fn().mockResolvedValue({ text: "Public." });
  const { path, parse, reader } = await setup(request);
  parse.mockResolvedValue({ totalPages: 3, pages: [{ number: 2, text: "Public." }], nextPage: 3, truncated: false, before: "Earlier context.\n\n", after: "\n\nLater context." });
  const signal = new AbortController().signal;
  const result = JSON.parse(await (await reader.prepare(path, signal)).read({ startPage: 2, pageCount: 1 }, signal));
  expect(request.mock.calls[0]?.[1]).toEqual({ text: "Public.", before: "Earlier context.\n\n", after: "\n\nLater context." });
  expect(result.document_text).toBe("Public.");
  expect(result.notice).toBeNull();
  expect(JSON.stringify(result)).not.toContain("context");
});

/** A start past the last page says how many pages there are, and sends nothing to redact. */
/** A lone surrogate the PDF's text carries (or a context cut through a pair) still lets the page be
 * read: the helper refuses text that isn't well-formed, so it gets none. */
test("text with a lone surrogate is still read", async () => {
  const request = vi.fn(async (_method: string, params: Record<string, string>) => {
    if (Object.values(params).some((value) => !value.isWellFormed())) throw new Error("malformed request");
    return { text: params.text };
  });
  const { path, parse, reader } = await setup(request as unknown as HelperClient["request"]);
  parse.mockResolvedValue({ totalPages: 3, pages: [{ number: 2, text: "Caf\uD800e." }], nextPage: 3, truncated: false, before: "\uDC00Earlier.\n\n", after: "\n\nLater.\uD83D" });
  const signal = new AbortController().signal;
  const result = JSON.parse(await (await reader.prepare(path, signal)).read({ startPage: 2, pageCount: 1 }, signal));
  expect(result.document_text).toBe("Caf\uFFFDe.");
});

test("a start past the end says how many pages the PDF has", async () => {
  const request = vi.fn();
  const { path, parse, reader } = await setup(request);
  parse.mockResolvedValue({ totalPages: 3, pages: [], nextPage: null, truncated: false, before: "", after: "" });
  const signal = new AbortController().signal;
  const result = JSON.parse(await (await reader.prepare(path, signal)).read({ startPage: 5, pageCount: 2 }, signal));
  expect(result).toMatchObject({ total_pages: 3, document_text: "", next_page: null });
  expect(result.notice).toBe("This PDF has 3 pages; start_page is past its end.");
  expect(request).not.toHaveBeenCalled();
});

test("pages with no text say OCR is not available", async () => {
  const request = vi.fn().mockResolvedValue({ text: "" });
  const { path, parse, reader } = await setup(request);
  parse.mockResolvedValue({ totalPages: 2, pages: [{ number: 1, text: "" }, { number: 2, text: "" }], nextPage: null, truncated: false, before: "", after: "" });
  const signal = new AbortController().signal;
  const result = JSON.parse(await (await reader.prepare(path, signal)).read({ startPage: 1, pageCount: 2 }, signal));
  expect(result.notice).toBe("No extractable text. This may be an image-only PDF; OCR is not available.");
});

test("a page cut at the text budget says the rest of it was omitted", async () => {
  const request = vi.fn().mockResolvedValue({ text: "Public." });
  const { path, parse, reader } = await setup(request);
  parse.mockResolvedValue({ totalPages: 3, pages: [{ number: 1, text: "Public." }], nextPage: 2, truncated: true, before: "", after: "rest" });
  const signal = new AbortController().signal;
  const result = JSON.parse(await (await reader.prepare(path, signal)).read({ startPage: 1, pageCount: 3 }, signal));
  expect(result).toMatchObject({ truncated: true, next_page: 2, notice: "Remaining text on the last returned page was omitted." });
});

/** A read canceled as parsing finishes returns nothing, and sends nothing to redact. */
test("a read canceled as parsing finishes returns no text", async () => {
  const controller = new AbortController();
  const request = vi.fn();
  const { path, parse, reader } = await setup(request);
  const prepared = await reader.prepare(path, controller.signal);
  parse.mockImplementationOnce(async () => {
    controller.abort();
    return { totalPages: 1, pages: [{ number: 1, text: "Public." }], nextPage: null, truncated: false, before: "", after: "" };
  });
  await expect(prepared.read({ startPage: 1, pageCount: 1 }, controller.signal)).rejects.toBeInstanceOf(CancellationError);
  expect(request).not.toHaveBeenCalled();
});

test("a read canceled during redaction returns no text, even when the helper replies", async () => {
  const controller = new AbortController();
  const request = vi.fn().mockImplementation(async () => { controller.abort(); return { text: "Public." }; });
  const { path, reader } = await setup(request);
  const prepared = await reader.prepare(path, controller.signal);
  await expect(prepared.read({ startPage: 1, pageCount: 2 }, controller.signal)).rejects.toThrow("No document text was shared");
});
