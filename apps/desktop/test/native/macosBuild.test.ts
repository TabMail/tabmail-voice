// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildNative } from "../../scripts/macos/build-native.mts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const helpers = ["voice-field-reader", "voice-hotkey", "voice-macos", "voice-microphone", "voice-screen-reader"];

describe("the macOS helper build", () => {
  const roots: string[] = [];
  const environment = process.env.VOICE_MAC_ARCH;
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (environment === undefined) delete process.env.VOICE_MAC_ARCH;
    else process.env.VOICE_MAC_ARCH = environment;
    vi.unstubAllGlobals();
  });

  function file(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  /** A package's npm tarball (`package/` inside), and its lockfile integrity. */
  function tarball(root: string, name: string, version: string): { bytes: Buffer; integrity: string } {
    const source = join(root, "tarball-source", name);
    file(join(source, "package/package.json"), JSON.stringify({ name, version }));
    file(join(source, "package/binary.node"), `${name} binary`);
    const path = join(source, "package.tgz");
    const actual = vi.mocked(execFileSync).getMockImplementation() ?? execFileSync;
    actual("tar", ["-czf", path, "-C", source, "package"]);
    const bytes = readFileSync(path);
    return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  }

  /** A checkout whose lockfile pins `packages`, with a fake Rust, Swift, lipo and npm registry: the
   *  registry serves `served` (by URL), SwiftPM's build writes each helper, marked with the triple
   *  and Rust target it was given, and lipo writes what it joined. Returns the commands run and the
   *  URLs fetched. */
  function checkout(packages: Record<string, object>, served: Record<string, Buffer>): { root: string; commands: string[][]; fetched: string[] } {
    const root = mkdtempSync(join(tmpdir(), "voice-macos-build-"));
    roots.push(root);
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "": {}, ...packages } }));
    const commands: string[][] = [];
    const fetched: string[] = [];
    const real = vi.mocked(execFileSync).getMockImplementation() ?? execFileSync;
    vi.mocked(execFileSync).mockImplementation(((command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (command === "tar") return real(command, args);
      commands.push([command, ...args]);
      if (command === "lipo") {
        const output = args[args.indexOf("-output") + 1] ?? "";
        file(output, `lipo of ${args.slice(1, args.indexOf("-output")).map((input) => readFileSync(input, "utf8")).join(" and ")}`);
        return Buffer.alloc(0);
      }
      if (command !== "swift") return Buffer.alloc(0);
      const bin = join(args[args.indexOf("--scratch-path") + 1] ?? "", "release");
      if (args.includes("--show-bin-path")) return `${bin}\n`;
      for (const helper of helpers) file(join(bin, helper), `${helper} ${args[args.indexOf("--triple") + 1]} ${options?.env?.VOICE_RUST_TARGET}`);
      return Buffer.alloc(0);
    }) as typeof execFileSync);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(url);
      const bytes = served[url];
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    }));
    return { root, commands, fetched };
  }

  test("the Intel app's build makes x86_64 helpers for macOS 15 and installs both architectures' Mac packages, as the lockfile pins them", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "voice-macos-tarball-"));
    roots.push(scratch);
    const x64 = tarball(join(scratch, "x64"), "@napi-rs/keyring-darwin-x64", "2.0.0");
    const arm64 = tarball(join(scratch, "arm64"), "@napi-rs/keyring-darwin-arm64", "2.0.0");
    const x64URL = "https://registry.example.com/keyring-darwin-x64-2.0.0.tgz";
    const arm64URL = "https://registry.example.com/keyring-darwin-arm64-2.0.0.tgz";
    const { root, commands, fetched } = checkout({
      "node_modules/@napi-rs/keyring-darwin-x64": { version: "2.0.0", resolved: x64URL, integrity: x64.integrity, os: ["darwin"], cpu: ["x64"], optional: true },
      "node_modules/@napi-rs/keyring-darwin-arm64": { version: "2.0.0", resolved: arm64URL, integrity: arm64.integrity, os: ["darwin"], cpu: ["arm64"], optional: true },
      "node_modules/@esbuild/darwin-x64": { version: "1.0.0", resolved: "https://registry.example.com/esbuild.tgz", integrity: "sha512-unused", os: ["darwin"], cpu: ["x64"], dev: true, optional: true },
      "node_modules/@napi-rs/keyring-linux-x64-gnu": { version: "2.0.0", resolved: "https://registry.example.com/linux.tgz", integrity: "sha512-unused", os: ["linux"], cpu: ["x64"], optional: true },
    }, { [x64URL]: x64.bytes, [arm64URL]: arm64.bytes });
    process.env.VOICE_MAC_ARCH = "x64";

    await buildNative(root);

    // The app's own (not dev) Mac packages, for both architectures: every Mac app carries both.
    expect(fetched).toEqual([x64URL, arm64URL]);
    for (const name of ["@napi-rs/keyring-darwin-x64", "@napi-rs/keyring-darwin-arm64"]) {
      expect(JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"))).toEqual({ name, version: "2.0.0" });
      expect(readFileSync(join(root, "node_modules", name, "binary.node"), "utf8")).toBe(`${name} binary`);
    }
    expect(commands.slice(0, 2)).toEqual([
      ["rustup", "target", "add", "x86_64-apple-darwin"],
      ["cargo", "build", "--release", "--locked", "--target", "x86_64-apple-darwin"],
    ]);
    for (const helper of helpers) expect(readFileSync(join(root, "dist/helpers", helper), "utf8")).toBe(`${helper} x86_64-apple-macosx15.0 x86_64-apple-darwin`);
  });

  test("the universal app's helpers join both architectures' builds", async () => {
    const { root, commands } = checkout({}, {});
    process.env.VOICE_MAC_ARCH = "universal";

    await buildNative(root);

    for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) expect(commands).toContainEqual(["cargo", "build", "--release", "--locked", "--target", target]);
    for (const helper of helpers) {
      expect(readFileSync(join(root, "dist/helpers", helper), "utf8")).toBe(`lipo of ${helper} arm64-apple-macosx15.0 aarch64-apple-darwin and ${helper} x86_64-apple-macosx15.0 x86_64-apple-darwin`);
    }
  });

  test("the Apple silicon app is the default, built in its own scratch folder", async () => {
    const { root, commands, fetched } = checkout({}, {});
    delete process.env.VOICE_MAC_ARCH;

    await buildNative(root);

    expect(fetched).toEqual([]);
    expect(commands).toContainEqual(["swift", "build", "-c", "release", "--triple", "arm64-apple-macosx15.0", "--scratch-path", join(root, "native/macos/.build/arm64"), "--package-path", join(root, "native/macos")]);
    for (const helper of helpers) expect(readFileSync(join(root, "dist/helpers", helper), "utf8")).toBe(`${helper} arm64-apple-macosx15.0 aarch64-apple-darwin`);
  });

  test("a package whose tarball does not match the lockfile is refused, and no helper is built", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "voice-macos-tarball-"));
    roots.push(scratch);
    const pinned = tarball(scratch, "@napi-rs/keyring-darwin-x64", "2.0.0");
    const other = tarball(join(scratch, "other"), "@napi-rs/keyring-darwin-x64", "2.0.1");
    const url = "https://registry.example.com/keyring-darwin-x64-2.0.0.tgz";
    const { root, commands } = checkout({
      "node_modules/@napi-rs/keyring-darwin-x64": { version: "2.0.0", resolved: url, integrity: pinned.integrity, os: ["darwin"], cpu: ["x64"], optional: true },
    }, { [url]: other.bytes });
    process.env.VOICE_MAC_ARCH = "x64";

    await expect(buildNative(root)).rejects.toThrow(/does not match package-lock\.json's integrity/);

    expect(existsSync(join(root, "node_modules/@napi-rs/keyring-darwin-x64"))).toBe(false);
    expect(commands).toEqual([]);
  });

  test("a package already installed at the pinned version is not fetched again", async () => {
    const url = "https://registry.example.com/keyring-darwin-x64-2.0.0.tgz";
    const { root, fetched } = checkout({
      "node_modules/@napi-rs/keyring-darwin-x64": { version: "2.0.0", resolved: url, integrity: "sha512-unused", os: ["darwin"], cpu: ["x64"], optional: true },
    }, {});
    file(join(root, "node_modules/@napi-rs/keyring-darwin-x64/package.json"), JSON.stringify({ version: "2.0.0" }));
    process.env.VOICE_MAC_ARCH = "x64";

    await buildNative(root);

    expect(fetched).toEqual([]);
  });

  test("an architecture other than arm64, x64 or universal is refused", async () => {
    const { root, commands } = checkout({}, {});
    process.env.VOICE_MAC_ARCH = "x86_64";

    await expect(buildNative(root)).rejects.toThrow("VOICE_MAC_ARCH is x86_64, not arm64, x64 or universal");
    expect(commands).toEqual([]);
  });
});
