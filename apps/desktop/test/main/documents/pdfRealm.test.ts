// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ allocationBytes: 32 }));
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
      const path = String(args[0]).replaceAll("\\", "/");
      if (path.endsWith("/pdf.worker.mjs")) return "export const WorkerMessageHandler = {};";
      if (path.endsWith("/pdf.mjs")) return `
        export function getDocument() {
          let text = "allocated";
          // Deliberately catch the allocation exception and offer a plausible
          // successful result. The host must retain its refusal independently.
          try { new Uint8Array(${fixture.allocationBytes}); }
          catch { text = "caught"; }
          return {
            promise: Promise.resolve({ numPages: 1, getPage: async () => ({
              streamTextContent: () => new ReadableStream({ start(controller) {
                controller.enqueue({ items: [{ str: text, hasEOL: false }] });
                controller.close();
              } }),
              cleanup() {},
            }) }),
            async destroy() {},
          };
        }
      `;
      return original.readFileSync(...args);
    },
  };
});

import { extractPDFInRealm } from "../../../src/main/documents/pdfRealm.js";

test("a caught oversized allocation still refuses the read, then a fresh realm recovers", async () => {
  const read = () => extractPDFInRealm(new Uint8Array([1]), { startPage: 1, pageCount: 1 });
  expect((await read()).pages).toEqual([{ number: 1, text: "allocated" }]);
  fixture.allocationBytes = 1024 * 1024 * 1024;
  try {
    await expect(read()).rejects.toThrow("This PDF could not be read, or the requested page is unavailable.");
  } finally {
    fixture.allocationBytes = 32;
  }
  expect((await read()).pages).toEqual([{ number: 1, text: "allocated" }]);
});
