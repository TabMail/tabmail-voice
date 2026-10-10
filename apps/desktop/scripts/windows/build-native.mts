// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
  for (const helper of ["voice-hotkey.exe", "voice-windows.exe", "voice-microphone.exe", "voice-screen-reader.exe", "voice-field-reader.exe", "voice-productivity.exe"]) {
    copyFileSync(join(build, "Release", helper), join(destination, helper));
  }
  process.stdout.write(`Copied Windows helpers to ${destination}\n`);
  const runtime = join(root, "dist/runtime");
  mkdirSync(runtime, { recursive: true });
  copyFileSync(redistributableRuntime(build), join(runtime, "vcruntime140.dll"));
  process.stdout.write(`Copied the Visual C++ runtime to ${runtime}\n`);
}

/** The newest Visual C++ runtime this build's Visual Studio redistributes for its architecture.
 * The keyring addon (`@napi-rs/keyring`) imports `vcruntime140.dll`, which Windows does not ship;
 * the app ships it beside the addon (electron-builder.json), where Windows looks for an addon's
 * DLLs. The helpers link the runtime statically. */
export function redistributableRuntime(build: string): string {
  const linker = /^CMAKE_LINKER:FILEPATH=(.+)$/m.exec(readFileSync(join(build, "CMakeCache.txt"), "utf8"))?.[1];
  const tools = linker?.lastIndexOf("/Tools/MSVC/") ?? -1;
  if (!linker || tools < 0) throw new Error("CMake recorded no Visual Studio linker to find the C++ runtime by");
  const redist = join(linker.slice(0, tools), "Redist/MSVC");
  const newest = readdirSync(redist).filter(name => /^\d+(\.\d+)+$/.test(name)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
  const folder = newest === undefined ? undefined : join(redist, newest, process.arch);
  const crt = folder !== undefined && existsSync(folder) ? readdirSync(folder).find(name => /^Microsoft\.VC\d+\.CRT$/.test(name)) : undefined;
  if (folder === undefined || crt === undefined) throw new Error(`No Visual C++ runtime for ${process.arch} in ${redist}`);
  return join(folder, crt, "vcruntime140.dll");
}
