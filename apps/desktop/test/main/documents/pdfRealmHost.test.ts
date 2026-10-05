// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, expect, test, vi } from "vitest";

/** The realm runs `extractPDFDocument`'s source; these tests swap in a probe that drives the
 * interpreter's host functions as hostile code would. A probe is serialized, so it may use only
 * the realm's globals. */
const realm = vi.hoisted(() => ({ probe: null as unknown, timeout: 15_000 }));
vi.mock("../../../src/main/documents/pdfExtraction.js", () => ({
  get extractPDFDocument() { return realm.probe; },
}));
vi.mock("../../../src/core/config.js", async (original) => ({
  ...await original<typeof import("../../../src/core/config.js")>(),
  get pdfProcessTimeout() { return realm.timeout; },
}));
import { documentMaxBytes, pdfCMapNameMax, pdfRealmEncodingLabelMax } from "../../../src/core/config.js";
import { extractPDFInRealm } from "../../../src/main/documents/pdfRealm.js";

// Every run here starts the bounded parser, which takes seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

const unreadable = /^This PDF could not be read, or the requested page is unavailable\.$/u;
const range = { startPage: 1, pageCount: 1 };
const read = (probe: unknown) => { realm.probe = probe; return extractPDFInRealm(new Uint8Array([1]), range); };
afterEach(() => { realm.timeout = 15_000; });

test("a probe's reply comes back, and host decoding reads the bytes it is given", async () => {
  const result = await read(async () => {
    const text = hostDecode(new TextEncoder().encode("Größe").buffer, "utf-8", false, false);
    return { totalPages: 1, pages: [{ number: 1, text }], nextPage: null, truncated: false, before: "", after: "" };
  });
  expect(result.pages).toEqual([{ number: 1, text: "Größe" }]);
});

/** Each refusal ends the read even when the realm's code catches the error and replies anyway. */
test.each([
  ["a streaming decode", "new TextDecoder('utf-8').decode(new Uint8Array([0xe4]), { stream: true })"],
  ["a decode of something not an ArrayBuffer", "hostDecode('text', 'utf-8', false, false)"],
  ["a decode with a non-boolean option", "hostDecode(new ArrayBuffer(1), 'utf-8', 1, false)"],
  ["a decode with a non-string label", "hostDecode(new ArrayBuffer(1), 1, false, false)"],
  ["a decode with an overlong label", `hostDecode(new ArrayBuffer(1), '${"u".repeat(pdfRealmEncodingLabelMax + 1)}', false, false)`],
  ["an encode of a non-string", "hostEncode(1)"],
  ["an encode of an object with a length", "hostEncode({ length: 1 })"],
  ["an encode past the size bound", `hostEncode('é'.repeat(${documentMaxBytes / 2 + 1}))`],
  ["a CMap name that is not a string", "hostCMap(1)"],
  ["an overlong CMap name", `hostCMap('${"a".repeat(pdfCMapNameMax + 1)}')`],
  ["an explicit refusal", "hostRefuse()"],
  ["a missing tick", "delete globalThis.pdfTick"],
])("refuses %s", async (_name, call) => {
  // The probe's source is the realm's program.
  const probe = new Function(`return async () => {
    try { ${call}; } catch {}
    return { totalPages: 1, pages: [], nextPage: null, truncated: false, before: "", after: "" };
  }`)() as unknown;
  await expect(read(probe)).rejects.toThrow(unreadable);
});

test("a run past its deadline is ended, even inside one long job", async () => {
  realm.timeout = 200;
  const started = Date.now();
  await expect(read(async () => { for (;;); })).rejects.toThrow(unreadable);
  expect(Date.now() - started).toBeLessThan(5_000);
});

/** A parse error's message may quote the document: none of it leaves the realm. */
test("a malformed reply is refused without its contents", async () => {
  const error = await read(() => {
    globalThis.pdfReply = "{syntheticPrivate123";
    globalThis.pdfDone = true;
    return new Promise(() => {});
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(unreadable);
});

declare global {
  function hostDecode(buffer: unknown, encoding: unknown, fatal: unknown, ignoreBOM: unknown): string;
  // Realm globals the probe sets.
  var pdfReply: string, pdfDone: boolean;
}
