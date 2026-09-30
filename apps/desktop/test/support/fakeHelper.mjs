// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A stand-in native helper for HelperClient's tests, speaking the helpers' JSON-lines protocol:
// `echo` answers its params, `fail` answers an error, `silent` never answers, `exit` exits, `emit`
// sends an event, `log` writes a debug and an error line to stderr, `ids` answers its process id.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  switch (method) {
    case "echo":
      return send({ id, result: params });
    case "fail":
      return send({ id, error: { message: "fail needs nothing" } });
    case "silent":
      return;
    case "exit":
      return process.exit(3);
    case "emit":
      send({ event: "action", action: params.action });
      return send({ id, result: {} });
    case "log":
      process.stderr.write("debug something happened\nerror something failed\n");
      return send({ id, result: {} });
    case "pid":
      return send({ id, result: { pid: process.pid } });
    default:
      return send({ id, error: { message: `unknown method ${method}` } });
  }
}).on("close", () => process.exit(0));
