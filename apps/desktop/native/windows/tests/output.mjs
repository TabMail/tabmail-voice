// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
const child = spawn(process.argv[2], [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout });
const timeout = setTimeout(() => child.kill(), 5000);
const exit = once(child, "exit");
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const messages = [];
try {
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.done) { child.stdin.end(); break; }
    messages.push(message);
  }
  assert.deepEqual(messages, ["start", "startHandsFree", "listenHandsFree", "finish", "cancel", "toggleMode", "closeChat", "showHistory"].map((action) => ({ event: "action", action })));
  assert.deepEqual(await exit, [0, null]);
  assert.equal(stderr, "");
  process.stdout.write("all emitted hotkey actions retain their wire meaning\n");
} finally { clearTimeout(timeout); lines.close(); child.kill(); }
