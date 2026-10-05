// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSHandle } from "quickjs-emscripten-core";
import type { PDFRange, PDFText } from "../../core/agent/connectors/pdf.js";
import { documentMaxBytes, pdfMaxPages, pdfMaxTextBytes, pdfProcessTimeout, pdfRealmEncodingLabelMax, pdfRealmMemoryPages, pdfRealmStackBytes } from "../../core/config.js";
import { extractPDFDocument } from "./pdfExtraction.js";
import { pdfRealmPrelude } from "./pdfRealmPrelude.js";

// Node exposes this runtime API but this main-process project omits DOM typings.
declare const WebAssembly: { Memory: new (limits: { initial: number; maximum: number }) => {
  readonly buffer: ArrayBuffer; grow(pages: number): number;
} };

const unreadable = "This PDF could not be read, or the requested page is unavailable.";
const passwordRequired = "This PDF requires a password.";

/** This function belongs only in the disposable PDF utility process. */
export async function extractPDFInRealm(bytes: Uint8Array, range: PDFRange): Promise<PDFText> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > documentMaxBytes ||
    !Number.isSafeInteger(range.startPage) || range.startPage < 1 || !Number.isSafeInteger(range.pageCount) ||
    range.pageCount < 1 || range.pageCount > pdfMaxPages) throw new Error("Invalid PDF request.");
  try {
    return await parseInRealm(bytes, range);
  } catch (error) {
    // Include interpreter construction and disposal failures in the privacy boundary.
    // eslint-disable-next-line preserve-caught-error -- No parser or runtime details leave the utility process.
    throw new Error(error instanceof Error && error.message === passwordRequired ? passwordRequired : unreadable);
  }
}

