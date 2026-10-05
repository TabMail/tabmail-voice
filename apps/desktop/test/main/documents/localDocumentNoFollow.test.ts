// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

/** Resolving a path is one check; opening it is another. Here resolution is made to miss a
 * symlink, so only the open itself stands between the read and the link's target. */
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  realpath: vi.fn((path: string) => Promise.resolve(path)),
}));
import { LocalDocument } from "../../../src/main/documents/localDocument.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.skipIf(process.platform === "win32")("the open never follows a symlink, even one resolution missed", async () => {
  const home = await mkdtemp(join(tmpdir(), "voice-document-nofollow-")); roots.push(home);
  await writeFile(join(home, "target.pdf"), "%PDF-synthetic");
  await symlink(join(home, "target.pdf"), join(home, "link.pdf"));
  const signal = new AbortController().signal;
  const document = await LocalDocument.prepare(join(home, "link.pdf"), home, signal);
  await expect(document.read(signal)).rejects.toThrow("Only unchanged regular local files");
});
