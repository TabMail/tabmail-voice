## ADR-DESK-058: Linux updates through an apt repository

**Context:** ADR-DESK-050 gave Linux an in-app updater: the app downloads the `.deb`, a packaged
script checks an Ed25519 signature of our own, and `pkexec` installs it as root. It never ran: no key
was ever shipped in `update-keys/`, so the app kept it off, and no release wrote a Linux feed. Owner,
2026-10-11: Linux updates through an apt repository, the way VS Code and Chrome do; two GPG keys, a
primary that signs and an offline backup; nobody reinstalls to get updates. The Linux download stays
off the website until this ships.

**Decision:**
- **The package installs its source and keys** as plain packaged files (fpm mappings, no maintainer
  script): the binary keyring `/etc/apt/keyrings/tabmail-voice-archive-keyring.gpg` holding both
  public keys (`resources/linux/tabmail-voice-archive-keyring.gpg`), and the deb822 source
  `/etc/apt/sources.list.d/tabmail-voice.sources` (`resources/linux/tabmail-voice.sources`):
  `https://cdn.tabmail.ai/releases/voice`, suite `stable`, component `main`, architectures `amd64`
  and `arm64` (so a machine with i386 enabled isn't told about it at each update), `Signed-By` that
  keyring, so the keys vouch for this repository only, never for the system's own sources. Both are
  under `/etc`, so dpkg keeps them as conffiles, with one lifetime: a user's edit or removal
  survives upgrades, `apt remove` keeps both and `apt purge` removes both. (A keyring under
  `/usr/share/keyrings` is removed by `apt remove` while the source stays, and every `apt update`
  after it then warns that the repository's signature can't be checked; found in the Ubuntu VM.)
  An unedited conffile is replaced on upgrade, so a new keyring reaches every machine that didn't
  edit it.
- **The repository** is on the CDN beside the downloads: `dists/stable/InRelease`, `Release`,
  `Release.gpg`, and `main/binary-{amd64,arm64}/Packages` (and `.gz`), the latest version per
  architecture. `Packages` points at the versioned `.deb` in `linux-x64/…` and `linux-arm64/…`; the
  website links a `TabMail-Voice-latest-linux-<arch>.deb` copy of the same bytes there, which the
  release writes after the index (amended 2026-10-12: the site never names a version). The release (`tabmail-release-helpers`) signs it
  with the primary key, refuses to sign with a key the package's own keyring doesn't hold, checks the
  signatures with `gpgv` against that keyring, never replaces a newer version with an older one, and
  writes `InRelease` last.
- **The app has no Linux updater:** no update item in the tray or Settings, no feed (`linux.publish`
  is null, so no `app-update.yml`). *(Amended by ADR-DESK-059, 2026-10-13: the package still has none; the
  AppImage updates itself from a feed of its own, its updates signed with this repository's key;
  `linux.publish` names that feed, so the package now carries electron-builder's `app-update.yml`,
  which it never reads.)* `apt update` offers new versions, and Ubuntu's Software Updater
  shows them as it shows Chrome's.
- **Keys** are created, rotated and replaced by the backup with
  a script of TabMail's private operations repository. The keyring holds the backup from the first release, so a leaked or lost primary is replaced by
  promoting the backup, which installed apps already trust, and a new backup is created and ships in
  the next release. Only a key in the latest release's keyring is promoted.

**Consequences:**
- Installed apps update without the app asking for an administrator; apt and the system's updater do,
  in the way the user already knows. Apt also installs missing dependencies from the system's sources.
- apt refuses a repository whose `InRelease` isn't signed by a key in the keyring, or a package whose
  hash isn't the signed index's.
- An `apt update` that reads the index while a release writes it can see a hash mismatch; the next one
  (minutes later) succeeds.
- A machine that skipped every release since the last replacement trusts neither key and reinstalls
  once.
- Anyone who installed the 0.2.0 `.deb` (linked for a few hours before Linux was taken off the site)
  has no source and reinstalls once; that build never had updates.
- Tested in the Ubuntu VM with a test key and a local repository: the 0.2.1 package installs the
  keyring and source, `apt upgrade` brings a later version, and a tampered `InRelease` is refused.

---