async function parseInRealm(bytes: Uint8Array, range: PDFRange): Promise<PDFText> {
  const deadline = Date.now() + pdfProcessTimeout;
  let refused = false;
  // One fixed parser arena, ArrayBuffers included.
  const memory = new WebAssembly.Memory({ initial: pdfRealmMemoryPages, maximum: pdfRealmMemoryPages });
  const grow = memory.grow.bind(memory);
  memory.grow = (pages: number) => {
    // Even grow(0) would detach outstanding views in this Emscripten wrapper.
    if (pages === 0) return pdfRealmMemoryPages;
    try { return grow(pages); } catch (error) { refused = true; throw error; }
  };
  const engine = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory: memory }));
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(-1); // The fixed WASM arena enforces the actual allocation bound.
  runtime.setMaxStackSize(pdfRealmStackBytes);
  runtime.setInterruptHandler(() => {
    refused ||= Date.now() >= deadline;
    return refused;
  });
  const context = runtime.newContext();
  const fail = (): never => { refused = true; throw new Error(unreadable); };
  const evaluate = (code: string, name = "bootstrap.js", module = false): void => {
    const result = context.evalCode(code, name, module ? { type: "module" } : undefined);
    if (result.error) { result.error.dispose(); return fail(); }
    result.value.dispose();
  };
  const number = (value: QuickJSHandle): number => {
    if (context.typeof(value) !== "number") return fail();
    return context.getNumber(value);
  };
  const text = (value: QuickJSHandle, maximum: number): string => {
    if (context.typeof(value) !== "string") return fail();
    const length = context.getProp(value, "length");
    try { if (number(length) > maximum) return fail(); } finally { length.dispose(); }
    return context.getString(value);
  };
  let bufferLength: QuickJSHandle | undefined;
  try {
    const modules = new Map<string, string>([
      ["pdf", readFileSync(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"), "utf8")],
      ["worker", readFileSync(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"), "utf8")],
    ]);
    runtime.setModuleLoader(name => modules.get(name) ?? fail(), (_base, requested) => requested);
    const lengthFunction = context.evalCode("((get, apply) => value => apply(get, value, []))(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get, Reflect.apply)");
    if (lengthFunction.error) { lengthFunction.error.dispose(); return fail(); }
    bufferLength = lengthFunction.value;
    const decode = context.newFunction("decode", (buffer, encoding, fatal, ignoreBOM) => {
      const lengthResult = context.callFunction(bufferLength!, context.undefined, buffer);
      if (lengthResult.error) { lengthResult.error.dispose(); return fail(); }
      let length: number;
      try { length = number(lengthResult.value); } finally { lengthResult.value.dispose(); }
      if (!Number.isSafeInteger(length) || length < 0 || length > documentMaxBytes) return fail();
      if (context.typeof(fatal) !== "boolean" || context.typeof(ignoreBOM) !== "boolean") return fail();
      const decoder = new TextDecoder(text(encoding, pdfRealmEncodingLabelMax), { fatal: context.dump(fatal), ignoreBOM: context.dump(ignoreBOM) });
      if (!length) return context.newString(decoder.decode());
      const view = context.getArrayBuffer(buffer);
      try { return context.newString(decoder.decode(view.value)); } finally { view.dispose(); }
    });
    const encode = context.newFunction("encode", value => {
      const encoded = new TextEncoder().encode(text(value, documentMaxBytes));
      if (encoded.byteLength > documentMaxBytes) return fail();
      return context.newArrayBuffer(encoded.buffer);
    });
    const refuse = context.newFunction("refuse", () => { refused = true; });
    for (const [name, handle] of [["hostDecode", decode], ["hostEncode", encode], ["hostRefuse", refuse]] as const) {
      context.setProp(context.global, name, handle); handle.dispose();
    }
    evaluate(pdfRealmPrelude);
    evaluate(readFileSync(require.resolve("abort-controller/dist/abort-controller.umd.js"), "utf8"));
    evaluate(readFileSync(require.resolve("web-streams-polyfill/polyfill"), "utf8"));
    const input = context.newArrayBuffer(Uint8Array.from(bytes).buffer);
    context.setProp(context.global, "pdfInput", input); input.dispose();
    // Serialize only our trusted, dependency-explicit function, never document text.
    evaluate(`
      import { WorkerMessageHandler } from "worker";
      import { getDocument } from "pdf";
      globalThis.pdfjsWorker = { WorkerMessageHandler };
      const extract = ${extractPDFDocument.toString()};
      globalThis.pdfDone = false;
      extract(getDocument, new Uint8Array(pdfInput), ${JSON.stringify({ startPage: range.startPage, pageCount: range.pageCount })}, ${pdfMaxTextBytes})
        .then(value => { globalThis.pdfReply = JSON.stringify({ ok: true, value }); })
        .catch(error => { globalThis.pdfReply = JSON.stringify({ ok: false, password: error instanceof Error && error.message === ${JSON.stringify(passwordRequired)} }); })
        .finally(() => { globalThis.pdfDone = true; });
    `, "extract.mjs", true);
    while (!refused) {
      if (Date.now() >= deadline) fail();
      if (runtime.hasPendingJob()) {
        const result = runtime.executePendingJobs(1);
        if (result.error) { result.error.dispose(); return fail(); }
      }
      evaluate("pdfTick()");
      const done = context.getProp(context.global, "pdfDone");
      let complete: boolean;
      try { complete = context.dump(done) === true; } finally { done.dispose(); }
      if (complete) break;
      if (!runtime.hasPendingJob()) await wait(1);
    }
    if (refused) fail();
    const reply = context.getProp(context.global, "pdfReply");
    let serialized: string;
    try { serialized = text(reply, pdfMaxTextBytes * 6 + 4096); } finally { reply.dispose(); }
    const result = JSON.parse(serialized) as { ok: boolean; password?: boolean; value: PDFText };
    if (!result.ok) throw new Error(result.password ? passwordRequired : unreadable);
    return result.value;
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Parser contents never leave this boundary.
    throw new Error(!refused && error instanceof Error && error.message === passwordRequired ? passwordRequired : unreadable);
  } finally {
    runtime.removeInterruptHandler();
    bufferLength?.dispose();
    context.dispose();
    runtime.dispose();
  }
}
