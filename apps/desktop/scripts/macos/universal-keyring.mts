// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Keep the loader's two package paths, but give each an Apple silicon and Intel slice.
 * An unused Intel-only addon in an Apple silicon app can trigger macOS's Rosetta warning.
 * Call only after both lockfile-verified packages have been freshly installed. */
export function universalKeyring(root: string): void {
  const binaries = ["arm64", "x64"].map((arch) => join(root, "node_modules/@napi-rs", `keyring-darwin-${arch}`, `keyring.darwin-${arch}.node`));
  const scratch = mkdtempSync(join(tmpdir(), "voice-keyring-"));
  try {
    const universal = join(scratch, "keyring.node");
    execFileSync("lipo", ["-create", ...binaries, "-output", universal]);
    const arches = execFileSync("lipo", ["-archs", universal], { encoding: "utf8" }).trim().split(/\s+/).sort();
    if (arches.join(" ") !== "arm64 x86_64") throw new Error("The keyring binary is not universal");
    for (const binary of binaries) copyFileSync(universal, binary);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
