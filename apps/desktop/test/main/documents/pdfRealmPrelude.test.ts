// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createContext, runInContext } from "node:vm";
import { expect, test } from "vitest";
import { pdfRealmTimerMax } from "../../../src/core/config.js";
import { pdfRealmPrelude } from "../../../src/main/documents/pdfRealmPrelude.js";

/** The prelude in a fresh context of its own, as the parser's interpreter runs it. */
function realm() {
  const refusals: number[] = [];
  const context = createContext({ hostRefuse: () => refusals.push(1) });
  runInContext(pdfRealmPrelude, context);
  return { run: (code: string): unknown => runInContext(code, context), refusals };
}

test("a cloned document stays binary, and a transferred buffer moves", () => {
  const { run } = realm();
  expect(run(`
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const message = { data: bytes, slice: new Uint8Array(bytes.buffer, 1, 2), view: new DataView(bytes.buffer, 2) };
    const copy = structuredClone(message, { transfer: [bytes.buffer] });
    ({
      binary: copy.data instanceof Uint8Array && copy.slice instanceof Uint8Array && copy.view instanceof DataView,
      bytes: [...copy.data], slice: [...copy.slice], view: copy.view.getUint8(0),
      shared: copy.data.buffer === copy.slice.buffer && copy.slice.buffer === copy.view.buffer,
      moved: bytes.buffer.detached && bytes.byteLength === 0,
    })
  `)).toEqual({ binary: true, bytes: [1, 2, 3, 4], slice: [2, 3], view: 3, shared: true, moved: true });
});

test("an untransferred buffer is copied and left in place", () => {
  const { run } = realm();
  expect(run(`
    const bytes = new Uint8Array([5, 6]);
    const copy = structuredClone({ bytes });
    copy.bytes[0] = 9;
    ({ original: [...bytes], copy: [...copy.bytes], detached: bytes.buffer.detached })
  `)).toEqual({ original: [5, 6], copy: [9, 6], detached: false });
});

test("plain values, collections and shared references clone as structured clone does", () => {
  const { run } = realm();
  expect(run(`
    const shared = { n: 1 };
    const value = { list: [shared, shared], map: new Map([["k", shared]]), set: new Set([2]), when: new Date(5), pattern: /a/g,
      error: Object.assign(new Error("m"), { name: "TypeError" }), nothing: null, text: "t" };
    const copy = structuredClone(value);
    ({
      separate: copy !== value && copy.list[0] !== shared,
      sharedKept: copy.list[0] === copy.list[1] && copy.map.get("k") === copy.list[0],
      set: [...copy.set], when: copy.when.getTime(), pattern: String(copy.pattern), error: [copy.error.name, copy.error.message],
      rest: [copy.nothing, copy.text],
    })
  `)).toEqual({ separate: true, sharedKept: true, set: [2], when: 5, pattern: "/a/g", error: ["TypeError", "m"], rest: [null, "t"] });
});

test.each(["structuredClone({ f() {} })", "structuredClone(1, { transfer: [1] })", "const b = new ArrayBuffer(1); structuredClone(b, { transfer: [b, b] })"])("refuses what can't be cloned: %s", (code) => {
  const { run } = realm();
  expect(run(`try { ${code}; "cloned" } catch (error) { error.name }`)).toBe("DataCloneError");
});

test("a document can't hold more than the timer bound pending", () => {
  const { run, refusals } = realm();
  expect(run(`for (let i = 0; i < ${pdfRealmTimerMax}; i += 1) setTimeout(() => {}, 1000); "ok"`)).toBe("ok");
  expect(refusals).toEqual([]);
  expect(run(`try { setTimeout(() => {}, 1000); "added" } catch (error) { error.message }`)).toBe("Timer bound");
  expect(refusals).toEqual([1]);
});
