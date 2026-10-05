// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { describe, expect, test } from "vitest";
import { pdfMaxPages, pdfMaxTextBytes } from "../../../src/core/config.js";
import { extractPDFInRealm as extractPDF } from "../../../src/main/documents/pdfRealm.js";

import { extractPDF as referencePDF } from "./referencePDF.js";

/** Minimal synthetic PDFs, with real cross-reference offsets. No external files. */
function pdf(pages: string[], catalog = "", unicode = false, rawStreams = false): Uint8Array {
  const objects = [`<< /Type /Catalog /Pages 2 0 R ${catalog} >>`, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const characters = [...new Set(Array.from(pages.join("")))];
  if (unicode) objects[2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${4 + pages.length * 2} 0 R >>`;
  for (const text of pages) {
    let stream = `BT /F1 0.001 Tf 30 700 Td (${text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj ET`;
    if (rawStreams) stream = text;
    if (unicode) stream = `BT /F1 12 Tf 30 700 Td <${Array.from(text).map(c => (characters.indexOf(c) + 33).toString(16).padStart(2, "0")).join("")}> Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >> >> /Contents ${objects.length + 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  if (unicode) {
    const entries = characters.map((c, i) => `<${(i + 33).toString(16).padStart(2, "0")}> <${Buffer.from(c, "utf16le").swap16().toString("hex")}>`).join("\n");
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /SyntheticUnicode def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange ${characters.length} beginbfchar\n${entries}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
    objects.push(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
  }
  let result = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(result));
}

describe.each([["reference", referencePDF], ["bounded", extractPDF]] as const)("%s parser", (_name, readPDF) => {

test("extracts selected pages and reports continuation", async () => {
  const result = await readPDF(pdf(["one", "two", "three"]), { startPage: 2, pageCount: 1 });
  expect(result).toEqual({ totalPages: 3, pages: [{ number: 2, text: "two" }], nextPage: 3, truncated: false });
});

test.each([['in', 'voice', 'invoice'], ['Public. sk-', 'SyntheticFixture1234', 'Public. sk-SyntheticFixture1234']])("preserves contiguous text across a font change: %s", async (left, right, expected) => {
  const stream = `BT /F1 12 Tf 30 700 Td (${left}) Tj /F2 12 Tf (${right}) Tj ET`;
  const result = await readPDF(pdf([stream], "", false, true), { startPage: 1, pageCount: 1 });
  expect(result.pages).toEqual([{ number: 1, text: expected }]);
});

test("empty page has no invented OCR text", async () => {
  expect((await readPDF(pdf([""]), { startPage: 1, pageCount: 1 })).pages).toEqual([{ number: 1, text: "" }]);
});

test("bounds extracted text", async () => {
  const result = await readPDF(pdf(["a".repeat(pdfMaxTextBytes + 100)]), { startPage: 1, pageCount: 1 });
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.pages[0]?.text ?? "")).toBeLessThanOrEqual(pdfMaxTextBytes);
});

test.each([{ startPage: 0, pageCount: 1 }, { startPage: 1, pageCount: pdfMaxPages + 1 }, { startPage: 1.5, pageCount: 1 }])("rejects invalid range %j", async (range) => {
  await expect(readPDF(pdf(["one"]), range)).rejects.toThrow("Invalid PDF request");
});

test("malformed input returns a sanitized error", async () => {
  await expect(readPDF(new TextEncoder().encode("private-malformed-payload"), { startPage: 1, pageCount: 1 })).rejects.toThrow("This PDF could not be read");
});


test("extracts Unicode through a PDF ToUnicode map", async () => {
  const text = "RésuméStraße한글日本語😀";
  const result = await readPDF(pdf([text], "", true), { startPage: 1, pageCount: 1 });
  expect(result.pages[0]?.text).toBe(text);
});

test("refuses a genuinely encrypted PDF with a password classification", async () => {
  const bytes = new Uint8Array(await readFile(join(__dirname, "fixtures/encrypted.pdf")));
  await expect(readPDF(bytes, { startPage: 1, pageCount: 1 })).rejects.toThrow("This PDF requires a password.");
});

test("does not execute embedded JavaScript or follow an external open action", async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.end("external"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No test listener");
    const url = `http://127.0.0.1:${address.port}/pdf-reference`;
    const state = globalThis as typeof globalThis & { pdfActionExecuted?: boolean };
    delete state.pdfActionExecuted;
    const script = `/OpenAction << /S /JavaScript /JS (globalThis.pdfActionExecuted = true;) >>`;
    expect((await readPDF(pdf(["visible"], script), { startPage: 1, pageCount: 1 })).pages[0]?.text).toBe("visible");
    expect(state.pdfActionExecuted).toBeUndefined();
    const action = `/OpenAction << /S /URI /URI (${url}) >>`;
    await readPDF(pdf(["visible"], action), { startPage: 1, pageCount: 1 });
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

});
