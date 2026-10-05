// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// `voice-windows.exe --verify-update` (ADR-DESK-050) against real files: Node's own executable,
// signed by its publisher, which every machine that runs this test has; a copy of it with one byte
// changed; the unsigned helper itself; a file that isn't there. The app compares the publisher and
// version; the helper only has to report them truthfully.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = process.argv[2];
const verify = (path) => JSON.parse(execFileSync(helper, ["--verify-update", path], { encoding: "utf8", timeout: 60_000 }));
const temporary = mkdtempSync(join(tmpdir(), "voice-update-signature-"));
try {
  const signed = verify(process.execPath);
  assert.equal(signed.signatureValid, true, "Node's executable is signed");
  assert.ok(signed.commonName.length > 0 && signed.organization.length > 0, "its publisher is named");
  assert.equal(signed.productVersion, `${process.versions.node}.0`, "its signed version is read");

  // Under a folder whose name isn't ASCII, as a user's can be.
  const folder = join(temporary, "Ünïcødé 사용자");
  mkdirSync(folder);
  const copy = join(folder, "installer.exe");
  copyFileSync(process.execPath, copy);
  assert.deepEqual(verify(copy), signed, "a copy anywhere is the same file");

  const tampered = join(temporary, "tampered.exe");
  const bytes = readFileSync(process.execPath);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  writeFileSync(tampered, bytes);
  assert.equal(verify(tampered).signatureValid, false, "one changed byte breaks the signature");

  const unsigned = verify(helper);
  assert.equal(unsigned.signatureValid, false, "the locally built helper is unsigned");
  assert.equal(unsigned.commonName, "");

  const missing = verify(join(temporary, "missing.exe"));
  assert.deepEqual(missing, { signatureValid: false, commonName: "", organization: "", productVersion: "" });

  assert.equal(spawnSync(helper, ["--verify-update"]).status, 1, "a path is required");
  assert.equal(spawnSync(helper, ["--verify-update", "a", "b"]).status, 1, "and only one");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
