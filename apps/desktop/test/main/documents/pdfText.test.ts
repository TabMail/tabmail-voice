// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { documentMaxBytes, pdfMaxPages, pdfMaxTextBytes, pdfRedactionContext } from "../../../src/core/config.js";
import { extractPDFInRealm as extractPDF } from "../../../src/main/documents/pdfRealm.js";

import { extractPDF as referencePDF } from "./referencePDF.js";

// Every read here runs the bounded parser, which takes seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

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

/** One line in a font that names a predefined CJK encoding and embeds neither glyphs nor a
 * ToUnicode map, as many Japanese, Chinese and Korean PDFs do. */
function predefinedCMapPDF(encoding: string, codes: string, ordering = "Japan1"): Uint8Array {
  const stream = `BT /F1 12 Tf 30 700 Td <${codes}> Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
    `<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticMincho /Encoding /${encoding} /DescendantFonts [6 0 R] >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /SyntheticMincho /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement 2 >> /FontDescriptor 7 0 R >>`,
    "<< /Type /FontDescriptor /FontName /SyntheticMincho /Flags 6 /FontBBox [0 -141 1000 859] /ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 709 /StemV 69 >>",
  ];
  let result = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(result.length); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = result.length;
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(result, "latin1"));
}

describe.each([["reference", referencePDF], ["bounded", extractPDF]] as const)("%s parser", (_name, readPDF) => {

/** The bundled CMaps decode it; without them the page reads as empty, as if it were an image. */
test.each([
  ["UniJIS-UCS2-H", Buffer.from("会議は金曜日です", "utf16le").swap16().toString("hex")],
  ["90ms-RKSJ-H", "89ef8b6382cd8be0976a93fa82c582b7"],
])("reads a font with the predefined %s encoding", async (encoding, codes) => {
  const result = await readPDF(predefinedCMapPDF(encoding, codes), { startPage: 1, pageCount: 1 });
  expect(result.pages).toEqual([{ number: 1, text: "会議は金曜日です" }]);
});

test("a predefined encoding that is not bundled reads as no text", async () => {
  const result = await readPDF(predefinedCMapPDF("Synthetic-Missing-H", "0041"), { startPage: 1, pageCount: 1 });
  expect(result.pages).toEqual([{ number: 1, text: "" }]);
});

test("extracts selected pages and reports continuation", async () => {
  const result = await readPDF(pdf(["one", "two", "three"]), { startPage: 2, pageCount: 1 });
  expect(result).toEqual({ totalPages: 3, pages: [{ number: 2, text: "two" }], nextPage: 3, truncated: false, before: "one\n\n", after: "\n\nthree" });
});

test.each([['in', 'voice', 'invoice'], ['Public. sk-', 'SyntheticFixture1234', 'Public. sk-SyntheticFixture1234']])("preserves contiguous text across a font change: %s", async (left, right, expected) => {
  const stream = `BT /F1 12 Tf 30 700 Td (${left}) Tj /F2 12 Tf (${right}) Tj ET`;
  const result = await readPDF(pdf([stream], "", false, true), { startPage: 1, pageCount: 1 });
  expect(result.pages).toEqual([{ number: 1, text: expected }]);
});

test("a start past the last page returns no pages and the page count", async () => {
  expect(await readPDF(pdf(["one", "two", "three"]), { startPage: 5, pageCount: 1 })).toEqual({ totalPages: 3, pages: [], nextPage: null, truncated: false, before: "", after: "" });
});

test("empty page has no invented OCR text", async () => {
  expect((await readPDF(pdf([""]), { startPage: 1, pageCount: 1 })).pages).toEqual([{ number: 1, text: "" }]);
});

test("bounds extracted text, and the rest of the cut page is only context", async () => {
  const result = await readPDF(pdf(["a".repeat(pdfMaxTextBytes + 100), "next"]), { startPage: 1, pageCount: 2 });
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.pages[0]?.text ?? "")).toBeLessThanOrEqual(pdfMaxTextBytes);
  expect(result.pages.map((page) => page.number)).toEqual([1]);
  expect(result.after).toMatch(/^a+$/u);
  expect(result.after.length).toBeLessThanOrEqual(pdfRedactionContext);
});

/** The redactor sees the end of the page before the range and the start of the page after it,
 * bounded, so a secret crossing either edge is recognized whole. */
test("context is the bounded neighbouring text on each side", async () => {
  const long = `${"b".repeat(pdfRedactionContext)}tail`;
  const result = await readPDF(pdf([long, "middle", `head${"c".repeat(pdfRedactionContext)}`]), { startPage: 2, pageCount: 1 });
  expect(result.pages).toEqual([{ number: 2, text: "middle" }]);
  expect(result.before).toBe(`${long.slice(-pdfRedactionContext)}\n\n`);
  expect(result.after).toBe(`\n\nhead${"c".repeat(pdfRedactionContext - 6)}`);
});

test("a range from the first page through the last has no context", async () => {
  const result = await readPDF(pdf(["one", "two"]), { startPage: 1, pageCount: 2 });
  expect(result).toMatchObject({ before: "", after: "", nextPage: null });
});

test.each([{ startPage: 0, pageCount: 1 }, { startPage: 1, pageCount: pdfMaxPages + 1 }, { startPage: 1.5, pageCount: 1 }])("rejects invalid range %j", async (range) => {
  await expect(readPDF(pdf(["one"]), range)).rejects.toThrow("Invalid PDF request");
});

test("malformed input returns a sanitized error", async () => {
  await expect(readPDF(new TextEncoder().encode("private-malformed-payload"), { startPage: 1, pageCount: 1 })).rejects.toThrow("This PDF could not be read");
});

/** A damaged part refuses the read rather than being skipped: the page's text with a piece
 * missing would be returned as the whole page. */
test("a page drawing an object that isn't there refuses the read", async () => {
  const page = "BT /F1 12 Tf 30 700 Td (Before) Tj ET /Im9 Do BT /F1 12 Tf 30 680 Td (After) Tj ET";
  await expect(readPDF(pdf([page], "", false, true), { startPage: 1, pageCount: 1 })).rejects.toThrow("This PDF could not be read");
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

/** One page of text and an image whose data brings the file to just under `documentMaxBytes`. */
function imagePDF(size: number): Uint8Array {
  const text = "BT /F1 12 Tf 30 700 Td (Report page with an image.) Tj ET";
  const head = (image: number) => [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [4 0 R] >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 1024 /Height ${Math.ceil(image / 1024)} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${image} >>\nstream\n`,
  ];
  const build = (image: number) => {
    const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
    const offsets: number[] = [];
    let length = parts[0]!.length;
    const add = (part: Buffer) => { parts.push(part); length += part.length; };
    head(image).forEach((object, i) => {
      offsets.push(length);
      add(Buffer.from(`${i + 1} 0 obj\n${object}`));
      if (i === 5) add(Buffer.alloc(image, 0x5a));
      add(Buffer.from(i === 5 ? "\nendstream\nendobj\n" : "\nendobj\n"));
    });
    add(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
    return Buffer.concat(parts);
  };
  // The header's numbers grow with the image; settle the image size until the file is exact.
  let image = size - build(0).length;
  for (let built = build(image); built.length !== size; built = build(image)) image += size - built.length;
  return new Uint8Array(build(image));
}

/** Files up to the advertised limit read: the document's bytes are never expanded per byte inside
 * the parser's fixed memory. */
test("the bounded parser reads a PDF just under the file size limit", async () => {
  const bytes = imagePDF(documentMaxBytes - 1024);
  expect(bytes.byteLength).toBe(documentMaxBytes - 1024);
  const result = await extractPDF(bytes, { startPage: 1, pageCount: 1 });
  expect(result.pages).toEqual([{ number: 1, text: "Report page with an image." }]);
}, 60_000);
