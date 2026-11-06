// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { noticeInputs, recordedInputs, type NoticeInputs } from "../scripts/third-party-notices.mts";

/** `scripts/third-party-notices.mts` run as a release builder runs it, offline: the script is copied as
 * it is into a tree laid out as this repository, with the tree's own inputs, and runs there with stand-ins
 * for cargo-about, git and the network, which record how they were asked. */
const desktop = join(__dirname, "..");

/** The generator's inputs in the tree, written with values of the test's own, so what the file records is
 * checked against them, not against the reading under test. */
interface Fixture { lock: string; config: string; keyring: string; nlohmann: string; rust: string }
const fixture: Fixture = { lock: "# lock fixture\n", config: "# configuration fixture\n", keyring: "9.8.7", nlohmann: "3.2.1", rust: "1.50.0" };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function expected(values: Fixture): NoticeInputs {
  return { coreLock: sha256(values.lock), config: sha256(values.config), keyring: values.keyring, nlohmann: values.nlohmann, rust: values.rust };
}
function writeInputs(values: Fixture): void {
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(repo, "apps/desktop", file)), { recursive: true });
    writeFileSync(join(repo, "apps/desktop", file), text);
  };
  write("package.json", JSON.stringify({ dependencies: { "@napi-rs/keyring": values.keyring } }));
  write("native/windows/CMakeLists.txt", `FetchContent_Declare(json URL https://github.com/nlohmann/json/releases/download/v${values.nlohmann}/json.tar.xz)\n`);
  write("native/shared/rust/rust-toolchain.toml", `[toolchain]\nchannel = "${values.rust}"\n`);
  write("native/shared/rust/Cargo.lock", values.lock);
  write("native/shared/rust/Cargo.toml", "[package]\nname = \"tabmail-voice-core\"\n");
  write("native/third-party-notices.toml", values.config);
}

/** cargo-about's JSON for one manifest, as the stand-in's own source: two licence texts, one used by
 * the repository's own crate too (left out), the bundling crate whose C library's licence the
 * script reads from its source, and a licence file the configuration names for a crate (as the real
 * configuration does for the napi crates), so its text comes from the configuration given. */
const aboutJson = `(sources, manifest, config) => {
  const crate = (name, version) => ({ crate: { name, version, manifest_path: sources + "/" + name + "/Cargo.toml" } });
  const clarified = (name, version) => ({ name: "MIT License", text: "Licence file named by " + config.trim() + " for " + name + "\\n", used_by: [crate(name, version)] });
  return manifest.includes("shared/rust") ? {
    licenses: [
      clarified("gamma", "2.3.4"),
      { name: "MIT License", text: "Copyright (c) Example Core Authors\\n\\nPermission is hereby granted, core body.\\n", used_by: [crate("alpha", "1.2.3"), crate("tabmail-voice-core", "0.1.0")] },
      { name: "Apache License 2.0", text: "Apache body for the core's crates.\\n", used_by: [crate("beta", "4.5.6")] },
      { name: "MIT License", text: "Only our own crate's text.\\n", used_by: [crate("tabmail-voice-core", "0.1.0")] },
    ],
    crates: [{ package: { name: "alpha", version: "1.2.3", manifest_path: sources + "/alpha/Cargo.toml" } }],
  } : {
    licenses: [{ name: "MIT License", text: "Copyright (c) Example Keyring Crate Authors\\n", used_by: [crate("keyring-core", "7.8.9"), crate("napi-keyring", "1.0.0")] }, clarified("napi", "3.4.5")],
    crates: [{ package: { name: "libdbus-sys", version: "0.2.9", manifest_path: sources + "/libdbus-sys/Cargo.toml" } }],
  };
}`;

let work = "";
let repo = "";
let calls = "";

