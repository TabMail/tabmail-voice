// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Each app architecture (electron-builder's name) and what builds its helpers. */
const architectures = {
  arm64: { rust: "aarch64-apple-darwin", swift: "arm64-apple-macosx15.0" },
  x64: { rust: "x86_64-apple-darwin", swift: "x86_64-apple-macosx15.0" },
} as const;

/** A package as package-lock.json pins it. */
interface LockedPackage { version: string; resolved: string; integrity: string; os?: string[]; cpu?: string[]; dev?: boolean }

/** Installs the app's own Mac packages for both architectures (the keychain's `@napi-rs/keyring`),
 * as package-lock.json pins them: npm installs only the build machine's, and every Mac app carries
 * both, as the universal app must (each of its halves the same files). Each tarball must match the
 * lockfile's hash. Every build installs them afresh, over whatever is there: an install that failed
 * partway can leave the pinned version's package.json beside an incomplete binary. */
async function installMacPackages(root: string): Promise<void> {
  const locked = (JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, LockedPackage> }).packages;
  for (const [path, entry] of Object.entries(locked)) {
    if (entry.dev || !entry.os?.includes("darwin") || !entry.cpu?.some((cpu) => cpu in architectures)) continue;
    const destination = join(root, path);
    const response = await fetch(entry.resolved);
    if (!response.ok) throw new Error(`${entry.resolved}: HTTP ${response.status}`);
    const tarball = Buffer.from(await response.arrayBuffer());
    const [algorithm = "", expected] = entry.integrity.split("-", 2);
    if (createHash(algorithm).update(tarball).digest("base64") !== expected) throw new Error(`${entry.resolved} does not match package-lock.json's integrity`);
    const scratch = mkdtempSync(join(tmpdir(), "voice-package-"));
    try {
      writeFileSync(join(scratch, "package.tgz"), tarball);
      rmSync(destination, { recursive: true, force: true });
      mkdirSync(destination, { recursive: true });
      execFileSync("tar", ["-xzf", join(scratch, "package.tgz"), "-C", destination, "--strip-components", "1"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    process.stdout.write(`Installed ${path.replace(/^node_modules\//, "")} ${entry.version}\n`);
  }
}

const helpers = ["voice-hotkey", "voice-macos", "voice-microphone", "voice-screen-reader", "voice-field-reader"];

/** Builds the Rust core and the Swift helpers for one architecture; returns the helpers' folder. */
function buildHelpers(root: string, arch: keyof typeof architectures): string {
  const target = architectures[arch];
  // The pinned toolchain (rust-toolchain.toml) installs only the host's standard library; this
  // adds the target's, once (a no-op after).
  execFileSync("rustup", ["target", "add", target.rust], { cwd: join(root, "native/shared/rust"), stdio: "inherit" });
  execFileSync("cargo", ["build", "--release", "--locked", "--target", target.rust], { cwd: join(root, "native/shared/rust"), stdio: "inherit" });
  // The triple names the package's deployment target (macOS 15, as Package.swift): with `--arch`,
  // SwiftPM checks x86_64 against the SDK's own macOS and warns that it is deprecated there.
  // Package.swift links the Rust target it is told: the manifest only knows the host's.
  // Each architecture has its own scratch folder, so neither reuses the other's evaluated manifest.
  const swift = ["build", "-c", "release", "--triple", target.swift, "--scratch-path", join(root, "native/macos/.build", arch), "--package-path", join(root, "native/macos")];
  const env = { ...process.env, VOICE_RUST_TARGET: target.rust };
  execFileSync("swift", swift, { stdio: "inherit", env });
  return execFileSync("swift", [...swift, "--show-bin-path"], { encoding: "utf8", env }).trim();
}

/** Builds the helpers, and installs the packages, for one Mac app: `VOICE_MAC_ARCH` names it
 * (`arm64`, `x64`, or `universal`, both in one, the website's download), or else the build
 * machine's, the app electron-builder builds by default. The thin apps' helpers are thin; the
 * universal app's are both architectures', joined by `lipo`. */
export async function buildNative(root: string): Promise<void> {
  const arch = process.env.VOICE_MAC_ARCH ?? process.arch;
  if (arch !== "arm64" && arch !== "x64" && arch !== "universal") throw new Error(`The Mac app's architecture is ${arch}, not arm64, x64 or universal`);
  await installMacPackages(root);
  const destination = join(root, "dist/helpers");
  mkdirSync(destination, { recursive: true });
  if (arch === "universal") {
    const built = (["arm64", "x64"] as const).map((thin) => buildHelpers(root, thin));
    for (const helper of helpers) execFileSync("lipo", ["-create", ...built.map((binPath) => join(binPath, helper)), "-output", join(destination, helper)], { stdio: "inherit" });
  } else {
    const binPath = buildHelpers(root, arch);
    for (const helper of helpers) copyFileSync(join(binPath, helper), join(destination, helper));
  }
  process.stdout.write(`Copied ${arch} ${helpers.join(", ")} to ${destination}\n`);
}
