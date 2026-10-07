// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { microphoneProtocol } from "../../shared/microphone/protocol.mjs";

// voice-microphone through the shared protocol checks, its input a dedicated silent sink's monitor
// playing a known tone, for this child only. Neither the desktop's default microphone nor its
// default output device is changed.
const sink = `tabmail_test_${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "tabmail-audio-"));
let moduleID, player;
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
  process.stdout.write("native waveform, one capture per process and session ownership passed\n");
} finally {
  player?.kill();
  if (moduleID) execFileSync("pactl", ["unload-module", moduleID]);
  rmSync(dir, { recursive: true, force: true });
}
