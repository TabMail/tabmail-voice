// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Builds for the current Windows guest's architecture with Visual Studio Build Tools, the newest
 * installed: CMake's default generator (the arm64 runner has Visual Studio 2026, not 2022). */
export function buildNative(root: string): void {
  if (process.arch !== "arm64" && process.arch !== "x64") throw new Error(`Unsupported Windows architecture: ${process.arch}`);
  const source = join(root, "native/windows");
  const build = join(source, "build", process.arch);
  const architecture = process.arch === "arm64" ? "ARM64" : "x64";
  execFileSync("cmake", ["-S", source, "-B", build, "-A", architecture, "-DBUILD_TESTING=OFF"], { stdio: "inherit" });
  execFileSync("cmake", ["--build", build, "--config", "Release", "--parallel", "2"], { stdio: "inherit" });
  const destination = join(root, "dist/helpers");
  mkdirSync(destination, { recursive: true });
  // The linker CMake found dumps each helper's imports (`link /dump` is dumpbin).
  const linker = /^CMAKE_LINKER:FILEPATH=(.+)$/m.exec(readFileSync(join(build, "CMakeCache.txt"), "utf8"))?.[1];
  if (!linker) throw new Error("CMake recorded no linker to check the helpers' imports with");
  for (const helper of ["voice-hotkey.exe", "voice-windows.exe", "voice-microphone.exe", "voice-screen-reader.exe", "voice-field-reader.exe", "voice-productivity.exe"]) {
    const imports = runtimeImports(execFileSync(linker, ["/dump", "/dependents", join(build, "Release", helper)], { encoding: "utf8" }));
    if (imports.length > 0) throw new Error(`${helper} imports ${imports.join(", ")}, which Windows does not ship`);
    copyFileSync(join(build, "Release", helper), join(destination, helper));
  }
  process.stdout.write(`Copied Windows helpers to ${destination}\n`);
}

/** The Visual C++ runtime DLLs a helper imports, from `link /dump /dependents`: Windows does not
 * ship them and neither does the installer, so a helper that imports one does not start without
 * them (the helpers link the runtime statically). */
export function runtimeImports(dependents: string): string[] {
  return [...dependents.matchAll(/^\s*((?:msvcp|vcruntime|concrt)\d[\w.]*\.dll)\s*$/gim)].map(match => match[1]!);
}
