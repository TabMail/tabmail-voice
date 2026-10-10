// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// This process handles one document, with no file path or app credentials. The
// parent suppresses stdout/stderr and kills it after success, failure or timeout.
import { pdfProcessTimeout } from "../../core/config.js";

globalThis.fetch = async () => { throw new Error("PDF network access is disabled."); };
process.parentPort.once("message", async ({ data }: { data: { bytes: Uint8Array; range: import("../../core/agent/connectors/pdf.js").PDFRange } }) => {
  // Held until the reply is posted: once the request is in, nothing else keeps this process's event
  // loop running, and a pending WebAssembly compile holds none of it, so the process could end there,
  // replying nothing.
  const alive = setInterval(() => {}, pdfProcessTimeout);
  try {
    const { extractPDFInRealm } = await import("./pdfRealm.js");
    process.parentPort.postMessage({ ok: true, result: await extractPDFInRealm(data.bytes, data.range) });
  } catch (error) {
    const password = error instanceof Error && error.message === "This PDF requires a password.";
    process.parentPort.postMessage({ ok: false, reason: password ? "password" : "unreadable" });
  } finally {
    clearInterval(alive);
  }
});
