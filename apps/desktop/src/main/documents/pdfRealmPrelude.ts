// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { pdfRealmTimerMax } from "../../core/config.js";

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
    if (timers.size >= ${pdfRealmTimerMax}) { hostRefuse(); throw new Error("Timer bound"); }
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
{
  // pdf.js's in-process worker port clones every message. Binary data stays
  // binary, so a document is never expanded into a per-byte copy inside the
  // fixed arena. Every buffer is copied while the value is walked, and the
  // transferred ones are detached only after it, so no view meets a detached
  // buffer (structured clone, HTML 2.7).
  const fail = () => { throw new DOMException("Value cannot be cloned", "DataCloneError"); };
  globalThis.structuredClone = (value, options) => {
    const transfer = options?.transfer === undefined ? [] : Array.from(options.transfer);
    const moving = new Set();
    for (const buffer of transfer) {
      if (!(buffer instanceof ArrayBuffer) || moving.has(buffer) || buffer.detached) fail();
      moving.add(buffer);
    }
    const copies = new Map();
    const copy = item => {
      if (typeof item === "function" || typeof item === "symbol") fail();
      if (item === null || typeof item !== "object") return item;
      if (copies.has(item)) return copies.get(item);
      const fill = (result, entries) => { copies.set(item, result); entries(result); return result; };
      if (item instanceof ArrayBuffer) return fill(item.slice(0), () => {});
      if (ArrayBuffer.isView(item)) {
        return fill(new item.constructor(copy(item.buffer), item.byteOffset, item instanceof DataView ? item.byteLength : item.length), () => {});
      }
      if (item instanceof Date) return fill(new Date(item.getTime()), () => {});
      if (item instanceof RegExp) return fill(new RegExp(item.source, item.flags), () => {});
      if (item instanceof Error) return fill(new Error(item.message), result => { result.name = item.name; });
      if (item instanceof Map) return fill(new Map(), result => { for (const [key, entry] of item) result.set(copy(key), copy(entry)); });
      if (item instanceof Set) return fill(new Set(), result => { for (const entry of item) result.add(copy(entry)); });
      return fill(Array.isArray(item) ? new Array(item.length) : {}, result => { for (const key of Object.keys(item)) result[key] = copy(item[key]); });
    };
    const result = copy(value);
    for (const buffer of moving) buffer.transfer(0);
    return result;
  };
}
`;
