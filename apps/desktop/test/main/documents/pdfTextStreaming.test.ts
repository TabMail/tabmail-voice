// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, expect, test, vi } from "vitest";
const parser = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: parser.getDocument, GlobalWorkerOptions: {} }));
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
