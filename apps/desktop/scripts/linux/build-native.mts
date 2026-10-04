// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Build native Linux helpers using the current machine's ABI and system libraries. */
export function buildNative(root: string): void {
  if (process.arch !== "arm64" && process.arch !== "x64") throw new Error(`Unsupported Linux architecture: ${process.arch}`);
  const source = join(root, "native/linux");
  const build = join(source, "build", process.arch);
  execFileSync("cmake", ["-S", source, "-B", build, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_TESTING=OFF"], { stdio: "inherit" });
  execFileSync("cmake", ["--build", build, "--parallel", "2"], { stdio: "inherit" });
  const destination = join(root, "dist/helpers");
  mkdirSync(destination, { recursive: true });
  for (const helper of ["voice-hotkey", "voice-linux", "voice-files", "voice-productivity"]) copyFileSync(join(build, helper), join(destination, helper));
  process.stdout.write(`Copied Linux helpers to ${destination}\n`);
}
