// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createInterface } from "node:readline";
const target = { window: "00000000-0000-0000-0000-000000000001", pid: 123 };
const state = { pending: false, canceled: false, keys: 0, addressed: null };
let pending;
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const r = JSON.parse(line);
  if (r.method === "captureTarget") reply(r.id, target);
  else if (r.method === "pasteTarget") {
    state.pending = true; state.addressed = r.params.target; pending = r.id;
  } else if (r.method === "cancelPaste") {
    if (r.params.target.window === target.window && r.params.target.pid === target.pid) state.canceled = true;
    reply(r.id, {});
  } else if (r.method === "advance") {
    if (state.pending && !state.canceled) state.keys++;
    state.pending = false;
    if (pending !== undefined) reply(pending, {});
    reply(r.id, {});
  } else if (r.method === "state") reply(r.id, state);
}).on("close", () => process.exit(0));
