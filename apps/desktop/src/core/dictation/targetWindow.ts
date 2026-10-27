// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The captured window or field is unavailable, or the OS refused the paste. */
export class PasteTargetError extends Error {
  constructor() {
    super("The target window could not be restored.");
    this.name = "PasteTargetError";
  }
}
