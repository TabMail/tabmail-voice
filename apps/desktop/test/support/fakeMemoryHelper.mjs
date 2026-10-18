// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A stand-in memory helper for MemoryHelper's tests, speaking the search helper's native messaging
// (each message a 4-byte little-endian length, then that much UTF-8 JSON) and keeping memory in a
// list: a search finds the rows holding every word of `q`, the newest first; a read gives those within
// `toleranceMs`, the oldest first; a row's size is its content's UTF-8 length.
//
// It records, in the `--log-dir` it is given: `starts.log` (a line per start), `init.json` (the last
// `init`'s params) and `ends.log` (a line per stdin closed). Flags, after the script's path:
//   --init-error            answers `init` with an error
//   --error-on <method>     answers <method> with an error
//   --exit-on <method>      exits on <method> without answering
//   --silent-on <method>    never answers <method>
//   --slow-on <method> <ms> answers <method> after <ms>
//   --bad-on <method>       answers <method> with `{ "ok": true }`, a shape it never has
//   --linger <ms>           exits <ms> after its stdin closes, not at once
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? "");
};
const logDir = flag("--log-dir");
appendFileSync(join(logDir, "starts.log"), `${process.pid}\n`);

const rows = [];
// What the real helper's empty database takes (bytes): its schema's pages.
const emptyBytes = 4_096;
const size = (row) => Buffer.byteLength(row.content, "utf8");
const used = () => rows.reduce((total, row) => total + size(row), 0);
function trimTo(maxBytes) {
  rows.sort((a, b) => a.dateMs - b.dateMs);
  let trimmed = 0;
  while (rows.length > 0 && used() > maxBytes) {
    rows.shift();
    trimmed += 1;
  }
  // Emptied, the database still takes its schema: a limit below that is never met.
  return { trimmed, usedBytes: used(), withinLimit: rows.length > 0 ? used() <= maxBytes : maxBytes >= emptyBytes };
}

function answer(method, params) {
  switch (method) {
    case "init":
      writeFileSync(join(logDir, "init.json"), JSON.stringify(params));
      return { ok: true, memoryDocs: rows.length };
    case "memoryIndexBatch": {
      rows.push(...params.rows);
      return { ok: true, count: params.rows.length, skippedDuplicates: 0, ...(params.maxBytes ? trimTo(params.maxBytes) : {}) };
    }
    case "memorySearch": {
      const words = params.q.toLowerCase().split(/\s+/).filter((word) => word !== "");
      return rows
        .filter((row) => words.every((word) => row.content.toLowerCase().includes(word)))
        .sort((a, b) => b.dateMs - a.dateMs)
        .slice(0, params.limit)
        .map(({ memId, content, dateMs }) => ({ memId, content, dateMs }));
    }
    case "memoryRead":
      return rows
        .filter((row) => Math.abs(row.dateMs - params.timestampMs) <= params.toleranceMs)
        .sort((a, b) => a.dateMs - b.dateMs)
        .map(({ memId, content, dateMs }) => ({ memId, content, dateMs, snippet: "" }));
    case "memoryStats":
      return { ok: true, docs: rows.length, vecDocs: 0, dbBytes: used(), usedBytes: used() };
    case "memoryTrim":
      return { ok: true, ...trimTo(params.maxBytes) };
    case "memoryRemoveBatch": {
      const before = rows.length;
      const kept = rows.filter((row) => !params.ids.includes(row.memId));
      rows.splice(0, rows.length, ...kept);
      return { ok: true, count: before - rows.length };
    }
    case "memoryClear":
      rows.splice(0, rows.length);
      return { ok: true };
    default:
      return undefined;
  }
}

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([prefix, body]));
}

function handle({ id, method, params }) {
  if (flag("--exit-on") === method) process.exit(3);
  if (flag("--silent-on") === method) return;
  const reply = () => {
    if ((method === "init" && args.includes("--init-error")) || flag("--error-on") === method) return send({ id, error: `${method} failed` });
    if (flag("--bad-on") === method) return send({ id, result: { ok: true } });
    const result = answer(method, params);
    send(result === undefined ? { id, error: `Unknown method: ${method}` } : { id, result });
  };
  if (flag("--slow-on") === method) setTimeout(reply, Number(args[args.indexOf("--slow-on") + 2]));
  else reply();
}

let buffered = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32LE(0);
    if (buffered.length < 4 + length) break;
    const body = buffered.subarray(4, 4 + length).toString("utf8");
    buffered = buffered.subarray(4 + length);
    handle(JSON.parse(body));
  }
});
process.stdin.on("end", () => {
  appendFileSync(join(logDir, "ends.log"), `${process.pid}\n`);
  const linger = flag("--linger");
  if (linger === null) process.exit(0);
  setTimeout(() => process.exit(0), Number(linger));
});
