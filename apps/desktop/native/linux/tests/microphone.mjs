// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { microphoneFailedStart, microphoneLost, microphoneProtocol } from "../../shared/microphone/protocol.mjs";

// voice-microphone through the shared protocol checks, its input a dedicated silent sink's monitor
// playing a known tone, for this child only. Neither the desktop's default microphone nor its
// default output device is changed. A failed start is a sound server that isn't there; a lost
// capture is the helper's connection to the sound server cut mid-capture, through a relay this test
// owns, to a TCP listener it loads for the test and unloads after.

/** A port free on 127.0.0.1 now. */
async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const sink = `tabmail_test_${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "tabmail-audio-"));
let moduleID, tcpModuleID, player, relay;
const relayed = new Set();
try {
  moduleID = execFileSync("pactl", ["load-module", "module-null-sink", `sink_name=${sink}`, "rate=16000", "channels=1"], { encoding: "utf8" }).trim();
  assert.match(moduleID, /^\d+$/);
  const tone = Buffer.alloc(16000 * 30 * 4);
  for (let i = 0; i < tone.length / 4; i++) tone.writeFloatLE(0.5 * Math.sin(2 * Math.PI * 440 * i / 16000), i * 4);
  const path = join(dir, "tone.raw");
  writeFileSync(path, tone);
  player = spawn("paplay", ["--raw", "--format=float32le", "--rate=16000", "--channels=1", `--device=${sink}`, path], { stdio: "ignore" });
  const samples = await microphoneProtocol(process.argv[2], { env: { ...process.env, PULSE_SOURCE: `${sink}.monitor` }, capture: true });
  let energy = 0, positive = 0, negative = 0;
  for (const value of samples) {
    energy += value * value;
    if (value > 0.05) positive++;
    if (value < -0.05) negative++;
  }
  assert.ok(energy > 10 && positive > 100 && negative > 100, "the known tone reaches the samples; silence cannot pass");

  await microphoneFailedStart(process.argv[2], { env: { ...process.env, PULSE_SERVER: `unix:${join(dir, "no-server")}` } });

  const serverPort = await freePort();
  tcpModuleID = execFileSync("pactl", ["load-module", "module-native-protocol-tcp", `port=${serverPort}`, "listen=127.0.0.1", "auth-anonymous=1"], { encoding: "utf8" }).trim();
  assert.match(tcpModuleID, /^\d+$/);
  relay = createServer((client) => {
    const server = createConnection({ host: "127.0.0.1", port: serverPort });
    for (const socket of [client, server]) { relayed.add(socket); socket.on("error", () => {}); }
    client.pipe(server).pipe(client);
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => relay.once("listening", resolve));
  await microphoneLost(process.argv[2], {
    env: { ...process.env, PULSE_SERVER: `tcp:127.0.0.1:${relay.address().port}`, PULSE_SOURCE: `${sink}.monitor` },
    cut: async () => { relay.close(); for (const socket of relayed) socket.destroy(); },
  });
  process.stdout.write("native waveform, one capture per process, session ownership, failed start and lost capture passed\n");
} finally {
  player?.kill();
  relay?.close();
  for (const socket of relayed) socket.destroy();
  if (tcpModuleID) execFileSync("pactl", ["unload-module", tcpModuleID]);
  if (moduleID) execFileSync("pactl", ["unload-module", moduleID]);
  rmSync(dir, { recursive: true, force: true });
}
