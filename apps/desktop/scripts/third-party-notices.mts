// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Writes `THIRD_PARTY_NOTICES.md` at the repository's root: the licence texts of the native code
// Voice compiles in, which no package carries for it. The npm packages carry their own licences
// inside the app; Electron's and Chromium's ship beside it; the memory helper's are its own
// repository's `THIRD_PARTY_NOTICES.txt`, shipped as it is from the pinned checkout
// (`memory-helper.mts`); `THIRD_PARTY_LICENSES.md` names what Settings > Acknowledgements lists.
// This covers:
// - the Rust crates of the shared core (`native/shared/rust`, its Cargo.lock),
// - @napi-rs/keyring's crates at the version `package.json` names, with libdbus, which its Linux
//   module links statically (its repository keeps no Cargo.lock, so they resolve as of the run),
// - nlohmann/json, compiled into the Windows and Linux helpers,
// - the Rust standard library, compiled into every Rust program.
//
// Run it when one of those inputs, or cargo-about's configuration, changes (a test fails until it
// is): it needs cargo-about (`cargo install cargo-about`) and the network.
// `node scripts/third-party-notices.mts`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What the notices are generated from; the file records it, and a test compares it with the tree. */
export interface NoticeInputs {
  coreLock: string;
  /** cargo-about's configuration (`native/third-party-notices.toml`): which licences, systems and
   * corrected licence files the notices are made with. */
  config: string;
  keyring: string;
  nlohmann: string;
  rust: string;
}

/** One licence text and the components it covers. */
export interface Notice {
  license: string;
  text: string;
  usedBy: string[];
}

/** The crate that is this repository's own code (MPL 2.0), and keyring-node's, whose licence is added
 * from its repository. */
const own = new Set(["tabmail-voice-core", "napi-keyring"]);

/** Licence files of C libraries a crate bundles, which cargo-about does not read. */
const bundled: { crate: string; name: string; license: string; file: string }[] = [
  { crate: "libdbus-sys", name: "libdbus", license: "Academic Free License 2.1 (or GNU GPL 2.0 or later; the AFL is the one taken)", file: "vendor/dbus/COPYING" },
];

/** The inputs as the tree has them now. */
export function noticeInputs(root: string): NoticeInputs {
  const nlohmann = /nlohmann\/json\/releases\/download\/v([0-9.]+)\//.exec(readFileSync(join(root, "native/windows/CMakeLists.txt"), "utf8"))?.[1];
  const rust = /^channel\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, "native/shared/rust/rust-toolchain.toml"), "utf8"))?.[1];
  const keyring = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@napi-rs/keyring"];
  if (nlohmann === undefined || rust === undefined || keyring === undefined) throw new Error("an input of the third-party notices was not found");
  const hash = (file: string) => createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
  return {
    coreLock: hash("native/shared/rust/Cargo.lock"),
    config: hash("native/third-party-notices.toml"),
    keyring,
    nlohmann,
    rust,
  };
}

/** The line that records the inputs in the file, read back by `recordedInputs`. */
export function inputsLine(inputs: NoticeInputs): string {
  return `<!-- inputs: ${JSON.stringify(inputs)} -->`;
}

/** The inputs a notices file was generated from, or null when it records none. */
export function recordedInputs(notices: string): NoticeInputs | null {
  const line = /^<!-- inputs: (\{.*\}) -->$/m.exec(notices)?.[1];
  return line === undefined ? null : (JSON.parse(line) as NoticeInputs);
}

/** The notices file: one section a distinct licence text, its components listed over it. A text is
 * compared and written with Unix line endings: some crates ship their licence files with Windows ones,
 * and the same licence would otherwise be two sections. */
