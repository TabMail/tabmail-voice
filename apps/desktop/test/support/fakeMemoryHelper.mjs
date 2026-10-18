// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A stand-in memory helper for MemoryHelper's tests, speaking the search helper's native messaging
// (each message a 4-byte little-endian length, then that much UTF-8 JSON) and keeping memory in a
// list: a search finds the rows holding every word of `q`, the newest first; a read gives those within
// `toleranceMs`, the oldest first; a row's size is its content's UTF-8 length. As the real helper:
// - memory lives in a file, `tabmail_fts/memory.db` in `init`'s `profilePath` (here the rows' JSON),
//   read at `init` and written after every change, so a helper started again finds it;
// - a search refuses what its full-text query syntax can't take (`re: invoice`, `50%`, `(x`,
//   `x AND`), with an error quoting the query, as SQLite's does;
// - each search writes a warning naming the query to stderr;
// - a search honours `from`/`to` (ISO dates; empty is no bound) unless `ignoreDate`;
// - `init` makes the database folder, and exits without answering when it can't (the real helper's
//   init failures end it); it says whether the embedding model loaded (`hasEmbeddings`);
// - unless `--log-level off`, it writes a log file naming each query in its `--log-dir`, which it
//   creates; at `off` it creates and writes nothing there.
//
// It records, in the `--record-dir` it is given (the test's, apart from memory's folder):
// `starts.log` (a line per start), `args.json` (the last start's arguments), `init.json` (the last
// `init`'s params) and `ends.log` (a line per stdin closed). Flags, after the script's path:
//   --record-dir <dir>      where it records
//   --clear-keeps-rows      answers `memoryClear` ok and keeps every row, as the real helper does
//                           when the files can't be deleted (Windows, with them open)
//   --init-error            answers `init` with an error
//   --no-model              answers `init` with `hasEmbeddings: false`, as when the model's download
//                           failed
//   --error-on <method>     answers <method> with an error
//   --exit-on <method>      exits on <method> without answering
//   --silent-on <method>    never answers <method>
//   --slow-on <method> <ms> answers <method> after <ms>
//   --bad-on <method>       answers <method> with `{ "ok": true }`, a shape it never has
//   --linger <ms>           exits <ms> after its stdin closes, not at once
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? "");
};
const recordDir = flag("--record-dir");
appendFileSync(join(recordDir, "starts.log"), `${process.pid}\n`);
writeFileSync(join(recordDir, "args.json"), JSON.stringify(args));
const logDir = flag("--log-dir");
const logLevel = flag("--log-level") ?? "debug";
function logLine(line) {
  if (logLevel === "off") return;
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, "fts_helper.log"), `${line}\n`);
}

const rows = [];
/** Memory's file, from `init`. */
let memoryFile = null;
function save() {
  writeFileSync(memoryFile, JSON.stringify(rows));
}
/** What the real helper's query parser refuses. */
const refused = (q) => /[%():]/.test(q) || /(^|\s)(AND|OR|NOT|NEAR)(\s|$)/.test(q);
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
    case "init": {
      writeFileSync(join(recordDir, "init.json"), JSON.stringify(params));
      const folder = join(params.profilePath, "tabmail_fts");
      try {
        mkdirSync(folder, { recursive: true });
      } catch {
        process.exit(4);
      }
      memoryFile = join(folder, "memory.db");
      if (existsSync(memoryFile)) rows.push(...JSON.parse(readFileSync(memoryFile, "utf8")));
      save();
      return { ok: true, memoryDocs: rows.length, hasEmbeddings: !args.includes("--no-model") };
    }
    case "memoryIndexBatch": {
      rows.push(...params.rows);
      const trim = params.maxBytes ? trimTo(params.maxBytes) : {};
      save();
      return { ok: true, count: params.rows.length, skippedDuplicates: 0, ...trim };
    }
    case "memorySearch": {
      process.stderr.write(`WARN memory search: "${params.q}"\n`);
      logLine(`Memory search params: "${params.q}"`);
      if (refused(params.q)) throw new Error(`fts5: syntax error near "${params.q}"`);
      const words = params.q.toLowerCase().split(/\s+/).filter((word) => word !== "");
      const bound = (date) => (params.ignoreDate || !date ? null : Date.parse(date));
      const [from, to] = [bound(params.from), bound(params.to)];
      return rows
        .filter((row) => words.every((word) => row.content.toLowerCase().includes(word)))
        .filter((row) => (from === null || row.dateMs >= from) && (to === null || row.dateMs <= to))
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
    case "memoryTrim": {
      const trim = trimTo(params.maxBytes);
      save();
      return { ok: true, ...trim };
    }
    case "memoryRemoveBatch": {
      const before = rows.length;
      const kept = rows.filter((row) => !params.ids.includes(row.memId));
      rows.splice(0, rows.length, ...kept);
      save();
      return { ok: true, count: before - rows.length };
    }
    case "memoryClear":
      if (!args.includes("--clear-keeps-rows")) rows.splice(0, rows.length);
      save();
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
    let result;
    try {
      result = answer(method, params);
    } catch (error) {
      return send({ id, error: error.message });
    }
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
  appendFileSync(join(recordDir, "ends.log"), `${process.pid}\n`);
  const linger = flag("--linger");
  if (linger === null) process.exit(0);
  setTimeout(() => process.exit(0), Number(linger));
});
