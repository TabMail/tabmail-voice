// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The memory helper, `voice-memory` (ADR-DESK-061): Thunderbird's search helper, built from its own
// repository at the revision `native/memory/native-fts.json` pins, with that repository's
// Cargo.lock. This app keeps no copy of its source; moving to a newer helper is a change of that
// revision, and every change to the helper is made and reviewed in its repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the helper's source comes from, and at which commit. */
export interface MemoryHelperPin { repository: string; revision: string }

/** The pin, refused unless it names one full commit. */
export function memoryHelperPin(root: string): MemoryHelperPin {
  const pin = JSON.parse(readFileSync(join(root, "native/memory/native-fts.json"), "utf8")) as Partial<MemoryHelperPin>;
  if (typeof pin.repository !== "string" || pin.repository === "") throw new Error("native/memory/native-fts.json names no repository");
  if (typeof pin.revision !== "string" || !/^[0-9a-f]{40}$/.test(pin.revision)) throw new Error("native/memory/native-fts.json's revision is not a full commit hash");
  return { repository: pin.repository, revision: pin.revision };
}

/** The Rust toolchain the app's own Rust core pins: the helper builds with the same one. */
function toolchain(root: string): string {
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, "native/shared/rust/rust-toolchain.toml"), "utf8"))?.[1];
  if (channel === undefined) throw new Error("native/shared/rust/rust-toolchain.toml pins no channel");
  return channel;
}

/** The helper's source at the pinned commit, fetched into a folder of its own and checked out there
 * clean, every build: nothing left from another commit or an earlier build is built. */
function source(root: string, pin: MemoryHelperPin): string {
  const checkout = join(root, "native/memory/.build/source");
  const git = (...args: string[]) => execFileSync("git", ["-C", checkout, "-c", "advice.detachedHead=false", ...args], { encoding: "utf8" }).trim();
  mkdirSync(checkout, { recursive: true });
  if (!existsSync(join(checkout, ".git"))) git("init", "--quiet");
  git("fetch", "--quiet", "--depth", "1", pin.repository, pin.revision);
  git("checkout", "--quiet", "--force", "--detach", pin.revision);
  git("clean", "--quiet", "-fdx");
  if (git("rev-parse", "HEAD") !== pin.revision) throw new Error(`The memory helper's checkout is not at ${pin.revision}`);
  return checkout;
}

/** Builds the helper for one Rust target and returns the built executable's path. The target is
 * always named, as the app's Rust core does: the toolchain's own host can differ from the
 * architecture being packaged (an x64 rustup on an arm64 Windows builder). */
export function buildMemoryHelper(root: string, target: string): string {
  const pin = memoryHelperPin(root);
  const checkout = source(root, pin);
  const channel = toolchain(root);
  const env = { ...process.env, RUSTUP_TOOLCHAIN: channel, CARGO_TARGET_DIR: join(root, "native/memory/.build/target") };
  execFileSync("rustup", ["target", "add", "--toolchain", channel, target], { stdio: "inherit", env });
  execFileSync("cargo", ["build", "--release", "--locked", "--bin", "fts_helper", "--target", target], { cwd: checkout, stdio: "inherit", env });
  return join(env.CARGO_TARGET_DIR, target, "release", target.includes("-windows-") ? "fts_helper.exe" : "fts_helper");
}
