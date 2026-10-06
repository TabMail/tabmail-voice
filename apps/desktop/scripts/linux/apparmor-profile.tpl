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
  # voice-screen-reader reads the screen through AT-SPI too (ADR-DESK-053).
  "/opt/${sanitizedProductName}/resources/helpers/voice-screen-reader" Ux,
  # An update installs as root through pkexec (ADR-DESK-050): it and the package manager under it
  # leave this profile, which would otherwise refuse dpkg's links to the files it replaces.
  /usr/bin/pkexec Ux,

  include if exists <local/${executable}>
}