/** Runs the copied script with the stand-ins; `mode` makes one of them fail. */
function generate(mode: "" | "cargo" | "json" | "http" | "fetch" | "bundled" = ""): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, ["--import", pathToFileURL(join(work, "fetch.mjs")).href, join(repo, "apps/desktop/scripts/third-party-notices.mts")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}`, FAKE_MODE: mode, FAKE_CALLS: calls, FAKE_SOURCES: join(work, "sources") },
  });
  return { status: run.status, stderr: run.stderr };
}

/** Each stand-in's calls, in order. */
function recorded(): { tool: string; args: string[] }[] {
  return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as { tool: string; args: string[] }) : [];
}

describe.skipIf(process.platform === "win32")("third-party notices generator", () => {
  beforeEach(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), "voice-notices-")));
    repo = join(work, "repo");
    calls = join(work, "calls.jsonl");
    writeInputs(fixture);
    mkdirSync(join(repo, "apps/desktop/scripts"), { recursive: true });
    copyFileSync(join(desktop, "scripts/third-party-notices.mts"), join(repo, "apps/desktop/scripts/third-party-notices.mts"));
    // The C library's licence, in the bundling crate's source as cargo puts it.
    mkdirSync(join(work, "sources/libdbus-sys/vendor/dbus"), { recursive: true });
    writeFileSync(join(work, "sources/libdbus-sys/vendor/dbus/COPYING"), "Academic Free License body for libdbus.\n");
    mkdirSync(join(work, "bin"));
    const tool = (name: string, body: string) => {
      writeFileSync(join(work, `${name}.mjs`), body);
      writeFileSync(join(work, "bin", name), `#!/bin/sh\nexec "${process.execPath}" "${join(work, `${name}.mjs`)}" "$@"\n`);
      chmodSync(join(work, "bin", name), 0o755);
    };
    const log = `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.FAKE_CALLS, JSON.stringify({ tool: TOOL, args: process.argv.slice(2) }) + "\\n");\n`;
    tool("cargo", `${log.replace("TOOL", '"cargo"')}
const mode = process.env.FAKE_MODE;
if (mode === "cargo") { process.stderr.write("cargo about failed\\n"); process.exit(1); }
if (mode === "json") { process.stdout.write("{ not json"); process.exit(0); }
if (mode === "bundled") (await import("node:fs")).rmSync(process.env.FAKE_SOURCES + "/libdbus-sys/vendor", { recursive: true, force: true });
const manifest = process.argv[process.argv.indexOf("-m") + 1];
// As cargo-about does, with no configuration given it finds none and cannot resolve the licences.
const at = process.argv.indexOf("-c");
if (at < 0) { process.stderr.write("no about.toml found, licences cannot be resolved\\n"); process.exit(1); }
const config = (await import("node:fs")).readFileSync(process.argv[at + 1], "utf8");
process.stdout.write(JSON.stringify((${aboutJson})(process.env.FAKE_SOURCES, manifest, config)));
`);
    tool("git", `${log.replace("TOOL", '"git"')}
const { existsSync, mkdirSync, readdirSync, writeFileSync } = await import("node:fs");
const into = process.argv[process.argv.length - 1];
// As git clone does, a folder already there with anything in it is refused.
if (existsSync(into) && readdirSync(into).length > 0) { process.stderr.write("fatal: destination path already exists and is not an empty directory.\\n"); process.exit(128); }
mkdirSync(into, { recursive: true });
writeFileSync(into + "/LICENSE", "MIT body of keyring-node itself.\\n");
writeFileSync(into + "/Cargo.toml", "[package]\\nname = \\"napi-keyring\\"\\n");
`);
    writeFileSync(join(work, "fetch.mjs"), `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => {
  appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ tool: "fetch", args: [String(url)] }) + "\\n");
  if (process.env.FAKE_MODE === "fetch") throw new TypeError("fetch failed");
  const ok = process.env.FAKE_MODE !== "http";
  return { ok, status: ok ? 200 : 404, text: async () => "Fetched licence body of " + String(url) + "\\n" };
};
`);
  });

  afterEach(() => rmSync(work, { recursive: true, force: true }));

  test("writes every licence text with what it covers, from the tree's inputs", () => {
    const run = generate();
    expect(run.status, run.stderr).toBe(0);
    const notices = readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8");
    const inputs = expected(fixture);
    expect(recordedInputs(notices)).toEqual(inputs);
    // Each licence body whole, under the components it covers; the repository's own crate named nowhere.
    expect(notices).toContain("Used by: alpha 1.2.3\n\n````text\nCopyright (c) Example Core Authors\n\nPermission is hereby granted, core body.\n````");
    expect(notices).toContain("Used by: beta 4.5.6\n\n````text\nApache body for the core's crates.\n````");
    expect(notices).toContain("Used by: keyring-core 7.8.9\n\n````text\nCopyright (c) Example Keyring Crate Authors\n````");
    // Both manifests resolve with the tree's configuration, whose licence files cover gamma and napi.
    expect(notices).toContain(`Used by: gamma 2.3.4\n\n\`\`\`\`text\nLicence file named by ${fixture.config.trim()} for gamma\n\`\`\`\``);
    expect(notices).toContain(`Used by: napi 3.4.5\n\n\`\`\`\`text\nLicence file named by ${fixture.config.trim()} for napi\n\`\`\`\``);
    expect(notices).not.toContain("tabmail-voice-core");
    expect(notices).not.toContain("Only our own crate's text.");
    expect(notices).toContain("Used by: libdbus (bundled in libdbus-sys 0.2.9)\n\n````text\nAcademic Free License body for libdbus.\n````");
    expect(notices).toContain(`Used by: napi-keyring (@napi-rs/keyring) ${inputs.keyring}\n\n\`\`\`\`text\nMIT body of keyring-node itself.\n\`\`\`\``);
    expect(notices).toContain(`Used by: nlohmann/json ${inputs.nlohmann}\n\n\`\`\`\`text\nFetched licence body of https://raw.githubusercontent.com/nlohmann/json/v${inputs.nlohmann}/LICENSE.MIT\n\`\`\`\``);
    expect(notices).toContain(`Used by: Rust standard library ${inputs.rust} (MIT OR Apache-2.0)\n\n\`\`\`\`text\nFetched licence body of https://raw.githubusercontent.com/rust-lang/rust/${inputs.rust}/LICENSE-MIT\n\`\`\`\``);
    expect(notices).toContain(`Used by: Rust standard library ${inputs.rust} (MIT OR Apache-2.0)\n\n\`\`\`\`text\nFetched licence body of https://raw.githubusercontent.com/rust-lang/rust/${inputs.rust}/LICENSE-APACHE\n\`\`\`\``);
    expect(notices).not.toContain(work);
    // keyring at its version's tag; the core's graph locked to its Cargo.lock, keyring's (no lockfile) not.
    const asked = recorded();
    const git = asked.filter(({ tool }) => tool === "git");
    const cargo = asked.filter(({ tool }) => tool === "cargo");
    expect(git).toHaveLength(1);
    expect(cargo).toHaveLength(2);
    const [clone] = git;
    const [core, keyring] = cargo;
    if (!clone || !core || !keyring) return;
    expect(clone.args).toEqual(expect.arrayContaining(["clone", "--branch", `v${inputs.keyring}`, "https://github.com/Brooooooklyn/keyring-node"]));
    const manifest = (args: string[]) => args[args.indexOf("-m") + 1];
    expect(manifest(core.args)).toBe(join(repo, "apps/desktop/native/shared/rust/Cargo.toml"));
    expect(core.args).toContain("--locked");
    expect(manifest(keyring.args)).toBe(join(repo, "apps/desktop/native/.build/third-party-notices/keyring-node/Cargo.toml"));
    expect(keyring.args).not.toContain("--locked");
    for (const { args } of cargo) expect(args.slice(0, 4)).toEqual(["about", "generate", "--format", "json"]);
    expect(asked.filter(({ tool }) => tool === "fetch").map(({ args }) => args[0])).toEqual([
      `https://raw.githubusercontent.com/nlohmann/json/v${inputs.nlohmann}/LICENSE.MIT`,
      `https://raw.githubusercontent.com/rust-lang/rust/${inputs.rust}/LICENSE-MIT`,
      `https://raw.githubusercontent.com/rust-lang/rust/${inputs.rust}/LICENSE-APACHE`,
    ]);
    // The scratch folder goes when it is done.
    expect(existsSync(join(repo, "apps/desktop/native/.build/third-party-notices"))).toBe(false);
  });

  test.each(["cargo", "json", "http", "fetch", "bundled"] as const)("a failed run (%s) fails and leaves the notices there were", (mode) => {
    writeFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "the notices before\n");
    const run = generate(mode);
    expect(run.status).not.toBe(0);
    expect(readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8")).toBe("the notices before\n");
    if (mode === "http") expect(run.stderr).toContain("404");
    if (mode === "bundled") expect(run.stderr).toContain("libdbus-sys 0.2.9 has no vendor/dbus/COPYING");
  });

  /** Each input the file records, changed in the tree: the file made before is then stale for the check
   * `thirdPartyNotices.test.ts` runs on the shipped one, and a new run records the change. */
  test.each([
    ["coreLock", { lock: "# lock fixture, a crate updated\n" }],
    ["config", { config: "# configuration fixture, a licence file added\n" }],
    ["keyring", { keyring: "9.8.8" }],
    ["nlohmann", { nlohmann: "3.2.2" }],
    ["rust", { rust: "1.51.0" }],
  ] as const)("a changed %s makes the notices stale until they are made again", (field, change) => {
    expect(generate().status).toBe(0);
    const before = recordedInputs(readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8"));
    expect(before).toEqual(expected(fixture));
    const changed = { ...fixture, ...change };
    writeInputs(changed);
    expect(noticeInputs(join(repo, "apps/desktop"))).toEqual(expected(changed));
    expect(before).not.toEqual(noticeInputs(join(repo, "apps/desktop")));
    const run = generate();
    expect(run.status, run.stderr).toBe(0);
    const after = recordedInputs(readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8"));
    expect(after).toEqual(expected(changed));
    expect(after?.[field]).not.toBe(before?.[field]);
  });

  test("a run after a failed one starts clean and writes the whole file", () => {
    expect(generate("http").status).not.toBe(0);
    expect(existsSync(join(repo, "apps/desktop/native/.build/third-party-notices/keyring-node/LICENSE"))).toBe(true);
    const run = generate();
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), "utf8")).toContain("Fetched licence body of");
    expect(existsSync(join(repo, "apps/desktop/native/.build/third-party-notices"))).toBe(false);
  });
});
