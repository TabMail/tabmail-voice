// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Builds the existing Apple silicon Swift helpers. */
export function buildNative(root: string): void {
  execFileSync("cargo", ["build", "--release", "--locked", "--target", "aarch64-apple-darwin"], { cwd: join(root, "native/shared/rust"), stdio: "inherit" });
  const helpers = ["voice-hotkey", "voice-macos", "voice-microphone", "voice-screen-reader"];
  const swift = ["build", "-c", "release", "--arch", "arm64", "--package-path", join(root, "native/macos")];
  execFileSync("swift", swift, { stdio: "inherit" });
  const binPath = execFileSync("swift", [...swift, "--show-bin-path"], { encoding: "utf8" }).trim();
  const destination = join(root, "dist/helpers");
  mkdirSync(destination, { recursive: true });
  for (const helper of helpers) copyFileSync(join(binPath, helper), join(destination, helper));
  process.stdout.write(`Copied ${helpers.join(", ")} to ${destination}\n`);
}
