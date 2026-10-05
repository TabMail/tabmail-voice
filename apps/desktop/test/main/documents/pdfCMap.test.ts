// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";

const limit = vi.hoisted(() => ({ bytes: 128 * 1024 }));
vi.mock("../../../src/core/config.js", async (original) => ({
  ...await original<typeof import("../../../src/core/config.js")>(),
  get pdfCMapMaxBytes() { return limit.bytes; },
}));
import { bundledCMap } from "../../../src/main/documents/pdfRealm.js";

const directory = join(dirname(require.resolve("pdfjs-dist/package.json")), "cmaps");

test("returns a bundled CMap by its file name", () => {
  expect(bundledCMap("UniJIS-UCS2-H.bcmap")).toEqual(new Uint8Array(readFileSync(join(directory, "UniJIS-UCS2-H.bcmap"))));
});

/** A font may name anything: only a bundled file, by its plain name, is ever read. */
test.each(["LICENSE", "../package.json", "../LICENSE", "UniJIS-UCS2-H", "UniJIS-UCS2-H.bcmap/", "sub/UniJIS-UCS2-H.bcmap", "Synthetic-Missing-H.bcmap", "UniJIS-UCS2-H.bcmap\u0000", ".bcmap", ""])("refuses %j", (name) => {
  expect(bundledCMap(name)).toBeNull();
});

test("refuses a bundled CMap past the size bound", () => {
  const size = readFileSync(join(directory, "UniJIS-UCS2-H.bcmap")).byteLength;
  limit.bytes = size - 1;
  try { expect(bundledCMap("UniJIS-UCS2-H.bcmap")).toBeNull(); } finally { limit.bytes = 128 * 1024; }
  limit.bytes = size;
  try { expect(bundledCMap("UniJIS-UCS2-H.bcmap")).not.toBeNull(); } finally { limit.bytes = 128 * 1024; }
});
