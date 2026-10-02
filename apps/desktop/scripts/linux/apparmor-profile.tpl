# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
abi <abi/4.0>,
include <tunables/global>

profile "${executable}" "/opt/${sanitizedProductName}/${executable}" flags=(enforce) {
  allow all,
  userns,

  # Explicit allow-all preserves normal desktop access while honoring this
  # exec transition. Unconfined/default_allow can ignore it on Ubuntu kernels.
  # Keep Electron's user-namespace allowance. The native accessibility client
  # needs the ordinary desktop label: Snap's AT-SPI rules accept unconfined
  # peers, not children inheriting this named, otherwise unconfined profile.
  # Ux also requests the loader's secure-execution environment cleanup.
  "/opt/${sanitizedProductName}/resources/helpers/voice-linux" Ux,

  include if exists <local/${executable}>
}
