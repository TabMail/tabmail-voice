// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Builds the platform's native helpers and copies them to dist/helpers, which electron-builder
// ships as Resources/helpers. macOS: the SwiftPM package in native/macos, for Apple silicon, as the
// Swift app builds (Xcode 27 deprecates x86_64). Windows and Linux have no helpers yet.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const helpers = ["voice-hotkey", "voice-macos"];

if (process.platform === "darwin") {
  const swift = ["build", "-c", "release", "--arch", "arm64", "--package-path", join(root, "native/macos")];
  execFileSync("swift", swift, { stdio: "inherit" });
  const binPath = execFileSync("swift", [...swift, "--show-bin-path"], { encoding: "utf8" }).trim();
  const destination = join(root, "dist/helpers");
  mkdirSync(destination, { recursive: true });
  for (const helper of helpers) copyFileSync(join(binPath, helper), join(destination, helper));
  process.stdout.write(`Copied ${helpers.join(", ")} to ${destination}\n`);
} else {
  process.stdout.write(`No native helpers for ${process.platform} yet\n`);
}
