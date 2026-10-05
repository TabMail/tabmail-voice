// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Trusted bootstrap evaluated inside the fixed-memory interpreter. Rendering,
 * fetch, native workers and decompression APIs are intentionally unavailable. */
export const pdfRealmPrelude = String.raw`
globalThis.console = { log(){}, warn(){}, error(){}, info(){}, assert(){} };
globalThis.performance = { now: () => Date.now() };
globalThis.DOMException = class DOMException extends Error {
  constructor(message, name = "Error") { super(message); this.name = name; }
};
for (const name of ["Blob", "Response"]) {
  globalThis[name] = class { constructor() { throw new Error("Unavailable PDF capability"); } };
}
globalThis.TextDecoder = class {
  constructor(encoding = "utf-8", options = {}) {
    this.encoding = String(encoding); this.fatal = !!options.fatal; this.ignoreBOM = !!options.ignoreBOM;
    hostDecode(new ArrayBuffer(0), this.encoding, this.fatal, this.ignoreBOM);
  }
  decode(input = new Uint8Array(), options = {}) {
    if (options.stream) { hostRefuse(); throw new Error("Streaming decoder unavailable"); }
    if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) throw new TypeError("Expected buffer");
    if (input.byteLength > 20 * 1024 * 1024) { hostRefuse(); throw new Error("Decoder bound"); }
    const bytes = input instanceof ArrayBuffer ? input : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    return hostDecode(bytes, this.encoding, this.fatal, this.ignoreBOM);
  }
};
globalThis.TextEncoder = class {
  get encoding() { return "utf-8"; }
  encode(input = "") { return new Uint8Array(hostEncode(String(input))); }
  encodeInto(input, target) {
    if (!(target instanceof Uint8Array)) throw new TypeError("Expected Uint8Array");
    let read = 0, written = 0;
    for (const scalar of String(input)) {
      const bytes = this.encode(scalar);
      if (written + bytes.length > target.length) break;
      target.set(bytes, written); written += bytes.length; read += scalar.length;
    }
    return { read, written };
  }
};
{
  const timers = new Map(); let next = 1;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") throw new TypeError("Function required");
    if (timers.size >= 256) { hostRefuse(); throw new Error("Timer bound"); }
    const id = next++;
    const ms = Math.min(2147483647, Math.max(0, Number(delay) || 0));
    timers.set(id, { callback, args, due: Date.now() + ms }); return id;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.pdfTick = () => {
    const now = Date.now();
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now && timers.delete(id)) timer.callback(...timer.args);
    }
    return timers.size;
  };
}
`;

export const pdfClonePrelude = String.raw`
import clone from "clone/index.js";
globalThis.structuredClone = (value, options = {}) => {
  const transfer = options?.transfer === undefined ? [] : Array.from(options.transfer);
  const seen = new Set();
  for (const buffer of transfer) {
    if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) throw new DOMException("Invalid transfer", "DataCloneError");
    buffer.slice(0, 0); seen.add(buffer);
  }
  const result = clone(value);
  for (const buffer of transfer) buffer.transfer(0);
  return result;
};
`;
