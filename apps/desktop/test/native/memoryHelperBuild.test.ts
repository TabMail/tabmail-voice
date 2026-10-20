// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildMemoryHelper, memoryHelperPin } from "../../scripts/memory-helper.mts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

const app = join(__dirname, "../..");
const revision = "0123456789abcdef0123456789abcdef01234567";
const repository = "https://example.com/native-fts.git";

/** The memory helper (ADR-DESK-061) is Thunderbird's search helper built from its own repository at
 * one pinned commit, with that repository's lockfile: this app keeps none of its source. */
describe("the memory helper build", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function file(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  /** An app checkout pinning `pin`, with fake git, rustup and cargo: git reports `head` as the
   *  checkout's commit, and cargo writes a helper holding `built`. Returns each command run, with
   *  its folder and environment. */
  function checkoutPinning(pin: object, head = revision, built = "fts_helper built from ~/.cargo/registry"): { root: string; runs: { command: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] } {
    const root = mkdtempSync(join(tmpdir(), "voice-memory-build-"));
    roots.push(root);
    file(join(root, "native/memory/native-fts.json"), JSON.stringify(pin));
    file(join(root, "native/shared/rust/rust-toolchain.toml"), '[toolchain]\nchannel = "1.97.1"\nprofile = "minimal"\n');
    const runs: { command: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];
    vi.mocked(execFileSync).mockImplementation(((command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      runs.push({ command: [command, ...args], cwd: options?.cwd, env: options?.env });
      if (command === "git" && args.includes("init")) mkdirSync(join(args[1] ?? "", ".git"), { recursive: true });
      if (command === "git" && args.includes("rev-parse")) return `${head}\n`;
      if (command === "cargo") {
        const target = args[args.indexOf("--target") + 1] ?? "";
        file(join(options?.env?.CARGO_TARGET_DIR ?? "", target, "release", target.includes("-windows-") ? "fts_helper.exe" : "fts_helper"), built);
      }
      return "";
    }) as typeof execFileSync);
    return { root, runs };
  }

  const gitIn = (checkout: string, ...args: string[]) => ["git", "-C", checkout, "-c", "advice.detachedHead=false", ...args];

  test("builds the pinned commit, fetched clean, with the app's Rust toolchain and the helper's own lockfile", () => {
    const { root, runs } = checkoutPinning({ repository, revision });
    const checkout = join(root, "native/memory/.build/source");
    const target = join(root, "native/memory/.build/target");

    expect(buildMemoryHelper(root, "x86_64-apple-darwin")).toBe(join(target, "x86_64-apple-darwin", "release", "fts_helper"));

    expect(runs.map(({ command }) => command)).toEqual([
      gitIn(checkout, "init", "--quiet"),
      gitIn(checkout, "fetch", "--quiet", "--depth", "1", repository, revision),
      gitIn(checkout, "checkout", "--quiet", "--force", "--detach", revision),
      gitIn(checkout, "clean", "--quiet", "-fdx"),
      gitIn(checkout, "rev-parse", "HEAD"),
      ["rustup", "target", "add", "--toolchain", "1.97.1", "x86_64-apple-darwin"],
      ["cargo", "build", "--release", "--locked", "--bin", "fts_helper", "--target", "x86_64-apple-darwin"],
    ]);
    const cargo = runs.at(-1);
    expect(cargo?.cwd).toBe(checkout);
    expect(cargo?.env).toMatchObject({ RUSTUP_TOOLCHAIN: "1.97.1", CARGO_TARGET_DIR: target });
  });

  test("builds a Windows target's .exe, and fetches the pinned commit again over an earlier checkout", () => {
    const { root, runs } = checkoutPinning({ repository, revision });
    const checkout = join(root, "native/memory/.build/source");
    mkdirSync(join(checkout, ".git"), { recursive: true });

    expect(buildMemoryHelper(root, "aarch64-pc-windows-msvc")).toBe(join(root, "native/memory/.build/target", "aarch64-pc-windows-msvc", "release", "fts_helper.exe"));

    const commands = runs.map(({ command }) => command);
    expect(commands).not.toContainEqual(gitIn(checkout, "init", "--quiet"));
    expect(commands).toContainEqual(gitIn(checkout, "fetch", "--quiet", "--depth", "1", repository, revision));
    expect(commands.slice(-2)).toEqual([
      ["rustup", "target", "add", "--toolchain", "1.97.1", "aarch64-pc-windows-msvc"],
      ["cargo", "build", "--release", "--locked", "--bin", "fts_helper", "--target", "aarch64-pc-windows-msvc"],
    ]);
  });

  /** A built helper holds its dependencies' source paths, under the builder's home folder, which
   *  names its user: they are built as `~`, and a helper still holding the home folder ships nowhere.
   *  The remap reaches rustc as one flag even when the home folder has a space in it (Cargo splits
   *  `RUSTFLAGS` on whitespace, so the flags go as `CARGO_ENCODED_RUSTFLAGS`), after any flags set. */
  test.each<[string, NodeJS.ProcessEnv, string[]]>([
    ["no flags", {}, []],
    ["RUSTFLAGS", { RUSTFLAGS: "-C  target-cpu=native" }, ["-C", "target-cpu=native"]],
    ["CARGO_ENCODED_RUSTFLAGS", { CARGO_ENCODED_RUSTFLAGS: "-C\x1ftarget-cpu=native", RUSTFLAGS: "--ignored" }, ["-C", "target-cpu=native"]],
  ])("builds the source paths from a home folder with a space in it as ~, keeping %s already set", (_name, set, inherited) => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, RUSTFLAGS: process.env.RUSTFLAGS, CARGO_ENCODED_RUSTFLAGS: process.env.CARGO_ENCODED_RUSTFLAGS };
    const home = join(tmpdir(), "First Last");
    try {
      delete process.env.RUSTFLAGS;
      delete process.env.CARGO_ENCODED_RUSTFLAGS;
      Object.assign(process.env, { HOME: home, USERPROFILE: home }, set);
      const { root, runs } = checkoutPinning({ repository, revision });
      buildMemoryHelper(root, "x86_64-unknown-linux-gnu");
      expect(runs.at(-1)?.env?.CARGO_ENCODED_RUSTFLAGS?.split("\x1f")).toEqual([...inherited, `--remap-path-prefix=${home}=~`]);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("a helper that still holds the home folder is refused", () => {
    const { root } = checkoutPinning({ repository, revision }, revision, `fts_helper built from ${homedir()}/.cargo/registry`);
    expect(() => buildMemoryHelper(root, "aarch64-apple-darwin")).toThrow("The memory helper built for aarch64-apple-darwin still contains this computer's home folder");
  });

  test("a checkout that is not at the pinned commit is never built", () => {
    const { root, runs } = checkoutPinning({ repository, revision }, "fedcba9876543210fedcba9876543210fedcba98");
    expect(() => buildMemoryHelper(root, "x86_64-unknown-linux-gnu")).toThrow(`The memory helper's checkout is not at ${revision}`);
    expect(runs.filter(({ command }) => command[0] === "cargo")).toEqual([]);
  });

  test.each<[string, object, string]>([
    ["a short hash", { repository, revision: revision.slice(0, 12) }, "is not a full commit hash"],
    ["a branch", { repository, revision: "main" }, "is not a full commit hash"],
    ["an upper-case hash", { repository, revision: revision.toUpperCase() }, "is not a full commit hash"],
    ["no repository", { revision }, "names no repository"],
  ])("a pin naming %s is refused before anything is fetched", (_name, pin, message) => {
    const { root, runs } = checkoutPinning(pin);
    expect(() => buildMemoryHelper(root, "x86_64-unknown-linux-gnu")).toThrow(message);
    expect(runs).toEqual([]);
  });

  test("the app pins one commit of TabMail's native-fts repository, and keeps none of its source", () => {
    expect(memoryHelperPin(app)).toEqual({ repository: "https://github.com/TabMail/tabmail-native-fts.git", revision: expect.stringMatching(/^[0-9a-f]{40}$/) });
    // The build's own folder (`.build`, ignored by git) holds the fetched checkout.
    expect(readdirSync(join(app, "native/memory")).filter((name) => name !== ".build")).toEqual(["native-fts.json"]);
  });

  test("every platform's build ships it as voice-memory", () => {
    for (const [platform, name] of [["macos", '"voice-memory"'], ["linux", '"voice-memory"'], ["windows", '"voice-memory.exe"']]) {
      const build = readFileSync(join(app, "scripts", platform ?? "", "build-native.mts"), "utf8");
      expect(build, platform).toContain("buildMemoryHelper(root, ");
      expect(build, platform).toContain(name);
    }
  });
});