export function render(inputs: NoticeInputs, notices: Notice[]): string {
  const merged = new Map<string, Notice>();
  for (const notice of notices) {
    const text = notice.text.replace(/\r\n?/g, "\n").trim();
    const key = `${notice.license}\n${text}`;
    const known = merged.get(key);
    merged.set(key, { license: notice.license, text, usedBy: [...new Set([...(known?.usedBy ?? []), ...notice.usedBy])].sort() });
  }
  const sections = [...merged.values()].sort((a, b) => a.license.localeCompare(b.license) || (a.usedBy[0] ?? "").localeCompare(b.usedBy[0] ?? ""));
  return [
    "# Third-party notices",
    "",
    "The licence texts of the native code TabMail Voice compiles in: the Rust crates of its shared core,",
    "@napi-rs/keyring's crates (with libdbus on Linux), nlohmann/json and the Rust standard library. The memory",
    "helper's are in `voice-memory-THIRD_PARTY_NOTICES.txt`, its own repository's notices, beside this file in",
    "the app. Generated by `apps/desktop/scripts/third-party-notices.mts`; do not edit by hand.",
    "`THIRD_PARTY_LICENSES.md` lists the projects Settings > Acknowledgements credits.",
    "",
    inputsLine(inputs),
    "",
    ...sections.flatMap(({ license, text, usedBy }) => [`## ${license}`, "", `Used by: ${usedBy.join(", ")}`, "", "````text", text, "````", ""]),
  ].join("\n");
}

interface AboutJson {
  licenses: { name: string; text: string; used_by: { crate: { name: string; version: string; manifest_path: string } }[] }[];
  crates: { package: { name: string; version: string; manifest_path: string } }[];
}

/** cargo-about's licences for the crates a manifest's code links. */
function about(root: string, manifest: string, locked: boolean): Notice[] {
  const json = execFileSync("cargo", ["about", "generate", "--format", "json", "-c", join(root, "native/third-party-notices.toml"), "-m", manifest, ...(locked ? ["--locked"] : [])], { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "inherit"] });
  const parsed = JSON.parse(json) as AboutJson;
  const notices: Notice[] = parsed.licenses.map(({ name, text, used_by }) => ({
    license: name,
    text,
    usedBy: used_by.filter(({ crate }) => !own.has(crate.name)).map(({ crate }) => `${crate.name} ${crate.version}`),
  })).filter(({ usedBy }) => usedBy.length > 0);
  for (const library of bundled) {
    const crate = parsed.crates.find(({ package: { name } }) => name === library.crate);
    if (crate === undefined) continue;
    const file = join(dirname(crate.package.manifest_path), library.file);
    if (!existsSync(file)) throw new Error(`${library.crate} ${crate.package.version} has no ${library.file}`);
    notices.push({ license: library.license, text: readFileSync(file, "utf8"), usedBy: [`${library.name} (bundled in ${library.crate} ${crate.package.version})`] });
  }
  return notices;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.text();
}

async function main(): Promise<void> {
  const root = join(import.meta.dirname, "..");
  const inputs = noticeInputs(root);
  const work = join(root, "native/.build/third-party-notices");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const keyring = join(work, "keyring-node");
  execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", `v${inputs.keyring}`, "https://github.com/Brooooooklyn/keyring-node", keyring], { stdio: "inherit" });
  const notices = [
    ...about(root, join(root, "native/shared/rust/Cargo.toml"), true),
    ...about(root, join(keyring, "Cargo.toml"), false),
    // Its own crate names no licence; the repository's is MIT.
    { license: "MIT License", text: readFileSync(join(keyring, "LICENSE"), "utf8"), usedBy: [`napi-keyring (@napi-rs/keyring) ${inputs.keyring}`] },
    { license: "MIT License", text: await fetchText(`https://raw.githubusercontent.com/nlohmann/json/v${inputs.nlohmann}/LICENSE.MIT`), usedBy: [`nlohmann/json ${inputs.nlohmann}`] },
    { license: "MIT License", text: await fetchText(`https://raw.githubusercontent.com/rust-lang/rust/${inputs.rust}/LICENSE-MIT`), usedBy: [`Rust standard library ${inputs.rust} (MIT OR Apache-2.0)`] },
    { license: "Apache License 2.0", text: await fetchText(`https://raw.githubusercontent.com/rust-lang/rust/${inputs.rust}/LICENSE-APACHE`), usedBy: [`Rust standard library ${inputs.rust} (MIT OR Apache-2.0)`] },
  ];
  writeFileSync(join(root, "../../THIRD_PARTY_NOTICES.md"), render(inputs, notices));
  rmSync(work, { recursive: true, force: true });
}

if (process.argv[1] === import.meta.filename) await main();
