// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { microphoneFailedStart, microphoneLost, microphoneProtocol } from "../../shared/microphone/protocol.mjs";

// voice-microphone.exe with a real capture: the shared protocol checks with `capture` (one capture
// per process, a newer start ending it), then its own ends that no stop asks for: a start that
// fails, and a capture lost mid-session. Windows Audio (`audiosrv`) is stopped to take the input
// away: before a start, which then fails, and during a capture, which is then lost. Stopping a
// service needs an elevated terminal on a machine with a capture endpoint, so this is not a CTest
// test; run it in the test VM, never on a machine someone is using:
// `node microphone-loss.mjs <voice-microphone.exe>`. Windows Audio is started again however the run
// ends.
const executable = process.argv[2];
assert.ok(executable, "pass the voice-microphone executable");
const audio = (verb) => execFileSync("powershell.exe", ["-NoProfile", "-Command", `${verb}-Service audiosrv${verb === "Stop" ? " -Force" : ""}`], { stdio: "ignore" });
try {
  execFileSync("net.exe", ["session"], { stdio: "ignore" });
} catch {
  throw new Error("run from an elevated terminal: the test stops and starts Windows Audio");
}
try {
  const samples = await microphoneProtocol(executable, { capture: true });
  assert.ok(samples.length > 0, "a running capture is heard");
  audio("Stop");
  await microphoneFailedStart(executable);
  audio("Start");
  await microphoneLost(executable, { cut: async () => audio("Stop") });
  process.stdout.write("voice-microphone capture, failed start and lost capture passed\n");
} finally {
  audio("Start");
}
