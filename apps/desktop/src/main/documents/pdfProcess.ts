// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { app, utilityProcess } from "electron";
import { join } from "node:path";
import type { PDFRange, PDFText } from "../../core/agent/connectors/pdf.js";
import { documentMaxBytes, pdfMaxPages, pdfMaxTextBytes, pdfProcessHeapMiB, pdfProcessMemoryKiB, pdfProcessPollInterval, pdfProcessTimeout, pdfRedactionContext } from "../../core/config.js";
import { CancellationError } from "../../core/util/timeout.js";

/** Parent-owned limits remain effective when the parser's event loop is blocked.
 * RSS is sampled, not an allocation ceiling; input and returned text are bounded too. */
export function parsePDF(bytes: Uint8Array, range: PDFRange, signal: AbortSignal): Promise<PDFText> {
  if (signal.aborted) return Promise.reject(new CancellationError());
  if (bytes.byteLength > documentMaxBytes) return Promise.reject(new Error("PDF exceeds the file size limit."));
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, "pdfWorker.js"), [], {
      serviceName: "TabMail PDF reader",
      stdio: "ignore",
      env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
      execArgv: [`--max-old-space-size=${pdfProcessHeapMiB}`],
    });
    let settled = false;
    const finish = (error: Error | null, result?: PDFText) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(memory);
      signal.removeEventListener("abort", cancel);
      child.kill();
      if (error !== null) reject(error);
      else if (result !== undefined) resolve(result);
    };
    const cancel = () => finish(new CancellationError());
    const timeout = setTimeout(() => finish(new Error("PDF reading exceeded the time limit.")), pdfProcessTimeout);
    const memory = setInterval(() => {
      try {
        const metric = app.getAppMetrics().find((entry) => entry.pid === child.pid);
        if (metric && metric.memory.workingSetSize > pdfProcessMemoryKiB) finish(new Error("PDF reading exceeded the memory limit."));
      } catch {
        finish(new Error("PDF resource monitoring is unavailable."));
      }
    }, pdfProcessPollInterval);
    signal.addEventListener("abort", cancel, { once: true });
    child.once("spawn", () => {
      // A pre-spawn kill can fail without a PID. End the late worker even when
      // cancellation or a watchdog already settled the request and cleared timers.
      if (settled) {
        child.kill();
        return;
      }
      try { child.postMessage({ bytes, range }); }
      catch { finish(new Error("PDF reader could not start.")); }
    });
    child.once("exit", () => finish(new Error("PDF reader stopped before returning text.")));
    child.once("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("ok" in message)) {
        finish(new Error("PDF reader returned an invalid result."));
      } else if (message.ok === true && "result" in message && validPDFText(message.result, range)) {
        finish(null, message.result);
      } else {
        const password = "reason" in message && message.reason === "password";
        finish(new Error(password ? "This PDF requires a password." : "This PDF could not be read."));
      }
    });
    if (signal.aborted) cancel();
  });
}

/** Never trust process IPC as the output contract. */
function validPDFText(value: unknown, range: PDFRange): value is PDFText {
  if (typeof value !== "object" || value === null || !("pages" in value) || !Array.isArray(value.pages) ||
    !("totalPages" in value) || !Number.isSafeInteger(value.totalPages) || Number(value.totalPages) < 1 ||
    !("truncated" in value) || typeof value.truncated !== "boolean" || !("nextPage" in value) ||
    value.pages.length > pdfMaxPages || value.pages.length > range.pageCount) return false;
  // The redactor's context: the page before's end and a blank line, the rest after.
  for (const context of ["before" in value ? value.before : null, "after" in value ? value.after : null])
    if (typeof context !== "string" || context.length > pdfRedactionContext + 2) return false;
  // No pages only for a start past the last page.
  if (value.pages.length === 0) return range.startPage > Number(value.totalPages) && value.nextPage === null && value.truncated === false;
  let size = 0;
  for (const [index, page] of value.pages.entries()) {
    if (typeof page !== "object" || page === null || page.number !== range.startPage + index || page.number > Number(value.totalPages) || typeof page.text !== "string") return false;
    size += Buffer.byteLength(page.text, "utf8");
    if (size > pdfMaxTextBytes) return false;
  }
  const last = range.startPage + value.pages.length - 1;
  return value.nextPage === (last < Number(value.totalPages) ? last + 1 : null);
}
