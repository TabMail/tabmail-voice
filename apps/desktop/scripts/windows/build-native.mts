// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Builds for the current Windows guest's architecture with Visual Studio Build Tools. */
export function buildNative(root: string): void {
  if (process.arch !== "arm64" && process.arch !== "x64") throw new Error(`Unsupported Windows architecture: ${process.arch}`);
  const source = join(root, "native/windows");
  const build = join(source, "build", process.arch);
  const architecture = process.arch === "arm64" ? "ARM64" : "x64";
  execFileSync("cmake", ["-S", source, "-B", build, "-G", "Visual Studio 17 2022", "-A", architecture, "-DBUILD_TESTING=OFF"], { stdio: "inherit" });
  execFileSync("cmake", ["--build", build, "--config", "Release", "--parallel", "2"], { stdio: "inherit" });
  const destination = join(root, "dist/helpers");
  mkdirSync(destination, { recursive: true });
  for (const helper of ["voice-hotkey.exe", "voice-windows.exe", "voice-microphone.exe", "voice-screen-reader.exe", "voice-productivity.exe"]) {
    copyFileSync(join(build, "Release", helper), join(destination, helper));
  }
  process.stdout.write(`Copied Windows helpers to ${destination}\n`);
}
