// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildMemoryHelper } from "../../scripts/memory-helper.mts";
import { buildNative, runtimeInstaller } from "../../scripts/windows/build-native.mts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

// The memory helper's own build is tested in memoryHelperBuild.test.ts.
vi.mock("../../scripts/memory-helper.mts", () => ({ buildMemoryHelper: vi.fn() }));

const helpers = ["voice-field-reader.exe", "voice-hotkey.exe", "voice-microphone.exe", "voice-productivity.exe", "voice-screen-reader.exe", "voice-windows.exe"];
const otherArch = process.arch === "arm64" ? "x64" : "arm64";
const cmakeArch = process.arch === "arm64" ? "ARM64" : "x64";

describe("the Windows helper build", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function file(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  /** A source tree for this machine's architecture, built by a Visual Studio whose redistributable
   *  folder holds `redist` (version folder → architecture → its runtime installer). The fake CMake
   *  writes `cache` when it configures, and the helpers, marked with the configured architecture,
   *  only when it builds a configured tree. */
  function built(redist: Record<string, Record<string, string>>, cache?: string): { root: string; build: string } {
    const root = mkdtempSync(join(tmpdir(), "voice-windows-build-"));
    roots.push(root);
    const vc = join(root, "Synthetic Visual Studio/VC");
    const build = join(root, "native/windows/build", process.arch);
    for (const [version, arches] of Object.entries(redist)) {
      for (const [arch, contents] of Object.entries(arches)) file(join(vc, "Redist/MSVC", version, `vc_redist.${arch}.exe`), contents);
    }
    mkdirSync(join(vc, "Redist/MSVC/v145"), { recursive: true });
    let configured: string | undefined;
    vi.mocked(execFileSync).mockImplementation(((command: string, args: readonly string[]) => {
      if (command !== "cmake") throw new Error(`unexpected command ${command}`);
      if (args[0] === "-S") {
        expect(args).toEqual(["-S", join(root, "native/windows"), "-B", build, "-A", expect.any(String), "-DBUILD_TESTING=OFF"]);
        configured = args[5];
        file(join(build, "CMakeCache.txt"), cache ?? `CMAKE_GENERATOR:INTERNAL=Visual Studio\r\nCMAKE_LINKER:FILEPATH=${vc}/Tools/MSVC/14.50.35717/bin/Hostx64/${process.arch}/link.exe\r\nCMAKE_AR:FILEPATH=lib.exe\r\n`);
      } else {
        expect(args).toEqual(["--build", build, "--config", "Release", "--parallel", "2"]);
        if (configured === undefined) throw new Error("built before configuring");
        for (const helper of helpers) file(join(build, "Release", helper), `${helper} for ${configured}`);
      }
      return Buffer.alloc(0);
    }) as typeof execFileSync);
    vi.mocked(buildMemoryHelper).mockReset().mockImplementation((_root, target) => {
      const built = join(root, "memory-build", "fts_helper.exe");
      file(built, `voice-memory for ${target}`);
      return built;
    });
    return { root, build };
  }

  test("ships every helper, and the newest runtime installer of this architecture for the app's installer", () => {
    // Numbered, not lettered: 14.9 is older than 14.50.
    const { root } = built({
      "14.44.35112": { [process.arch]: "14.44 runtime" },
      "14.50.35710": { [process.arch]: "14.50 runtime", [otherArch]: "14.50 runtime of the other architecture" },
      "14.9.99999": { [process.arch]: "14.9 runtime" },
    });
    buildNative(root);
    expect(readdirSync(join(root, "dist/helpers")).sort()).toEqual([...helpers, "voice-memory.exe"].sort());
    expect(readFileSync(join(root, "dist/helpers/voice-memory.exe"), "utf8")).toBe(`voice-memory for ${process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"}`);
    for (const helper of helpers) expect(readFileSync(join(root, "dist/helpers", helper), "utf8")).toBe(`${helper} for ${cmakeArch}`);
    expect(readFileSync(join(root, "dist/runtime/vc_redist.exe"), "utf8")).toBe("14.50 runtime");
    expect(readdirSync(join(root, "dist/runtime"))).toEqual(["vc_redist.exe"]);
  });

  test("fails where the build's newest redistributable has no runtime installer for this architecture", () => {
    // An older version's installer is not taken instead: the newest is the one this build's tools need.
    const { root } = built({ "14.44.35112": { [process.arch]: "14.44 runtime" }, "14.50.35710": { [otherArch]: "14.50 runtime of the other architecture" } });
    expect(() => buildNative(root)).toThrow(`No Visual C++ runtime installer for ${process.arch}`);
    expect(existsSync(join(root, "dist/runtime/vc_redist.exe"))).toBe(false);
    const { root: none, build } = built({});
    expect(() => buildNative(none)).toThrow(`No Visual C++ runtime installer for ${process.arch}`);
    expect(() => runtimeInstaller(build)).toThrow(`No Visual C++ runtime installer for ${process.arch}`);
  });

  test("fails where CMake recorded no Visual Studio linker", () => {
    for (const cache of ["CMAKE_GENERATOR:INTERNAL=Visual Studio\n", "CMAKE_LINKER:FILEPATH=C:/Synthetic Tools/bin/link.exe\n"]) {
      const { root, build } = built({ "14.50.35710": { [process.arch]: "14.50 runtime" } }, cache);
      expect(() => buildNative(root)).toThrow("CMake recorded no Visual Studio linker");
      expect(() => runtimeInstaller(build)).toThrow("CMake recorded no Visual Studio linker");
      expect(existsSync(join(root, "dist/runtime/vc_redist.exe"))).toBe(false);
    }
  });
});
