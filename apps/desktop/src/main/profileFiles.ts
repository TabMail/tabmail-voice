// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileFiles } from "../core/agent/emailClient.js";

/** The real file system, as the main process reads Thunderbird's profiles. */
export const nodeProfileFiles: ProfileFiles = {
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  join,
};
