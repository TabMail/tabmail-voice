// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildNative, redistributableRuntime } from "../../scripts/windows/build-native.mts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

const helpers = ["voice-field-reader.exe", "voice-hotkey.exe", "voice-microphone.exe", "voice-productivity.exe", "voice-screen-reader.exe", "voice-windows.exe"];
const otherArch = process.arch === "arm64" ? "x64" : "arm64";

describe("the Windows helper build", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function file(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  /** A built tree for this machine's architecture, by a Visual Studio whose redistributable folder
   *  holds `redist` (version folder → architecture → its runtime). */
  function built(redist: Record<string, Record<string, string>>, cache?: string): { root: string; build: string } {
    const root = mkdtempSync(join(tmpdir(), "voice-windows-build-"));
    roots.push(root);
    const vc = join(root, "Synthetic Visual Studio/VC");
    const build = join(root, "native/windows/build", process.arch);
    file(join(build, "CMakeCache.txt"), cache ?? `CMAKE_GENERATOR:INTERNAL=Visual Studio\r\nCMAKE_LINKER:FILEPATH=${vc}/Tools/MSVC/14.50.35717/bin/Hostx64/${process.arch}/link.exe\r\nCMAKE_AR:FILEPATH=lib.exe\r\n`);
    for (const helper of helpers) file(join(build, "Release", helper), helper);
    for (const [version, arches] of Object.entries(redist)) {
      for (const [arch, contents] of Object.entries(arches)) file(join(vc, "Redist/MSVC", version, arch, "Microsoft.VC145.CRT/vcruntime140.dll"), contents);
    }
    mkdirSync(join(vc, "Redist/MSVC/v145"), { recursive: true });
    vi.mocked(execFileSync).mockImplementation(((command: string) => {
      if (command === "cmake") return Buffer.alloc(0);
      throw new Error(`unexpected command ${command}`);
    }) as typeof execFileSync);
    return { root, build };
  }

  test("ships every helper, and the newest runtime of this architecture for the keyring addon", () => {
    // Numbered, not lettered: 14.9 is older than 14.50.
    const { root } = built({
      "14.44.35112": { [process.arch]: "14.44 runtime" },
      "14.50.35710": { [process.arch]: "14.50 runtime", [otherArch]: "14.50 runtime of the other architecture" },
      "14.9.99999": { [process.arch]: "14.9 runtime" },
    });
    buildNative(root);
    expect(readdirSync(join(root, "dist/helpers")).sort()).toEqual(helpers);
    expect(readFileSync(join(root, "dist/runtime/vcruntime140.dll"), "utf8")).toBe("14.50 runtime");
  });

  test("fails where the build's Visual Studio redistributes no runtime for this architecture", () => {
    const { root } = built({ "14.50.35710": { [otherArch]: "14.50 runtime of the other architecture" } });
    expect(() => buildNative(root)).toThrow(`No Visual C++ runtime for ${process.arch}`);
    expect(existsSync(join(root, "dist/runtime/vcruntime140.dll"))).toBe(false);
    const { build } = built({});
    expect(() => redistributableRuntime(build)).toThrow(`No Visual C++ runtime for ${process.arch}`);
  });

  test("fails where CMake recorded no Visual Studio linker", () => {
    for (const cache of ["CMAKE_GENERATOR:INTERNAL=Visual Studio\n", "CMAKE_LINKER:FILEPATH=C:/Synthetic Tools/bin/link.exe\n"]) {
      const { root, build } = built({ "14.50.35710": { [process.arch]: "14.50 runtime" } }, cache);
      expect(() => redistributableRuntime(build)).toThrow("CMake recorded no Visual Studio linker");
      expect(() => buildNative(root)).toThrow("CMake recorded no Visual Studio linker");
      expect(existsSync(join(root, "dist/runtime/vcruntime140.dll"))).toBe(false);
    }
  });
});
