// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createInterface } from "node:readline";
const state = { clipboard: "Synthetic prior copy", prepares: 0, finishes: [] };
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "preparePaste") {
    state.clipboard = request.params.text;
    state.prepares++;
    // The native side effect happened, but the caller times out before this reply.
    setTimeout(() => send({ id: request.id, result: { transaction: 7 } }), 6000);
  } else if (request.method === "finishPaste") {
    state.finishes.push(request.params.operation);
    state.clipboard = "Synthetic prior copy";
    send({ id: request.id, result: {} });
  } else if (request.method === "state") send({ id: request.id, result: state });
}).on("close", () => process.exit(0));
