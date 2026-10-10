// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildNative, runtimeImports } from "../../scripts/windows/build-native.mts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

const helpers = ["voice-field-reader.exe", "voice-hotkey.exe", "voice-microphone.exe", "voice-productivity.exe", "voice-screen-reader.exe", "voice-windows.exe"];
const linker = "C:/Synthetic Build Tools/bin/link.exe";

/** What `link /dump /dependents` prints for a helper importing these DLLs. */
function dependents(dlls: string[]): string {
  return ["Microsoft (R) COFF/PE Dumper", "", "Dump of file helper.exe", "", "File Type: EXECUTABLE IMAGE", "",
    "  Image has the following dependencies:", "", ...dlls.map(dll => `    ${dll}`), "", "  Summary"].join("\r\n");
}
const statically = ["KERNEL32.dll", "USER32.dll", "ole32.dll", "OLEAUT32.dll"];

describe("which Visual C++ runtime DLLs a helper imports", () => {
  test("a helper that links the runtime statically imports none", () => {
    expect(runtimeImports(dependents(statically))).toEqual([]);
  });

  test("every runtime DLL a dynamically linked helper imports is named", () => {
    expect(runtimeImports(dependents([...statically, "MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "concrt140.dll"])))
      .toEqual(["MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "concrt140.dll"]);
  });
});

describe("the Windows helper build", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  /** A built tree for this machine's architecture, and helpers that import what `imports` says. */
  function built(cache: string, imports: (helper: string) => string[]): string {
    const root = mkdtempSync(join(tmpdir(), "voice-windows-build-"));
    roots.push(root);
    const build = join(root, "native/windows/build", process.arch);
    mkdirSync(join(build, "Release"), { recursive: true });
    writeFileSync(join(build, "CMakeCache.txt"), cache);
    for (const helper of helpers) writeFileSync(join(build, "Release", helper), helper);
    vi.mocked(execFileSync).mockImplementation(((file: string, args: readonly string[]) => {
      if (file === "cmake") return Buffer.alloc(0);
      if (file === linker && args[0] === "/dump" && args[1] === "/dependents") return dependents(imports(basename(args[2]!)));
      throw new Error(`unexpected command ${file}`);
    }) as typeof execFileSync);
    return root;
  }
  const shipped = (root: string) => (existsSync(join(root, "dist/helpers")) ? readdirSync(join(root, "dist/helpers")).sort() : []);
  const cache = `CMAKE_GENERATOR:INTERNAL=Visual Studio\r\nCMAKE_LINKER:FILEPATH=${linker}\r\nCMAKE_AR:FILEPATH=lib.exe\r\n`;

  test("ships every helper once none imports the runtime", () => {
    const root = built(cache, () => statically);
    buildNative(root);
    expect(shipped(root)).toEqual(helpers);
    const checked = vi.mocked(execFileSync).mock.calls.filter(([file]) => file === linker).map(([, args]) => basename(args![2]!)).sort();
    expect(checked).toEqual(helpers);
  });

  test("ships no helper that imports the runtime, and fails", () => {
    const root = built(cache, helper => (helper === "voice-microphone.exe" ? [...statically, "VCRUNTIME140.dll"] : statically));
    expect(() => buildNative(root)).toThrow("voice-microphone.exe imports VCRUNTIME140.dll, which Windows does not ship");
    expect(shipped(root)).not.toContain("voice-microphone.exe");
  });

  test("fails, shipping nothing, where CMake recorded no linker to check with", () => {
    const root = built("CMAKE_GENERATOR:INTERNAL=Visual Studio\n", () => statically);
    expect(() => buildNative(root)).toThrow("CMake recorded no linker");
    expect(shipped(root)).toEqual([]);
  });
});
