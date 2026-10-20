// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// A Rust build keeps the source paths of what it compiles in the binary, and on a builder's own
// computer they start at its home folder, which names its user. The app's Rust builds take them
// from `~` instead, and a built helper that still holds the home folder ships nowhere.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/** What separates the flags in `CARGO_ENCODED_RUSTFLAGS`. */
const cargoFlagSeparator = "\x1f";

/** `CARGO_ENCODED_RUSTFLAGS` that build every source path under the home folder as `~`, after any
 * flags `env` already sets, as Cargo reads them: its `CARGO_ENCODED_RUSTFLAGS` when set (set empty,
 * no flags, and `RUSTFLAGS` unread), else its `RUSTFLAGS` split on whitespace. Cargo splits
 * `RUSTFLAGS` on whitespace, so a home folder with a space in it would break the remap in two; each
 * encoded flag reaches rustc whole, and Cargo reads them first. */
export function encodedRustFlagsWithoutHome(env: NodeJS.ProcessEnv = process.env): string {
  const encoded = env.CARGO_ENCODED_RUSTFLAGS;
  const inherited = encoded === undefined ? (env.RUSTFLAGS ?? "").split(/\s+/).filter((flag) => flag !== "") : encoded === "" ? [] : encoded.split(cargoFlagSeparator);
  return [...inherited, `--remap-path-prefix=${homedir()}=~`].join(cargoFlagSeparator);
}

/** Refuses the built file at `path`, named `name` in the error, if it holds this computer's home
 * folder. */
export function refuseHomeFolder(path: string, name: string): void {
  if (readFileSync(path).includes(homedir())) throw new Error(`${name} still contains this computer's home folder`);
}
