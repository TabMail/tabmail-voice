// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, expect, test, vi } from "vitest";
const parser = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: parser.getDocument, GlobalWorkerOptions: {} }));
import { pdfRedactionContext } from "../../../src/core/config.js";
import { extractPDF, pdfMaxTextBytes } from "./referencePDF.js";

const read = vi.fn();
const cancel = vi.fn();
const releaseLock = vi.fn();
const cleanup = vi.fn();
const destroy = vi.fn();
const getPage = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  const page = {
    streamTextContent: () => ({ getReader: () => ({ read, cancel, releaseLock }) }),
    getTextContent: () => { throw new Error("Whole-page aggregation must not be used"); },
    cleanup,
  };
  getPage.mockResolvedValue(page);
  parser.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage }), destroy });
});

test("stops consuming chunks and pages when the UTF-8 output budget is exceeded", async () => {
  read.mockResolvedValueOnce({ done: false, value: { items: [{ str: "visible", hasEOL: true }] } })
    .mockResolvedValueOnce({ done: false, value: { items: [{ str: "é".repeat(pdfMaxTextBytes / 2), hasEOL: false }] } })
    .mockRejectedValue(new Error("Must not request remaining page text"));
  expect(await extractPDF(new Uint8Array([1]), { startPage: 1, pageCount: 2 })).toEqual({
    totalPages: 2, pages: [{ number: 1, text: "visible" }], nextPage: 2, truncated: true,
    before: "", after: `\n${"é".repeat(pdfRedactionContext - 1)}`,
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(getPage).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledOnce();
  expect(releaseLock).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
});

test("a failed stream is sanitized and releases its reader and document", async () => {
  read.mockRejectedValue(new Error("private document contents"));
  await expect(extractPDF(new Uint8Array([1]), { startPage: 1, pageCount: 1 })).rejects.toThrow("This PDF could not be read, or the requested page is unavailable.");
  expect(releaseLock).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
});

test("past the budget, the rest of the cut page is the redactor's context", async () => {
  read.mockResolvedValueOnce({ done: false, value: { items: [{ str: "a".repeat(pdfMaxTextBytes - 5), hasEOL: false }] } })
    .mockResolvedValueOnce({ done: false, value: { items: [{ str: "OVERFLOW", hasEOL: false }] } })
    .mockResolvedValueOnce({ done: false, value: { items: [{ str: "CONTINUATION", hasEOL: true }] } })
    .mockResolvedValue({ done: true });
  const result = await extractPDF(new Uint8Array([1]), { startPage: 1, pageCount: 1 });
  expect(result).toMatchObject({ truncated: true, nextPage: 2, after: "OVERFLOWCONTINUATION\n" });
  expect(result.pages[0]!.text).toHaveLength(pdfMaxTextBytes - 5);
});

test("context cut through a character pair leaves neither half", async () => {
  // Page 2 is the after-context: its cut lands between the halves of an emoji.
  read.mockResolvedValueOnce({ done: false, value: { items: [{ str: "Page one.", hasEOL: false }] } })
    .mockResolvedValueOnce({ done: true })
    .mockResolvedValueOnce({ done: false, value: { items: [{ str: `y${"\u{1F600}".repeat(pdfRedactionContext)}`, hasEOL: false }] } })
    .mockResolvedValue({ done: true });
  const after = (await extractPDF(new Uint8Array([1]), { startPage: 1, pageCount: 1 })).after;
  expect(after.isWellFormed()).toBe(true);
  expect(after).toBe(`\n\ny${"\u{1F600}".repeat((pdfRedactionContext - 4) / 2)}`);
  // Page 1 is the before-context of page 2: its cut lands between the halves too.
  read.mockReset();
  read.mockResolvedValueOnce({ done: false, value: { items: [{ str: `${"\u{1F600}".repeat(pdfRedactionContext)}z`, hasEOL: false }] } })
    .mockResolvedValueOnce({ done: true })
    .mockResolvedValueOnce({ done: false, value: { items: [{ str: "Page two.", hasEOL: false }] } })
    .mockResolvedValue({ done: true });
  const before = (await extractPDF(new Uint8Array([1]), { startPage: 2, pageCount: 1 })).before;
  expect(before.isWellFormed()).toBe(true);
  expect(before).toBe(`${"\u{1F600}".repeat((pdfRedactionContext - 2) / 2)}z\n\n`);
});
