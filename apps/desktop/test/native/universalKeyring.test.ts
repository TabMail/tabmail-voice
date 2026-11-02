// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { universalKeyring } from "../../scripts/macos/universal-keyring.mts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): { root: string; binaries: string[]; slices: Buffer[] } {
  const root = mkdtempSync(join(tmpdir(), "voice-keyring-test-"));
  roots.push(root);
  const source = join(root, "fixture.c");
  writeFileSync(source, "int synthetic_binding(void) { return 7; }\n");
  const binaries = ["arm64", "x64"].map((arch) => join(root, "node_modules/@napi-rs", `keyring-darwin-${arch}`, `keyring.darwin-${arch}.node`));
  for (const [index, arch] of ["arm64", "x86_64"].entries()) {
    const binary = binaries[index] ?? "";
    mkdirSync(dirname(binary), { recursive: true });
    execFileSync("clang", ["-target", `${arch}-apple-macos15.0`, "-c", source, "-o", binary]);
  }
  return { root, binaries, slices: binaries.map(binary => readFileSync(binary)) };
}

test.skipIf(process.platform !== "darwin")("both loader paths have both original Mach-O slices, byte for byte", () => {
  const { root, binaries, slices } = fixture();
  universalKeyring(root);
  expect(readFileSync(binaries[0] ?? "")).toEqual(readFileSync(binaries[1] ?? ""));
  for (const binary of binaries) {
    const arches = execFileSync("lipo", ["-archs", binary], { encoding: "utf8" }).trim().split(/\s+/).sort();
    expect(arches).toEqual(["arm64", "x86_64"]);
    for (const [index, arch] of ["arm64", "x86_64"].entries()) {
      const thin = join(root, `extracted-${arch}.node`);
      execFileSync("lipo", [binary, "-thin", arch, "-output", thin]);
      expect(readFileSync(thin)).toEqual(slices[index]);
    }
  }
});

test.skipIf(process.platform !== "darwin").each([0, 1])("missing binding %i refuses without changing the other", (missing) => {
  const { root, binaries, slices } = fixture();
  rmSync(binaries[missing] ?? "");
  expect(() => universalKeyring(root)).toThrow();
  expect(existsSync(binaries[missing] ?? "")).toBe(false);
  expect(readFileSync(binaries[1 - missing] ?? "")).toEqual(slices[1 - missing]);
});

test.skipIf(process.platform !== "darwin")("invalid Mach-O input refuses without replacing either input", () => {
  const { root, binaries } = fixture();
  writeFileSync(binaries[1] ?? "", "invalid synthetic binary");
  const before = binaries.map(binary => readFileSync(binary));
  expect(() => universalKeyring(root)).toThrow();
  expect(binaries.map(binary => readFileSync(binary))).toEqual(before);
});
