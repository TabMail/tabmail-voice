// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A dedicated silent sink supplies a known waveform to this child only. Neither
// the desktop's default microphone nor its default output device is changed.
const sink = `tabmail_test_${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "tabmail-audio-"));
let moduleID, player, child, lines, timeout;
try {
  moduleID = execFileSync("pactl", ["load-module", "module-null-sink", `sink_name=${sink}`, "rate=16000", "channels=1"], { encoding: "utf8" }).trim();
  assert.match(moduleID, /^\d+$/);
  const tone = Buffer.alloc(16000 * 12 * 4);
  for (let i = 0; i < tone.length / 4; i++) tone.writeFloatLE(0.5 * Math.sin(2 * Math.PI * 440 * i / 16000), i * 4);
  const path = join(dir, "tone.raw");
  writeFileSync(path, tone);
  player = spawn("paplay", ["--raw", "--format=float32le", "--rate=16000", "--channels=1", `--device=${sink}`, path], { stdio: "ignore" });
  child = spawn(process.argv[2], [], { env: { ...process.env, PULSE_SOURCE: `${sink}.monitor` }, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => { diagnostic += chunk; });
  const samples = new Map();
  let observing = false, late = 0, energy = 0, positive = 0, negative = 0;
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "after-old-stop") { observing = true; return; }
    if (message.event === "end-observation") { observing = false; return; }
    assert.equal(message.event, "microphoneChunk");
    assert.ok(message.session === 1 || message.session === 2);
    const bytes = Buffer.from(message.samples, "base64");
    assert.equal(bytes.length % 4, 0);
    for (let i = 0; i < bytes.length; i += 4) {
      const value = bytes.readFloatLE(i);
      assert.ok(Number.isFinite(value));
      energy += value * value;
      if (value > 0.05) positive++;
      if (value < -0.05) negative++;
    }
    samples.set(message.session, (samples.get(message.session) ?? 0) + bytes.length / 4);
    if (observing && message.session === 2) late += bytes.length / 4;
  });
  timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 12_000);
  // `exit` may precede the last stdout read. Inspect capture only after pipes close.
  assert.deepEqual(await once(child, "close"), [0, null]);
  assert.ok(samples.get(1) >= 8_000, "capture survives blocked main thread and stale starts");
  assert.ok(late >= 3_000, "stopping the old session leaves the current microphone capturing");
  assert.ok(energy > 10 && positive > 100 && negative > 100, "known tone reaches PCM output; silence cannot pass");
  assert.equal(diagnostic, "");
  process.stdout.write("native waveform, isolated timing and session ownership passed\n");
} finally {
  clearTimeout(timeout);
  child?.kill();
  player?.kill();
  lines?.close();
  if (moduleID) execFileSync("pactl", ["unload-module", moduleID]);
  rmSync(dir, { recursive: true, force: true });
}
