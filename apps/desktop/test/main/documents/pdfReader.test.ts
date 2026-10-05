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
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(request: HelperClient["request"]) {
  const home = await mkdtemp(join(tmpdir(), "voice-pdf-pipeline-")); roots.push(home);
  const path = join(home, "example.pdf"); await writeFile(path, "%PDF-test");
  const parse = vi.fn(async (): Promise<PDFText> => ({ totalPages: 2, pages: [{ number: 1, text: "token=" }, { number: 2, text: "syntheticPrivate123" }], nextPage: null, truncated: false }));
  const reader = new LocalPDFReader(home, parse, new NativeTextRedactor({ request }));
  return { path, parse, reader };
}

test("preparation reads no document text, then only redacted text leaves the pipeline", async () => {
  const request = vi.fn().mockResolvedValue({ text: "[redacted]", withheld: false });
  const { path, parse, reader } = await setup(request);
  const signal = new AbortController().signal;
  const prepared = await reader.prepare(path, signal);
  expect(parse).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  const result = JSON.parse(await prepared.read({ startPage: 1, pageCount: 2 }, signal));
  expect(request.mock.calls[0]?.[1]).toEqual({ text: "token=\n\nsyntheticPrivate123", startKnown: true, endKnown: true });
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

 test.each([
  [1, 2, false, true, true],
  [2, 2, false, false, true],
  [1, 3, false, true, false],
  [1, 2, true, true, false],
 ] as const)("carries extraction edge facts (%i, %i, %s) into native redaction", async (start, total, truncated, startKnown, endKnown) => {
  const request = vi.fn().mockResolvedValue({ text: "Public.", withheld: false });
  const { path, parse, reader } = await setup(request);
  parse.mockResolvedValue({ totalPages: total, pages: [{ number: start, text: "Public." }, { number: 2, text: "suffix" }], nextPage: null, truncated });
  const signal = new AbortController().signal;
  await (await reader.prepare(path, signal)).read({ startPage: start, pageCount: 2 }, signal);
  expect(request.mock.calls[0]?.[1]).toEqual({ text: "Public.\n\nsuffix", startKnown, endKnown });
 });

/** Text the redactor withheld at an unchecked edge is reported, never passed off as the whole range. */
test("text withheld at an unchecked edge is reported to the agent", async () => {
  const request = vi.fn().mockResolvedValue({ text: "", withheld: true });
  const { path, parse, reader } = await setup(request);
  parse.mockResolvedValue({ totalPages: 12, pages: [{ number: 1, text: "会議は金曜日です" }], nextPage: 2, truncated: false });
  const signal = new AbortController().signal;
  const result = JSON.parse(await (await reader.prepare(path, signal)).read({ startPage: 1, pageCount: 1 }, signal));
  expect(result.document_text).toBe("");
  expect(result.notice).toContain("withheld");
});

test("nothing withheld adds no notice", async () => {
  const request = vi.fn().mockResolvedValue({ text: "Public.", withheld: false });
  const { path, parse, reader } = await setup(request);
  parse.mockResolvedValue({ totalPages: 1, pages: [{ number: 1, text: "Public." }], nextPage: null, truncated: false });
  const signal = new AbortController().signal;
  const result = JSON.parse(await (await reader.prepare(path, signal)).read({ startPage: 1, pageCount: 1 }, signal));
  expect(result.notice).toBeNull();
});

/** A start past the last page says how many pages there are, and sends nothing to redact. */
test("a start past the end says how many pages the PDF has", async () => {
  const request = vi.fn();
  const { path, parse, reader } = await setup(request);
  parse.mockResolvedValue({ totalPages: 3, pages: [], nextPage: null, truncated: false });
  const signal = new AbortController().signal;
  const result = JSON.parse(await (await reader.prepare(path, signal)).read({ startPage: 5, pageCount: 2 }, signal));
  expect(result).toMatchObject({ total_pages: 3, document_text: "", next_page: null });
  expect(result.notice).toBe("This PDF has 3 pages; start_page is past its end.");
  expect(request).not.toHaveBeenCalled();
});

test("pages with no text say OCR is not available", async () => {
  const request = vi.fn().mockResolvedValue({ text: "", withheld: false });
  const { path, parse, reader } = await setup(request);
  parse.mockResolvedValue({ totalPages: 2, pages: [{ number: 1, text: "" }, { number: 2, text: "" }], nextPage: null, truncated: false });
  const signal = new AbortController().signal;
  const result = JSON.parse(await (await reader.prepare(path, signal)).read({ startPage: 1, pageCount: 2 }, signal));
  expect(result.notice).toBe("No extractable text. This may be an image-only PDF; OCR is not available.");
});
