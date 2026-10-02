// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Shared dispatch only: platform build commands live in named platform folders.
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
switch (process.platform) {
  case "darwin":
    (await import("./macos/build-native.mts")).buildNative(root);
    break;
  case "win32":
    (await import("./windows/build-native.mts")).buildNative(root);
    break;
  default:
    throw new Error(`Native helpers are not implemented for ${process.platform} yet`);
}
