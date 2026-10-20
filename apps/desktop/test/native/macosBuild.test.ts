// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildNative } from "../../scripts/macos/build-native.mts";
import { buildMemoryHelper } from "../../scripts/memory-helper.mts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

// The memory helper's own build is tested in memoryHelperBuild.test.ts: here it writes a file
// marked with the Rust target it was given.
vi.mock("../../scripts/memory-helper.mts", () => ({ buildMemoryHelper: vi.fn() }));

/** The real `execFileSync` (the mock's first implementation), which runs `tar` for the fixtures. */
const realExecFileSync = vi.mocked(execFileSync).getMockImplementation() ?? execFileSync;
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
    realExecFileSync("tar", ["-czf", path, "-C", source, "package"]);
    const bytes = readFileSync(path);
    return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  }

  /** A checkout whose lockfile pins `packages`, with a fake Rust, Swift, lipo and npm registry: the
   *  registry serves `served` (by URL), SwiftPM's build writes each helper, marked with the triple
   *  and Rust target it was given (and `built`, if given) and a debug map naming its object file under
   *  the home folder, which `strip -S` removes, and lipo writes what it joined. Returns the commands
   *  run, each cargo build's RUSTFLAGS and the URLs fetched. */
  function checkout(packages: Record<string, object>, served: Record<string, Buffer>, built = ""): { root: string; commands: string[][]; cargoFlags: (string | undefined)[]; fetched: string[]; unpacked: { tarball: string; existed: boolean }[] } {
    const root = mkdtempSync(join(tmpdir(), "voice-macos-build-"));
    roots.push(root);
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "": {}, ...packages } }));
    const commands: string[][] = [];
    const cargoFlags: (string | undefined)[] = [];
    const fetched: string[] = [];
    const unpacked: { tarball: string; existed: boolean }[] = [];
    vi.mocked(execFileSync).mockImplementation(((command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (command === "tar") {
        unpacked.push({ tarball: args[1] ?? "", existed: existsSync(args[1] ?? "") });
        return realExecFileSync(command, args);
      }
      commands.push([command, ...args]);
      if (command === "cargo") cargoFlags.push(options?.env?.RUSTFLAGS);
      if (command === "strip" && args[0] === "-S") {
        const path = args[1] ?? "";
        writeFileSync(path, readFileSync(path, "utf8").replace(/ \[debug map [^\]]*\]/g, ""));
        return Buffer.alloc(0);
      }
      if (command === "lipo") {
        const output = args[args.indexOf("-output") + 1] ?? "";
        file(output, `lipo of ${args.slice(1, args.indexOf("-output")).map((input) => readFileSync(input, "utf8")).join(" and ")}`);
        return Buffer.alloc(0);
      }
      if (command !== "swift") return Buffer.alloc(0);
      const bin = join(args[args.indexOf("--scratch-path") + 1] ?? "", "release");
      if (args.includes("--show-bin-path")) return `${bin}\n`;
      for (const helper of helpers) file(join(bin, helper), `${helper} ${args[args.indexOf("--triple") + 1]} ${options?.env?.VOICE_RUST_TARGET}${built} [debug map ${homedir()}/voice/.build/${helper}.o]`);
      return Buffer.alloc(0);
    }) as typeof execFileSync);
    vi.mocked(buildMemoryHelper).mockReset().mockImplementation((_root, target) => {
      const built = join(root, "memory-build", target ?? "host", "fts_helper");
      file(built, `voice-memory ${target}`);
      return built;
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(url);
      const bytes = served[url];
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    }));
    return { root, commands, cargoFlags, fetched, unpacked };
  }

  /** The Rust core's source paths, under the builder's home folder, name its user: they are built
   *  as `~`, and a helper still holding the home folder is never copied out as built. */
  test("builds the Rust core's source paths from the home folder as ~", async () => {
    const flags = process.env.RUSTFLAGS;
    try {
      delete process.env.RUSTFLAGS;
      const { root, cargoFlags } = checkout({}, {});
      process.env.VOICE_MAC_ARCH = "universal";
      await buildNative(root);
      expect(cargoFlags).toEqual([`--remap-path-prefix=${homedir()}=~`, `--remap-path-prefix=${homedir()}=~`]);
    } finally {
      if (flags === undefined) delete process.env.RUSTFLAGS;
      else process.env.RUSTFLAGS = flags;
    }
  });

  test.each(["arm64", "universal"])("a %s app's Swift helpers ship without their debug map, which names the home folder", async (arch) => {
    const { root, commands } = checkout({}, {});
    process.env.VOICE_MAC_ARCH = arch;
    await buildNative(root);
    for (const helper of helpers) {
      expect(commands).toContainEqual(["strip", "-S", join(root, "dist/helpers", helper)]);
      expect(readFileSync(join(root, "dist/helpers", helper), "utf8")).not.toContain(homedir());
    }
    // The build's own copy keeps it.
    expect(readFileSync(join(root, "native/macos/.build/arm64/release/voice-hotkey"), "utf8")).toContain(`[debug map ${homedir()}`);
  });

  test.each(["arm64", "universal"])("a %s helper that still holds the home folder is refused", async (arch) => {
    const { root } = checkout({}, {}, ` built from ${homedir()}/.cargo/registry`);
    process.env.VOICE_MAC_ARCH = arch;
    await expect(buildNative(root)).rejects.toThrow("voice-hotkey still contains this computer's home folder");
  });

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
    expect(readFileSync(join(root, "dist/helpers/voice-memory"), "utf8")).toBe("voice-memory x86_64-apple-darwin");
  });

  test("the universal app's helpers join both architectures' builds", async () => {
    const { root, commands } = checkout({}, {});
    process.env.VOICE_MAC_ARCH = "universal";

    await buildNative(root);

    for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) expect(commands).toContainEqual(["cargo", "build", "--release", "--locked", "--target", target]);
    for (const helper of helpers) {
      expect(readFileSync(join(root, "dist/helpers", helper), "utf8")).toBe(`lipo of ${helper} arm64-apple-macosx15.0 aarch64-apple-darwin and ${helper} x86_64-apple-macosx15.0 x86_64-apple-darwin`);
    }
    expect(readFileSync(join(root, "dist/helpers/voice-memory"), "utf8")).toBe("lipo of voice-memory aarch64-apple-darwin and voice-memory x86_64-apple-darwin");
  });

  /** With no VOICE_MAC_ARCH, electron-builder builds the build machine's app (the Mac targets name
   *  no architecture), so the helpers are that architecture's too: an Intel Mac's plain build is the
   *  Intel app throughout. */
  test.each([["arm64", "arm64-apple-macosx15.0", "aarch64-apple-darwin"], ["x64", "x86_64-apple-macosx15.0", "x86_64-apple-darwin"]])("on a %s Mac, the default build's helpers are for the app electron-builder builds", async (host, triple, rustTarget) => {
    const { root, commands, fetched } = checkout({}, {});
    delete process.env.VOICE_MAC_ARCH;
    const arch = Object.getOwnPropertyDescriptor(process, "arch");
    Object.defineProperty(process, "arch", { value: host, configurable: true });
    try {
      const builder = JSON.parse(readFileSync(join(__dirname, "../../electron-builder.json"), "utf8")) as { mac: object };
      const { computeArchToTargetNamesMap } = (await import("app-builder-lib/out/targets/targetFactory.js")) as { computeArchToTargetNamesMap: (raw: Map<number, string[]>, packager: object, platform: object) => Map<number, string[]> };
      const { Platform } = (await import("app-builder-lib")) as { Platform: { MAC: object } };
      const { Arch } = (await import("builder-util")) as { Arch: Record<number, string> };
      const built = [...computeArchToTargetNamesMap(new Map(), { platformSpecificBuildOptions: builder.mac }, Platform.MAC).keys()].map((key) => Arch[key]);
      expect(built).toEqual([host]);

      await buildNative(root);
    } finally {
      if (arch) Object.defineProperty(process, "arch", arch);
    }

    expect(fetched).toEqual([]);
    expect(commands).toContainEqual(["swift", "build", "-c", "release", "--triple", triple, "--scratch-path", join(root, "native/macos/.build", host), "--package-path", join(root, "native/macos")]);
    for (const helper of helpers) expect(readFileSync(join(root, "dist/helpers", helper), "utf8")).toBe(`${helper} ${triple} ${rustTarget}`);
    expect(readFileSync(join(root, "dist/helpers/voice-memory"), "utf8")).toBe(`voice-memory ${rustTarget}`);
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
    expect(buildMemoryHelper).not.toHaveBeenCalled();
  });

  /** An install that failed partway can leave the pinned version's package.json beside an
   *  incomplete binary: every build installs the package afresh, whatever is there. */
  test("each build installs the pinned package afresh, over an incomplete one at the same version", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "voice-macos-tarball-"));
    roots.push(scratch);
    const x64 = tarball(scratch, "@napi-rs/keyring-darwin-x64", "2.0.0");
    const url = "https://registry.example.com/keyring-darwin-x64-2.0.0.tgz";
    const { root, fetched } = checkout({
      "node_modules/@napi-rs/keyring-darwin-x64": { version: "2.0.0", resolved: url, integrity: x64.integrity, os: ["darwin"], cpu: ["x64"], optional: true },
    }, { [url]: x64.bytes });
    const installed = join(root, "node_modules/@napi-rs/keyring-darwin-x64");
    file(join(installed, "package.json"), JSON.stringify({ name: "@napi-rs/keyring-darwin-x64", version: "2.0.0" }));
    file(join(installed, "binary.node"), "@napi-rs/keyring");
    file(join(installed, "stale.node"), "an older file");
    process.env.VOICE_MAC_ARCH = "x64";

    await buildNative(root);

    expect(fetched).toEqual([url]);
    expect(JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))).toEqual({ name: "@napi-rs/keyring-darwin-x64", version: "2.0.0" });
    expect(readFileSync(join(installed, "binary.node"), "utf8")).toBe("@napi-rs/keyring-darwin-x64 binary");
    expect(existsSync(join(installed, "stale.node"))).toBe(false);
  });

  test("a package the registry refuses stops the build before anything is installed or built", async () => {
    const url = "https://registry.example.com/keyring-darwin-x64-2.0.0.tgz";
    const { root, commands, fetched } = checkout({
      "node_modules/@napi-rs/keyring-darwin-x64": { version: "2.0.0", resolved: url, integrity: "sha512-unused", os: ["darwin"], cpu: ["x64"], optional: true },
    }, {});
    process.env.VOICE_MAC_ARCH = "x64";

    await expect(buildNative(root)).rejects.toThrow(`${url}: HTTP 404`);

    expect(fetched).toEqual([url]);
    expect(existsSync(join(root, "node_modules/@napi-rs/keyring-darwin-x64"))).toBe(false);
    expect(commands).toEqual([]);
    expect(buildMemoryHelper).not.toHaveBeenCalled();
  });

  test("a download's scratch folder is removed, whether its package unpacks or not", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "voice-macos-tarball-"));
    roots.push(scratch);
    const good = tarball(scratch, "@napi-rs/keyring-darwin-x64", "2.0.0");
    const notATarball = Buffer.from("not a tarball");
    const goodURL = "https://registry.example.com/keyring-darwin-x64-2.0.0.tgz";
    const badURL = "https://registry.example.com/keyring-darwin-arm64-2.0.0.tgz";
    process.env.VOICE_MAC_ARCH = "x64";

    const unpacks = checkout({
      "node_modules/@napi-rs/keyring-darwin-x64": { version: "2.0.0", resolved: goodURL, integrity: good.integrity, os: ["darwin"], cpu: ["x64"], optional: true },
    }, { [goodURL]: good.bytes });
    await buildNative(unpacks.root);

    const fails = checkout({
      "node_modules/@napi-rs/keyring-darwin-arm64": { version: "2.0.0", resolved: badURL, integrity: `sha512-${createHash("sha512").update(notATarball).digest("base64")}`, os: ["darwin"], cpu: ["arm64"], optional: true },
    }, { [badURL]: notATarball });
    await expect(buildNative(fails.root)).rejects.toThrow();
    expect(fails.commands).toEqual([]);

    // Each download was in its scratch folder while it unpacked, and the folder is gone after.
    for (const { unpacked } of [unpacks, fails]) {
      expect(unpacked).toHaveLength(1);
      expect(unpacked[0]?.existed).toBe(true);
      expect(existsSync(dirname(unpacked[0]?.tarball ?? ""))).toBe(false);
    }
  });

  test("an architecture other than arm64, x64 or universal is refused", async () => {
    const { root, commands } = checkout({}, {});
    process.env.VOICE_MAC_ARCH = "x86_64";

    await expect(buildNative(root)).rejects.toThrow("The Mac app's architecture is x86_64, not arm64, x64 or universal");
    expect(commands).toEqual([]);
  });
});
