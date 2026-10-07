// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A stand-in native helper for HelperClient's tests, speaking the helpers' JSON-lines protocol:
// `echo` answers its params, `fail` answers an error, `silent` never answers, `exit` exits (with `params.code`
// where given), `emit`
// sends an event, `log` writes a debug and an error line to stderr, `ids` answers its process id,
// `hang` blocks forever without reading its stdin again (a read stuck in a provider), `breaks` answers text
// holding U+2028 and U+2029 (a terminal's box joins its rows with U+2029), which JSON leaves unescaped.
import { createInterface } from "node:readline";

const deferred = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  switch (method) {
    case "cancel": {
      clearTimeout(deferred.get(params.id));
      deferred.delete(params.id);
      return send({ event: "canceled", request: params.id });
    }
    case "deferred":
      send({ event: "queued", request: id });
      deferred.set(id, setTimeout(() => {
        deferred.delete(id);
        send({ event: "action", action: params.action });
        send({ id, result: {} });
      }, params.delay));
      return;
    case "echo":
      return send({ id, result: params });
    case "fail":
      return send({ id, error: { message: "fail needs nothing" } });
    case "silent":
      return;
    case "exit":
      return process.exit(params.code ?? 3);
    case "emit":
      send({ event: "action", action: params.action });
      return send({ id, result: {} });
    case "log":
      process.stderr.write("debug something happened\nerror something failed\n");
      return send({ id, result: {} });
    case "breaks":
      return send({ id, result: { value: "row one\u2029row two\u2028end" } });
    case "pid":
      return send({ id, result: { pid: process.pid } });
    case "hang":
      for (;;);
    default:
      return send({ id, error: { message: `unknown method ${method}` } });
  }
}).on("close", () => process.exit(0));
